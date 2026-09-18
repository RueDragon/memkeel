// Coverage for the installation receipt (DEP-02).
//
// The receipt is the only record of what `memkeel setup` changed in another application's
// configuration, so two commands read it and must agree: `setup` restores from it and `doctor`
// reports on it. These tests pin what a receipt means, what happens when it cannot be trusted, and
// the two conditions that are otherwise silent - a binding that points at a memory home no longer
// in use, and a launcher or script that has since moved away.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECEIPT_FORMAT, bindingDrift, describeIntent, dropReceiptEntry, launcherReport, mergeReceiptEntry, readInstallReceipt, receiptPath } from '../lib/install-receipt.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const write = (value) => {
    const file = receiptPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return file;
  };
  const receipt = (extra = {}) => ({
    format: RECEIPT_FORMAT,
    version: '1.0.0',
    memoryHome: home,
    scope: ['codex'],
    at: '2026-09-16T00:00:00.000Z',
    files: { [path.join(root, 'config.toml')]: { label: 'codex-mcp', before: 'model = "x"\n', after: 'model = "x"\nbound\n' } },
    ...extra,
  });
  return { root, home, write, receipt };
}

// ------------------------------------------------------------------ reading

test('no receipt is reported as absent, not as an error', (t) => {
  const { home } = fixture(t);
  const receipt = readInstallReceipt(home);
  assert.equal(receipt.exists, false);
  assert.equal(receipt.malformed, null);
  assert.deepEqual(receipt.files, {});
  assert.equal(receipt.file, receiptPath(home));
});

test('an unparseable or wrongly shaped receipt is reported instead of thrown', (t) => {
  for (const [label, body, expected] of [
    ['invalid JSON', '{ not json', /not valid JSON/],
    ['a JSON array', '[]', /not a JSON object/],
    ['a missing files object', JSON.stringify({ format: 1 }), /expected a "files" object/],
    ['a files array', JSON.stringify({ files: [] }), /expected a "files" object/],
  ]) {
    const { home, write } = fixture(t);
    write(body);
    const receipt = readInstallReceipt(home);
    assert.equal(receipt.exists, true, label);
    assert.match(receipt.malformed, expected, label);
    // A record that cannot be trusted must not be presented as usable rows.
    assert.deepEqual(receipt.files, {}, label);
  }
});

test('a receipt from before the format field is readable and marked legacy', (t) => {
  const { home, write, receipt } = fixture(t);
  const legacy = receipt();
  delete legacy.format; delete legacy.version; delete legacy.memoryHome;
  write(legacy);
  const parsed = readInstallReceipt(home);
  assert.equal(parsed.malformed, null);
  assert.equal(parsed.legacy, true);
  assert.equal(parsed.format, null);
  assert.equal(parsed.memoryHome, null);
  assert.equal(Object.keys(parsed.files).length, 1, 'the recorded bytes are what restore, so they must survive');
});

test('a row that cannot restore anything makes the whole receipt unusable', (t) => {
  // Dropping the broken row instead leaves a partial restore chain: an uninstall would restore the
  // files it still has rows for, report success, and leave our content in a file whose original
  // bytes are now unrecoverable. The chain is only useful as a complete record, so one unusable row
  // makes the record untrustworthy - and the reason names the row so it can be repaired on purpose.
  for (const [label, row] of [
    ['no after', { label: 'x', before: 'a' }],
    ['an after that is not a string', { label: 'x', before: 'a', after: 42 }],
    ['no before key at all', { label: 'x', after: 'a' }],
    ['a before that is neither null nor a string', { label: 'x', before: 7, after: 'a' }],
    ['not an object', 'nonsense'],
    ['null', null],
  ]) {
    const { home, write, receipt } = fixture(t);
    const raw = receipt();
    raw.files['/host/broken'] = row;
    write(raw);
    const parsed = readInstallReceipt(home);
    assert.equal(parsed.exists, true, label);
    assert.match(String(parsed.malformed), /"\/host\/broken"/, label);
    // A record that cannot be trusted must not be presented as usable rows.
    assert.deepEqual(parsed.files, {}, `${label}: a partial restore chain is worse than none`);
  }
});

