// Coverage for the redacted diagnostic export (PRIV-01, plan item 7).
//
// The promise this feature makes is "safe to hand to someone else", so the tests are about what must
// NOT be in the output: an export that carries the user's absolute paths, a configuration credential
// or the body of their evidence is not mostly fine, it is a disclosure. The central test therefore
// builds an export from a store that really contains a marked fact and a marked evidence citation,
// and asserts the text is absent — plus that no absolute path from this machine survives.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DIAGNOSTICS_DROPPED_FIELDS, DIAGNOSTICS_FORMAT, DIAGNOSTICS_POLICY,
  auditDiagnostics, buildDiagnostics, redactConfig, redactPath, writeDiagnostics,
} from '../lib/diagnostics.mjs';
import { loadConfig } from '../lib/config.mjs';

const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-diag-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const store = path.join(root, 'store');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { encoding: 'utf8', windowsHide: true });
  assert.equal(run('init', '--store', store).status, 0);
  return { root, home, store, run };
}

/** A store with one real event, plus the two configuration fields that must never be exported. */
function withEvent(t) {
  const f = fixture(t);
  const configFile = path.join(f.home, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    ...JSON.parse(fs.readFileSync(configFile, 'utf8')),
    dashboardTokenSecret: 'SECRET-TOKEN-9911',
    obsidianCli: path.join(f.root, 'bin', 'obsidian'),
  }, null, 2));

  const project = path.join(f.root, 'project');
  fs.mkdirSync(project, { recursive: true });
  // The evidence note must really exist — `record` verifies its citation — and its body carries a
  // marker, so the test can tell whether a note body ever reached the export.
  fs.writeFileSync(path.join(f.store, 'evidence.md'), '# Evidence\n\nSECRET-EVIDENCE-BODY-4407\n');
  const added = f.run('workspace-add', '--cwd', project);
  assert.equal(added.status, 0, added.stderr);
  const workspace = JSON.parse(added.stdout).id;
  const topic = `${workspace}/diag`;
  assert.equal(f.run('register', '--topic', topic, '--workspace', workspace, '--title', 'Diagnostics drill').status, 0);

  fs.writeFileSync(path.join(f.root, 'event.json'), JSON.stringify({
    event_id: '20260916-dsh-diag-drill-01',
    workspace,
    topic,
    agent: 'dsh',
    occurred_at: '2026-09-16T00:00:00.000Z',
    evidence: ['evidence.md'],
    facts: [{ key: 'diag-drill', text: 'SECRET-FACT-BODY-4407' }],
    contexts: [{ id: 'session-drill', task: 'SECRET-TASK-4407', text: 'SECRET-CONTEXT-4407', certainty: 'reported' }],
    verification: ['recorded so the export has something real to withhold'],
  }, null, 2));
  assert.equal(f.run('record', '--file', path.join(f.root, 'event.json')).status, 0);
  return { ...f, config: loadConfig(f.home).config, workspace, topic, project };
}

// ------------------------------------------------------------------ path redaction

test('a path keeps the root it belonged to, and no more', () => {
  const home = path.join(os.tmpdir(), 'a', 'home');
  const store = path.join(os.tmpdir(), 'a', 'store');
  assert.equal(redactPath(home, { home, store }), '<memory-home>');
  assert.equal(redactPath(path.join(home, 'state', 'captures.json'), { home, store }), '<memory-home>');
  assert.equal(redactPath(path.join(store, 'habits.md'), { home, store }), '<store>');
  // A path that belongs to neither root keeps only its last segment, so it is visibly truncated.
  assert.equal(redactPath(path.join(os.tmpdir(), 'elsewhere', 'project'), { home, store }), '…/project');
  // Layout names are relative and carry the same information they did before.
  assert.equal(redactPath('work/events', { home, store }), 'work/events');
  assert.equal(redactPath('', { home, store }), '');
  // The store is checked before the home, so a store nested inside the home is still reported as the
  // store rather than as part of the home.
  const nested = path.join(home, 'store');
  assert.equal(redactPath(path.join(nested, 'x.md'), { home, store: nested }), '<store>');
});

test('configuration is exported with credentials dropped and paths reduced', () => {
  const home = path.join(os.tmpdir(), 'cfg', 'home');
  const store = path.join(os.tmpdir(), 'cfg', 'store');
  const redacted = redactConfig({
    policyRoot: home,
    vaultRoot: store,
    memoryRoot: store,
    layout: 'neutral',
    roles: { root: store, eventsRoot: 'events' },
    workspaceAliases: { 'project-abc': [path.join(os.tmpdir(), 'cfg', 'project')] },
    dashboardTokenSecret: 'SECRET-TOKEN-9911',
    obsidianCli: path.join(os.tmpdir(), 'cfg', 'bin', 'obsidian'),
  });
  assert.equal('dashboardTokenSecret' in redacted, false);
  assert.equal('obsidianCli' in redacted, false);
  assert.deepEqual(DIAGNOSTICS_DROPPED_FIELDS, ['dashboardTokenSecret', 'obsidianCli']);
  assert.equal(redacted.policyRoot, '<memory-home>');
  assert.equal(redacted.vaultRoot, '<store>');
  assert.equal(redacted.memoryRoot, '<store>');
  assert.equal(redacted.roles.root, '<store>', 'an absolute role is a location, not a layout name');
  assert.equal(redacted.roles.eventsRoot, 'events');
  assert.deepEqual(redacted.workspaceAliases['project-abc'], ['…/project']);
  assert.equal(redacted.layout, 'neutral', 'ordinary settings survive; the export is still useful');
});

