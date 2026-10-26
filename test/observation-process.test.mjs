import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { validateObservation } from '../lib/knowledge/observations.mjs';
import { appendObservation, loadObservationJournal } from '../lib/knowledge/observation-ledger.mjs';
import { sha, withLock, inspectLock } from '../lib/transport.mjs';

const source = { id: 'source', text: 'Observed pattern', hash: sha('Observed pattern'), root: 'origin', workspace: 'demo', topic: 'demo/a' };
const candidate = validateObservation({ claim: 'Tentative explanation', kind: 'explanation', support: [{ id: source.id, quote: source.text }] }, [source], source);
const payload = (key) => ({ workspace: 'demo', topic: 'demo/a', key, operation: 'propose', observation: candidate });
const url = (name) => new URL(`../lib/${name}`, import.meta.url).href;
function script(root, key, phase = null) {
  return `
    import fs from 'node:fs';
    import path from 'node:path';
    import { appendObservation } from ${JSON.stringify(url('knowledge/observation-ledger.mjs'))};
    import { withLock } from ${JSON.stringify(url('transport.mjs'))};
    const root = ${JSON.stringify(root)};
    const phase = ${JSON.stringify(phase)};
    const stop = () => { process.send('ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const journal = path.dirname(to) === path.join(root, 'journal');
      if (journal && phase === 'before-publish') stop();
      rename(from, to);
      if (journal && phase === 'after-publish') stop();
    };
    withLock(root, () => appendObservation(path.join(root, 'journal'), ${JSON.stringify(payload(key))}));
  `;
}
function child(t, code, ipc = false) {
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])], windowsHide: true,
  });
  t.after(() => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL'); });
  let errors = '';
  processChild.stderr.on('data', (data) => { errors += data; });
  return { processChild, errors: () => errors };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-observation-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('concurrent candidate writers serialize without loss; identical retries remain one record', { timeout: 15000 }, async (t) => {
  const root = fixture(t);
  const writers = ['a', 'b', 'a'].map((key) => child(t, script(root, key)));
  const exits = await Promise.all(writers.map(({ processChild }) => once(processChild, 'exit')));
  exits.forEach(([code], index) => assert.equal(code, 0, writers[index].errors()));
  assert.equal(loadObservationJournal(path.join(root, 'journal')).length, 2);
  assert.equal(inspectLock(root).present, false);
});

for (const phase of ['before-publish', 'after-publish']) {
  test(`candidate writer killed ${phase} fails closed and retries idempotently`, { timeout: 15000 }, async (t) => {
    const root = fixture(t);
    const { processChild, errors } = child(t, script(root, 'a', phase), true);
    const ready = await Promise.race([once(processChild, 'message'), once(processChild, 'exit').then(() => { throw new Error(errors() || 'Missing checkpoint'); })]);
    assert.equal(ready[0], 'ready');
    const exited = once(processChild, 'exit');
    processChild.kill('SIGKILL');
    await exited;
    assert.equal(inspectLock(root).holderAlive, false);
    const journal = path.join(root, 'journal');
    assert.equal(loadObservationJournal(journal).length, phase === 'before-publish' ? 0 : 1);
    // This isolated fixture has no other writer, and the child is confirmed exited.
    fs.rmSync(path.join(root, 'writer.lock'));
    const retry = withLock(root, () => appendObservation(journal, payload('a')));
    assert.equal(retry.duplicate, phase === 'after-publish');
    assert.equal(loadObservationJournal(journal).length, 1);
    assert.equal(inspectLock(root).present, false);
  });
}
