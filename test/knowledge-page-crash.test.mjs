import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { publishPage } from '../lib/knowledge/refresh.mjs';
import { buildStatusPage, inspectPage } from '../lib/knowledge/pages.mjs';
import { atomicJson } from '../lib/transport.mjs';
import { FilesystemTransport } from '../lib/storage/filesystem.mjs';

const projection = { facts: [{ topic: 'demo/a', key: 'a', text: 'Recorded evidence', event_id: 'source' }], actions: [], conflicts: [] };
const moduleUrl = (name) => new URL(`../lib/${name}`, import.meta.url).href;
for (const phase of ['intent', 'page', 'manifest']) {
  test(`process kill after ${phase} recovers an atomic knowledge page`, { timeout: 15000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-page-crash-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const page = buildStatusPage(projection, 'demo/a');
    const config = { vaultRoot: root, policyRoot: root };
    const script = `
      import { publishPage } from ${JSON.stringify(moduleUrl('knowledge/refresh.mjs'))};
      import { atomicJson } from ${JSON.stringify(moduleUrl('transport.mjs'))};
      import { FilesystemTransport } from ${JSON.stringify(moduleUrl('storage/filesystem.mjs'))};
      const config = ${JSON.stringify(config)};
      const page = ${JSON.stringify(page)};
      const stop = () => { process.send('ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
      const transport = new FilesystemTransport(config);
      const create = transport.create.bind(transport);
      transport.create = (...args) => { create(...args); if (${JSON.stringify(phase)} === 'page') stop(); };
      publishPage({relative:'page.md', existing:'', page, transport, sourceCheck:()=>true,
        writeIntent:(v)=>{atomicJson(config.vaultRoot+'/intent.json',v); if (${JSON.stringify(phase)} === 'intent') stop();},
        writeManifest:(v)=>{atomicJson(config.vaultRoot+'/manifest.json',v); if (${JSON.stringify(phase)} === 'manifest') stop();},
        clearIntent:()=>{} });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let errors = '';
    child.stderr.on('data', (data) => { errors += data; });
    const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(errors || 'Child exited before checkpoint'); })]);
    assert.equal(ready[0], 'ready');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const file = path.join(root, 'page.md');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const intent = JSON.parse(fs.readFileSync(path.join(root, 'intent.json'), 'utf8'));
    let manifest;
    const result = publishPage({ relative: 'page.md', existing, page, pendingIntent: intent,
      transport: new FilesystemTransport(config), sourceCheck: () => true,
      writeIntent: (value) => atomicJson(path.join(root, 'intent.json'), value),
      writeManifest: (value) => { manifest = value; atomicJson(path.join(root, 'manifest.json'), value); },
      clearIntent: () => fs.rmSync(path.join(root, 'intent.json')) });
    assert.equal(result.recovered, phase !== 'intent');
    const final = fs.readFileSync(file, 'utf8');
    if (existing) assert.equal(final, existing);
    assert.equal(final.split('MEMKEEL-KNOWLEDGE:START').length, 2);
    assert.equal(inspectPage(manifest, projection, 'demo/a', [], final).state, 'fresh');
    assert.ok(!fs.existsSync(path.join(root, 'intent.json')));
  });
}