test('a receipt whose rows are all usable is still read in full', (t) => {
  const { home, write, receipt } = fixture(t);
  const [only] = Object.keys(receipt().files);
  const raw = receipt();
  raw.files['/host/second'] = { label: 'claude-hooks', before: null, after: '{"hooks":{}}' };
  write(raw);
  const parsed = readInstallReceipt(home);
  assert.equal(parsed.malformed, null);
  assert.deepEqual(Object.keys(parsed.files).sort(), [only, '/host/second'].sort());
});

test('a row without a usable label makes the whole receipt unusable', (t) => {
  // The label is what attributes a row to a host, and `setup --uninstall` picks the rows it may
  // restore with `row.label.startsWith(...)`. A row that cannot be attributed therefore has to be
  // refused where it is read: letting it through defers the failure to a TypeError inside the one
  // path that restores a user's configuration, which is the worst place to discover it.
  for (const [label, row] of [
    ['no label', { before: 'a', after: 'b' }],
    ['a null label', { label: null, before: 'a', after: 'b' }],
    ['a numeric label', { label: 7, before: 'a', after: 'b' }],
    ['an empty label', { label: '', before: 'a', after: 'b' }],
  ]) {
    const { home, write, receipt } = fixture(t);
    const raw = receipt();
    raw.files['/host/unlabelled'] = row;
    write(raw);
    const parsed = readInstallReceipt(home);
    assert.match(String(parsed.malformed), /"\/host\/unlabelled"/, label);
    assert.deepEqual(parsed.files, {}, label);
  }
});

test('the writer refuses to record a row without a label, and keeps one it is not given again', (t) => {
  const { home, write, receipt } = fixture(t);
  write(receipt());
  const current = readInstallReceipt(home);
  const [tracked] = Object.keys(receipt().files);

  // Reader and writer have to agree. A writer able to produce a row its own reader calls
  // untrustworthy would turn a programming mistake into a host that cannot be uninstalled.
  assert.throws(() => mergeReceiptEntry(current, path.join(home, 'unlabelled.json'), { before: null, after: 'x' }, { memoryHome: home }), /label/);
  assert.throws(() => mergeReceiptEntry(current, path.join(home, 'numeric.json'), { label: 7, before: null, after: 'x' }, { memoryHome: home }), /label/);
  // A later record that does not carry the label forward keeps the one already recorded.
  const kept = mergeReceiptEntry(current, tracked, { before: 'a', after: 'b' }, { memoryHome: home });
  assert.equal(kept.files[tracked].label, 'codex-mcp');
});

test('a record written by this module is always readable by it', (t) => {
  const { home, write, receipt } = fixture(t);
  write(receipt());
  const file = path.join(home, 'written.json');
  // The round trip is the invariant the two sides share: anything the merge functions can write,
  // the reader must be able to read back without calling it untrustworthy.
  const draft = mergeReceiptEntry(readInstallReceipt(home), file, { label: 'codex-mcp', before: null, after: '{"a":1}' }, { memoryHome: home });
  write(draft);
  const parsed = readInstallReceipt(home);
  assert.equal(parsed.malformed, null);
  assert.equal(parsed.files[file].label, 'codex-mcp');
  assert.equal(parsed.files[file].before, null);
  assert.equal(parsed.files[file].after, '{"a":1}');
});

test('a round trip preserves the recorded bytes exactly', (t) => {
  const { home, write, receipt } = fixture(t);
  write(receipt());
  const parsed = readInstallReceipt(home);
  const [file] = Object.keys(receipt().files);
  assert.equal(parsed.files[file].before, 'model = "x"\n');
  assert.equal(parsed.files[file].after, 'model = "x"\nbound\n');
  assert.equal(parsed.files[file].label, 'codex-mcp');
  assert.equal(parsed.memoryHome, home);
  assert.deepEqual(parsed.scope, ['codex']);
});

// ------------------------------------------------------------------ drift

test('drift compares the recorded home exactly, with no parsing of host files', (t) => {
  const { home, root, write, receipt } = fixture(t);
  write(receipt());
  const parsed = readInstallReceipt(home);
  assert.equal(bindingDrift(parsed, home).status, 'ok');
  // A different home is drift, and path spellings that resolve to the same place are not.
  assert.equal(bindingDrift(parsed, path.join(root, 'elsewhere')).status, 'drift');
  assert.equal(bindingDrift(parsed, path.join(home, '..', path.basename(home))).status, 'ok');
});

