import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendObservation, loadObservationJournal, projectObservations } from '../lib/knowledge/observation-ledger.mjs';
import { validateObservation } from '../lib/knowledge/observations.mjs';
import { sha } from '../lib/transport.mjs';

const candidate = validateObservation({ claim: 'Tentative pattern', kind: 'explanation',
  support: [{ id: 'source', quote: 'Observed pattern' }] },
[{ id: 'source', text: 'Observed pattern', hash: sha('Observed pattern'), root: 'origin', workspace: 'demo', topic: 'demo/test' }],
{ workspace: 'demo', topic: 'demo/test' });
const proposal = { workspace: 'demo', topic: 'demo/test', key: 'pattern', operation: 'propose', observation: candidate };

test('journal retries are idempotent, revisions explicit and retirement preserves history', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-observation-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = appendObservation(root, proposal);
  assert.equal(appendObservation(root, proposal).duplicate, true);
  assert.throws(() => appendObservation(root, { ...proposal, observation: { ...candidate, claim: 'Different' } }));
  assert.throws(() => appendObservation(root, { ...proposal, operation: 'revise', supersedes: 'wrong' }));
  const revised = appendObservation(root, { ...proposal, operation: 'revise', supersedes: first.record.id,
    observation: { ...candidate, claim: 'Revised tentative pattern' } });
  appendObservation(root, { workspace: 'demo', topic: 'demo/test', key: 'pattern', operation: 'retire',
    supersedes: revised.record.id, reason: 'Counterexample found' });
  const records = loadObservationJournal(root);
  assert.equal(records.length, 3);
  assert.equal(records[0].payload.observation.claim, 'Tentative pattern');
  assert.equal(projectObservations(records)[0].status, 'retired');
  records[0].payload.observation.claim = 'Tampered';
  assert.throws(() => projectObservations(records), /integrity/);
});

test('journal rejects a proposal claiming confirmed authority', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-observation-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => appendObservation(root, { ...proposal, observation: { ...candidate, status: 'confirmed' } }));
  assert.equal(loadObservationJournal(root).length, 0);
});

test('journal rejects empty evidence and forged corroboration despite valid payload hashes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-observation-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => appendObservation(root, { ...proposal, observation: { ...candidate, support: [] } }), /Supporting/);
  assert.throws(() => appendObservation(root, { ...proposal, observation: { ...candidate, independentSources: 2 } }), /Inconsistent/);
  assert.throws(() => appendObservation(root, { ...proposal, observation: { ...candidate, evidenceState: 'corroborated' } }), /Inconsistent/);
});

test('journal loading detects deleted interior records and renamed record IDs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-observation-sequence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = appendObservation(root, proposal);
  appendObservation(root, { ...proposal, operation: 'revise', supersedes: first.record.id });
  const names = fs.readdirSync(root).sort();
  const bytes = fs.readFileSync(path.join(root, names[0]));
  fs.rmSync(path.join(root, names[0]));
  assert.throws(() => loadObservationJournal(root), /sequence/);
  fs.writeFileSync(path.join(root, names[0]), bytes);
  fs.renameSync(path.join(root, names[0]), path.join(root, `00000000-${'0'.repeat(64)}.json`));
  assert.throws(() => loadObservationJournal(root), /filename/);
});
