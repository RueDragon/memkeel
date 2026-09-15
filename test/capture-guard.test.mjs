import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from '../lib/lifecycle.mjs';

// Regression coverage for the capture input guards.
//
// A missing evidence_text used to be reported as "Possible secret; redact before capture",
// because redactSecrets(undefined) returns '' and '' !== undefined. The misleading message
// sent a live investigation chasing the redaction rules instead of the missing field.
const topics = [
  { id: 'my-project/dsh-harness', workspace: 'my-project', title: 'DSH harness', path: 'work/topics/dsh.md' }
];
const base = {
  event_id: 'guard-test-0001',
  workspace: 'my-project',
  topic: 'my-project/dsh-harness',
  agent: 'dsh',
  occurred_at: '2026-09-10T09:00:00Z',
  recorded_at: '2026-09-10T09:00:00Z',
  evidence: ['work/proof.md'],
  facts: [{ key: 'guard-behaviour', text: 'Capture reports a missing evidence text as missing evidence.' }]
};
const goodEvidence = 'Read the guard source and reproduced each rejection without writing state.';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-capture-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault'), workRoot: 'work',
    projectRoot: 'work/projects', inboxRoot: 'work/inbox', eventsRoot: 'work/events', habitsNote: 'work/habits.md',
    actionsNote: 'work/actions.md', mistakesNote: 'work/mistakes.md', preferenceCandidatesNote: 'work/candidates.md',
    activeLimit: 6, recentLimit: 6, budgetBytes: 14000, topics, now: '2026-09-10T09:30:00Z' };
  const put = (p, c) => { const file = path.join(config.vaultRoot, p); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, c); };
  fs.mkdirSync(config.policyRoot, { recursive: true });
  fs.mkdirSync(path.join(config.vaultRoot, config.eventsRoot), { recursive: true });
  put('work/habits.md', '# Habits\n\x60\x60\x60json\n{"rules":[]}\n\x60\x60\x60');
  put('work/proof.md', 'Synthetic evidence only.');
  const transport = { create: put, append(p, c) { fs.appendFileSync(path.join(config.vaultRoot, p), '\n\n' + c); },
    verify(p) { return fs.readFileSync(path.join(config.vaultRoot, p), 'utf8'); },
    managed(p, h, b) { put(p, h + '\n<!-- AUTO-MANAGED:START -->\n' + b + '\n<!-- AUTO-MANAGED:END -->'); } };
  return { config, transport, put };
}

function assertNothingRecorded(config, eventId) {
  const plansFile = path.join(config.policyRoot, 'state', 'captures.json');
  const plans = fs.existsSync(plansFile) ? JSON.parse(fs.readFileSync(plansFile, 'utf8')) : {};
  assert.equal(plans[eventId], undefined, 'a rejected capture must not persist a recovery plan');
  const eventsDir = path.join(config.vaultRoot, config.eventsRoot);
  for (const name of fs.readdirSync(eventsDir, { recursive: true })) {
    const file = path.join(eventsDir, name);
    if (fs.statSync(file).isFile()) assert.ok(!fs.readFileSync(file, 'utf8').includes(eventId), 'a rejected capture must not append an event');
  }
}

test('missing evidence_text reports missing evidence instead of a possible secret', (t) => {
  const { config, transport } = fixture(t);
  assert.throws(() => capture(config, transport, base, undefined), (error) => {
    assert.match(error.message, /Evidence must be/);
    assert.doesNotMatch(error.message, /Possible secret/);
    return true;
  });
  assertNothingRecorded(config, base.event_id);
});

test('blank evidence_text reports missing evidence instead of a possible secret', (t) => {
  const { config, transport } = fixture(t);
  for (const value of ['', '   ', '\n']) {
    assert.throws(() => capture(config, transport, base, value), (error) => {
      assert.match(error.message, /Evidence must be/);
      assert.doesNotMatch(error.message, /Possible secret/);
      return true;
    });
  }
  assertNothingRecorded(config, base.event_id);
});

test('missing event object reports a shape error instead of a possible secret', (t) => {
  const { config, transport } = fixture(t);
  for (const value of [undefined, null, 'not-an-event', ['event']]) {
    assert.throws(() => capture(config, transport, value, goodEvidence), (error) => {
      assert.match(error.message, /Capture input must be an object/);
      assert.doesNotMatch(error.message, /Possible secret/);
      return true;
    });
  }
  assertNothingRecorded(config, base.event_id);
});

test('a long evidence_text is accepted since the 1800-byte gate was removed', (t) => {
  const { config, transport } = fixture(t);
  const long = 'x'.repeat(4000);
  const result = capture(config, transport, base, long);
  assert.equal(result.duplicate, false);
  assert.equal(result.event_id, base.event_id);
  const note = fs.readFileSync(path.join(config.vaultRoot, result.evidence.split('#')[0]), 'utf8');
  assert.ok(note.includes(long), 'the whole evidence body must reach the note, untruncated');
});

test('a real secret in the evidence text is still rejected', (t) => {
  const { config, transport } = fixture(t);
  assert.throws(() => capture(config, transport, base, '密码是Fake@123'), /Possible secret/);
  assert.throws(() => capture(config, transport, base, 'password: Swordfish-2026'), /Possible secret/);
  assertNothingRecorded(config, base.event_id);
});

test('a real secret inside the event is still rejected', (t) => {
  const { config, transport } = fixture(t);
  const leaky = { ...base, facts: [{ key: 'guard-behaviour', text: 'token: password: Swordfish-2026' }] };
  assert.throws(() => capture(config, transport, leaky, goodEvidence), /Possible secret/);
  assertNothingRecorded(config, base.event_id);
});

test('an oversized event is accepted since the 2600-byte ceiling was removed', (t) => {
  const { config, transport } = fixture(t);
  const huge = { ...base, facts: [{ key: 'guard-behaviour', text: 'x'.repeat(2500) }] };
  assert.ok(Buffer.byteLength(JSON.stringify(huge, null, 2)) > 2600, 'precondition: this event used to be rejected');
  const result = capture(config, transport, huge, goodEvidence);
  assert.equal(result.event_id, base.event_id);
  const journal = fs.readFileSync(path.join(config.vaultRoot, result.path), 'utf8');
  assert.ok(journal.includes('x'.repeat(2500)), 'the large fact must be stored, not dropped');
});