test('a legacy receipt reports unknown drift rather than a guess', (t) => {
  const { home, write, receipt } = fixture(t);
  const legacy = receipt();
  delete legacy.memoryHome;
  write(legacy);
  const drift = bindingDrift(readInstallReceipt(home), home);
  // Claiming agreement would be inventing a fact; claiming drift would be a false alarm.
  assert.equal(drift.status, 'unknown');
  assert.match(drift.reason, /没有记录/);
});

test('no receipt and an unusable receipt are distinct states', (t) => {
  const { home, write } = fixture(t);
  assert.equal(bindingDrift(readInstallReceipt(home), home).status, 'no-receipt');
  write('{ broken');
  assert.equal(bindingDrift(readInstallReceipt(home), home).status, 'unknown');
});

// ------------------------------------------------------------------ merge and drop

test('recording a second file keeps the first one, and its pre-install bytes', (t) => {
  const { home, write, receipt } = fixture(t);
  write(receipt());
  const first = Object.keys(receipt().files)[0];
  const current = readInstallReceipt(home);

  const merged = mergeReceiptEntry(current, path.join(home, 'hooks.json'), { label: 'codex-hooks', before: null, after: 'bound' }, { memoryHome: home, scope: ['codex'] });
  // The lost-update case: writing only our own in-memory copy would drop the first entry and the
  // `before` bytes that are the only way to restore it.
  assert.equal(merged.files[first].before, 'model = "x"\n');
  assert.equal(merged.files[first].after, 'model = "x"\nbound\n');
  assert.equal(merged.files[path.join(home, 'hooks.json')].after, 'bound');
  assert.equal(Object.keys(merged.files).length, 2);
});

test('the first pre-install bytes always win over a later record', (t) => {
  const { home, write, receipt } = fixture(t);
  write(receipt());
  const file = Object.keys(receipt().files)[0];
  // A re-run records the file again; `before` must stay the state from before the *first* install,
  // because that is what an uninstall has to restore.
  const merged = mergeReceiptEntry(readInstallReceipt(home), file, { label: 'codex-mcp', before: 'something-else\n', after: 'rewritten' }, { memoryHome: home });
  assert.equal(merged.files[file].before, 'model = "x"\n');
  assert.equal(merged.files[file].after, 'rewritten');
});

test('a missing record is filled in, and a null before is preserved as null', (t) => {
  const { home, write, receipt } = fixture(t);
  write(receipt());
  const file = Object.keys(receipt().files)[0];
  const merged = mergeReceiptEntry(readInstallReceipt(home), path.join(home, 'settings.json'), { label: 'claude-hooks', before: null, after: '{"hooks":{}}' }, { memoryHome: home });
  // `null` means the file did not exist before the install, so an uninstall must delete it.
  assert.equal(merged.files[path.join(home, 'settings.json')].before, null);
  assert.equal(typeof merged.files[file].before, 'string');
});

test('merge and drop stamp the receipt and update only their own row', (t) => {
  const { home, write, receipt } = fixture(t);
  write(receipt());
  const file = Object.keys(receipt().files)[0];
  const other = path.join(home, 'other.json');
  const seeded = mergeReceiptEntry(readInstallReceipt(home), other, { label: 'x', before: null, after: 'y' }, { memoryHome: home, scope: ['codex'] });
  assert.equal(seeded.format, RECEIPT_FORMAT);
  assert.equal(seeded.memoryHome, home);
  assert.deepEqual(seeded.scope, ['codex']);
  assert.equal(typeof seeded.at, 'string');

  const dropped = dropReceiptEntry({ exists: true, ...seeded }, file, { memoryHome: home });
  assert.deepEqual(Object.keys(dropped.files), [other]);
});

test('merge and drop never mutate the receipt they were handed', (t) => {
  const { home, write, receipt } = fixture(t);
  write(receipt());
  const file = Object.keys(receipt().files)[0];
  const current = readInstallReceipt(home);
  const snapshot = JSON.stringify(current);
  mergeReceiptEntry(current, path.join(home, 'a.json'), { label: 'a', before: null, after: 'a' }, { memoryHome: home });
  dropReceiptEntry(current, file, { memoryHome: home });
  // The caller holds the on-disk view for the rest of the run; mutating it would corrupt it.
  assert.equal(JSON.stringify(current), snapshot);
});