// ------------------------------------------------------------------ the payload

test('the export counts the store without quoting any of it', (t) => {
  const f = withEvent(t);
  const bundle = buildDiagnostics(f.config, { version: '0.0.0-test' });
  assert.equal(bundle.format, DIAGNOSTICS_FORMAT);
  assert.equal(bundle.runtime.memkeel, '0.0.0-test');
  assert.equal(bundle.runtime.node, process.versions.node);
  assert.equal(bundle.counts.events, 1);
  assert.equal(bundle.counts.facts, 1);
  assert.equal(bundle.counts.contexts, 1);
  assert.ok(bundle.counts.topics >= 1);
  assert.ok(bundle.counts.workspaces >= 1);
  assert.ok(bundle.evidenceCitations >= 1);
  assert.equal(typeof bundle.counts.checkpointQueue.pending, 'number');
  assert.ok(bundle.excluded.length >= 4);
  assert.match(bundle.note, /脱敏诊断导出/);

  const text = JSON.stringify(bundle);
  // Every marker the fixture planted, checked individually so a failure names the leak.
  for (const marker of ['SECRET-FACT-BODY-4407', 'SECRET-EVIDENCE-BODY-4407', 'SECRET-TASK-4407', 'SECRET-CONTEXT-4407', 'SECRET-TOKEN-9911']) {
    assert.equal(text.includes(marker), false, `${marker} must not be exported`);
  }
  // And no absolute path from this machine, including the temporary root itself.
  for (const value of [f.home, f.store, f.project, f.root]) {
    assert.equal(text.includes(value), false, `${value} must not be exported`);
  }
  assert.equal(bundle.config.obsidianCli, undefined);
});

test('the redaction self-check catches a leak rather than trusting the construction', (t) => {
  const f = withEvent(t);
  const good = buildDiagnostics(f.config, {});
  assert.equal(auditDiagnostics(good, { home: f.home, store: f.store }).clean, true);

  // A payload that carries the home path must fail the check...
  const leaky = { ...good, config: { ...good.config, policyRoot: f.home } };
  const found = auditDiagnostics(leaky, { home: f.home });
  assert.equal(found.clean, false);
  assert.ok(found.leaks.some((row) => row.label === 'memory home'));
  // ...the check must not echo the value it found, or the audit itself becomes the leak.
  assert.equal(JSON.stringify(found).includes(f.home), false);

  // A dropped field reappearing under its real name is a leak too.
  assert.equal(auditDiagnostics({ ...good, dashboardTokenSecret: 'x' }, {}).clean, false);
  // So is a credential-shaped value.
  assert.equal(auditDiagnostics({ ...good, note: 'token sk-abcdefghijklmnop' }, {}).clean, false);
  assert.equal(auditDiagnostics({ ...good, note: 'Authorization: Bearer abcdefghijklmnop' }, {}).clean, false);
  // An explicitly supplied extra string is checked as well, which is how a caller can assert that
  // some other identifier of this machine stayed out.
  assert.equal(auditDiagnostics({ ...good, extra: f.project }, { extraStrings: [f.project] }).clean, false);
});

// ------------------------------------------------------------------ the file

test('writing refuses to overwrite, and creates the directory it needs', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'nested', 'deeper', 'diag.json');
  const written = writeDiagnostics(file, { format: DIAGNOSTICS_FORMAT, note: 'x' });
  assert.equal(written.file, path.resolve(file));
  assert.ok(written.bytes > 0);
  assert.match(fs.readFileSync(file, 'utf8'), /"note": "x"/);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => writeDiagnostics(file, { format: DIAGNOSTICS_FORMAT }), /Refusing to overwrite/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused write must leave the file untouched');
  assert.throws(() => writeDiagnostics('', {}), /needs a destination/);
  if (process.platform !== 'win32') {
    // The file names the machine's layout and its counts, so it is not world-readable.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('policy is stated in the payload, so a reader can tell omission from accident', () => {
  const labels = DIAGNOSTICS_POLICY.map((row) => row.excluded);
  assert.deepEqual(labels, ['会话正文与提示词', '证据与笔记正文', '完整路径', '凭据']);
  for (const row of DIAGNOSTICS_POLICY) assert.ok(row.detail.length > 0);
});

// ------------------------------------------------------------------ the CLI

test('the CLI writes one redacted file, reports its own audit, and refuses a second run', (t) => {
  const f = withEvent(t);
  const out = path.join(f.root, 'diag.json');
  const first = f.run('privacy', 'export', '--out', out);
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.audit.clean, true);
  assert.deepEqual(report.audit.leaks, []);
  assert.equal(report.counts.events, 1);
  assert.equal(path.resolve(report.file), path.resolve(out));

  const text = fs.readFileSync(out, 'utf8');
  assert.equal(text.includes('SECRET-FACT-BODY-4407'), false);
  assert.equal(text.includes(f.home), false);

  // A second run must not clobber the first: the export is cheap to regenerate and the file may
  // already have been sent to someone.
  const second = f.run('privacy', 'export', '--out', out);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Refusing to overwrite/);
  assert.equal(fs.readFileSync(out, 'utf8'), text);

  // `--out` is required, and its absence is a usage error rather than an empty export.
  const missing = f.run('privacy', 'export');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /requires --out/);
});