test('the launcher report says whether every bound path still exists', (t) => {
  const { root } = fixture(t);
  const present = path.join(root, 'present.mjs');
  fs.writeFileSync(present, '// noop\n');
  const missing = path.join(root, 'gone.mjs');

  const ok = launcherReport({ command: process.execPath, files: [present] });
  assert.equal(ok.ok, true);
  assert.equal(ok.checks.length, 2);

  const broken = launcherReport({ command: process.execPath, files: [present, missing] });
  assert.equal(broken.ok, false);
  assert.equal(broken.checks.find((check) => check.path === missing).exists, false);
  assert.equal(broken.checks.find((check) => check.path === present).exists, true);
});

// ------------------------------------------------------------------ intent

const INTENT_BASE = { mode: 'apply', changed: 3, home: '/memory/home', version: '1.0.0' };
const liveReceipt = (extra = {}) => ({ exists: true, malformed: null, version: '1.0.0', memoryHome: '/memory/home', files: { '/host/config': { label: 'codex-mcp', before: 'a', after: 'b' } }, ...extra });

test('each operation names itself', () => {
  assert.equal(describeIntent({ ...INTENT_BASE, mode: 'uninstall', receipt: liveReceipt() }).kind, 'uninstall');
  assert.equal(describeIntent({ ...INTENT_BASE, receipt: { exists: false, files: {} } }).kind, 'first-install');
  assert.equal(describeIntent({ ...INTENT_BASE, receipt: liveReceipt({ files: {} }) }).kind, 'first-install');
  assert.equal(describeIntent({ ...INTENT_BASE, changed: 0, receipt: liveReceipt() }).kind, 'no-change');
  assert.equal(describeIntent({ ...INTENT_BASE, receipt: liveReceipt() }).kind, 'refresh');
  assert.equal(describeIntent({ ...INTENT_BASE, forced: true, receipt: liveReceipt() }).kind, 'rebind');
});

test('an upgrade is detected from the release recorded in the receipt', () => {
  const intent = describeIntent({ ...INTENT_BASE, version: '1.1.0', receipt: liveReceipt({ version: '1.0.0' }) });
  assert.equal(intent.kind, 'upgrade');
  assert.equal(intent.from, '1.0.0');
  assert.equal(intent.to, '1.1.0');
  // A receipt that records no version cannot establish an upgrade, so it is not claimed.
  assert.notEqual(describeIntent({ ...INTENT_BASE, version: '1.1.0', receipt: liveReceipt({ version: null }) }).kind, 'upgrade');
});

test('a moved memory home is a rebind, and it is named before an upgrade-free refresh', () => {
  const intent = describeIntent({ ...INTENT_BASE, home: '/other/home', receipt: liveReceipt() });
  assert.equal(intent.kind, 'rebind');
  assert.equal(intent.from, '/memory/home');
  assert.equal(intent.to, path.resolve('/other/home'));
});

test('an upgrade and a moved home are both reported, not collapsed into one', () => {
  // Upgrading the program and repointing it in the same run is a realistic move, and reporting
  // only the higher-priority condition would hide the other one.
  const intent = describeIntent({ ...INTENT_BASE, home: '/other/home', version: '2.0.0', receipt: liveReceipt({ version: '1.0.0' }) });
  assert.equal(intent.kind, 'upgrade');
  assert.deepEqual(intent.also.map((entry) => entry.kind), ['rebind']);
  assert.equal(intent.also[0].to, path.resolve('/other/home'));
});

test('every intent explains itself', () => {
  for (const args of [
    { ...INTENT_BASE, mode: 'uninstall', receipt: liveReceipt() },
    { ...INTENT_BASE, receipt: { exists: false, files: {} } },
    { ...INTENT_BASE, receipt: liveReceipt() },
    { ...INTENT_BASE, changed: 0, receipt: liveReceipt() },
    { ...INTENT_BASE, version: '2.0.0', receipt: liveReceipt() },
  ]) {
    const intent = describeIntent(args);
    assert.equal(typeof intent.kind, 'string');
    assert.ok(intent.reason.length > 8, `no reason for ${intent.kind}`);
    assert.ok(Array.isArray(intent.also), `no also list for ${intent.kind}`);
  }
});
