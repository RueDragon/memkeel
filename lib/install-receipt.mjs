// The installation receipt: the restore chain for every host file `memkeel setup` rewrites.
//
// It records, per file, the bytes from before the install and the bytes that were written, so an
// uninstall can restore the first and refuse to clobber anything changed since the second.
//
// It lives in its own module because two commands read it and must agree: `setup` writes and
// restores from it, and `doctor` reports on it without writing. A receipt that one of them
// misreads is worse than no receipt at all, because a restore would then be based on the wrong
// bytes.
//
// Nothing here parses a host's own config format. `setup` embeds the memory home in everything it
// writes, so the receipt records the home it bound to and drift is an exact comparison. Pulling
// `--home` back out of a TOML, JSON or YAML document with a regular expression would be the
// brittle string-slicing that this design exists to avoid.
import fs from 'node:fs';
import path from 'node:path';

export const RECEIPT_FILE = 'setup-receipt.json';
export const RECEIPT_FORMAT = 1;
export const RECEIPT_DIR = 'state';

export function receiptPath(home) {
  return path.join(home, RECEIPT_DIR, RECEIPT_FILE);
}

/**
 * Read and describe the receipt without ever writing.
 *
 * `malformed` carries the reason an existing receipt cannot be trusted. That condition is what
 * makes a later uninstall fail closed, so it is reported as data rather than thrown: `setup` turns
 * it into a refusal, and `doctor` turns it into an unhealthy store.
 */
export function readInstallReceipt(home) {
  const file = receiptPath(home);
  const base = { exists: false, file, malformed: null, legacy: false, format: null, version: null, memoryHome: null, scope: null, at: null, files: {} };
  if (!fs.existsSync(file)) return base;

  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { ...base, exists: true, malformed: `it is not valid JSON (${error.message})` }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base, exists: true, malformed: 'the document is not a JSON object' };
  if (!raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) return { ...base, exists: true, malformed: 'expected a "files" object' };

  const files = {};
  const unusable = [];
  for (const [name, row] of Object.entries(raw.files)) {
    // A row needs both byte strings to restore anything: a string `after` to recognise the state
    // this install left behind, and a `before` that is a string or null (null meaning the file did
    // not exist). A row missing them is dropped from `files`, but that on its own is not enough -
    // silently dropping it would leave an uninstall with a partial chain that reports success while
    // our content stays in a file whose original bytes are gone. So the record is reported as
    // untrustworthy instead, and the reason names the row so a human can repair it deliberately.
    //
    // The label is required for the same reason: it is what attributes a row to a host, and
    // `setup --uninstall` selects what it may restore with `row.label.startsWith(...)`. A row whose
    // label is missing or not a string is not attributable, so it is refused here rather than
    // surfacing as a TypeError inside the path that restores a user's configuration. Every release
    // that has written this file recorded a label, so no legitimate record is refused by this.
    //
    // `pending` is an interrupted write: the bytes a run intended to write and had not yet read back.
    // `after` is the last state this install is known to have written, so it is null only while such a
    // transaction is open and nothing has been committed yet - a null without a pending record leaves
    // no way to tell what is on disk, and is refused like any other unusable row.
    const pending = row?.pending && typeof row.pending === 'object' && !Array.isArray(row.pending) && typeof row.pending.after === 'string'
      ? { after: row.pending.after, at: typeof row.pending.at === 'string' ? row.pending.at : null }
      : null;
    const usable = row && typeof row === 'object'
      && typeof row.label === 'string' && row.label.length > 0
      && (row.before === null || typeof row.before === 'string')
      && (typeof row.after === 'string' || (row.after === null && pending !== null))
      && (row.pending === undefined || row.pending === null || pending !== null);
    if (!usable) { unusable.push(name); continue; }
    files[name] = { label: row.label, before: row.before ?? null, after: typeof row.after === 'string' ? row.after : null, pending };
  }
  if (unusable.length) {
    return {
      ...base,
      exists: true,
      malformed: `${unusable.map((name) => `"${name}"`).join(', ')} cannot be used - each file row needs a non-empty string "label", a string "after", and a "before" that is a string or null`,
    };
  }

  return {
    exists: true,
    file,
    malformed: null,
    // A receipt written before the format field existed is still usable: the recorded bytes are
    // what restores a user's configuration, not the format number.
    legacy: raw.format === undefined,
    format: raw.format ?? null,
    version: raw.version ?? null,
    memoryHome: typeof raw.memoryHome === 'string' ? raw.memoryHome : null,
    scope: Array.isArray(raw.scope) ? raw.scope : null,
    at: typeof raw.at === 'string' ? raw.at : null,
    files,
  };
}

/**
 * The receipt after recording one file that has already been written and confirmed: pure, because this
 * is the part that silently loses data when it is wrong.
 *
 * It must keep the entries another run recorded - and the `before` bytes they hold - while updating
 * only this file's own row, which is why the caller passes the freshly read receipt in rather than
 * its own in-memory copy.
 *
 * This is the single-phase form, and it is only correct for a caller with nothing left to interrupt:
 * it records `after` as the installed state immediately. Anything that writes a file first has to use
 * `beginReceiptEntry` and `commitPending` around that write instead, because recording the intended
 * state as the installed one is what leaves an interrupted write unrecognisable. `setup` uses the
 * two-phase form for that reason.
 */
export function mergeReceiptEntry(current, file, entry, meta = {}) {
  const draft = { ...(current?.exists ? current : {}), files: { ...(current?.files ?? {}) } };
  const previous = draft.files[file];
  // The label is required, and a later record that omits it keeps the one already recorded. This is
  // what keeps the writer and the reader in agreement: a row the reader would refuse as
  // unattributable must not be producible here, where the mistake would be a programming error
  // rather than a corrupt file somebody can inspect.
  const label = entry.label ?? previous?.label;
  if (typeof label !== 'string' || label.length === 0) throw new Error(`A receipt entry needs a non-empty string label: ${file}`);
  draft.files[file] = {
    label,
    // The first pre-install bytes are the only way back, so an earlier record always wins.
    before: previous?.before !== undefined ? previous.before : entry.before ?? null,
    after: entry.after ?? null,
    // A completed write leaves no transaction open.
    pending: null,
  };
  return stampReceipt(draft, meta);
}

/**
 * The row for a write that is about to happen: the intended bytes, next to the state on disk.
 *
 * This is the half that makes an interruption survivable. `after` keeps describing what is actually
 * on disk - the previous installed state - until the intended bytes have been read back from the file,
 * and the intent lives in `pending`. Advancing `after` here instead is what made an interrupted
 * upgrade unrecognisable: the file matched neither the old state nor a state the record claimed, so
 * every later run refused it and the uninstall refused it too.
 */
export function beginReceiptEntry(current, file, entry, meta = {}) {
  const draft = { ...(current?.exists ? current : {}), files: { ...(current?.files ?? {}) } };
  const previous = draft.files[file];
  const label = entry.label ?? previous?.label;
  if (typeof label !== 'string' || label.length === 0) throw new Error(`A receipt entry needs a non-empty string label: ${file}`);
  if (typeof entry.intended !== 'string') throw new Error(`A pending transaction needs the bytes it intends to write: ${file}`);
  draft.files[file] = {
    label,
    before: previous?.before !== undefined ? previous.before : entry.before ?? null,
    after: typeof previous?.after === 'string' ? previous.after : null,
    pending: { after: entry.intended, at: typeof entry.at === 'string' ? entry.at : new Date().toISOString() },
  };
  return stampReceipt(draft, meta);
}

/** The row once the intended bytes have been read back: they are the installed state now. */
export function commitPending(current, file, meta = {}) {
  const draft = { ...(current?.exists ? current : {}), files: { ...(current?.files ?? {}) } };
  const row = draft.files[file];
  if (!row?.pending) return stampReceipt(draft, meta);
  draft.files[file] = { ...row, after: row.pending.after, pending: null };
  return stampReceipt(draft, meta);
}

/**
 * The row once an interrupted write is known never to have reached the file.
 *
 * A row with nothing committed yet cannot simply lose its transaction: `after` would be null with no
 * pending record, which the reader refuses because nothing would describe the file. The caller drops
 * such a row instead - there is nothing to restore for a file this install never changed.
 */
export function clearPending(current, file, meta = {}) {
  const draft = { ...(current?.exists ? current : {}), files: { ...(current?.files ?? {}) } };
  const row = draft.files[file];
  if (!row?.pending) return stampReceipt(draft, meta);
  if (row.after === null) throw new Error(`Clearing the transaction would leave a row describing no state at all; drop it instead: ${file}`);
  draft.files[file] = { ...row, pending: null };
  return stampReceipt(draft, meta);
}

/** The receipt after dropping one file's row, once it has been restored. */
export function dropReceiptEntry(current, file, meta = {}) {
  const draft = { ...(current?.exists ? current : {}), files: { ...(current?.files ?? {}) } };
  delete draft.files[file];
  return stampReceipt(draft, meta);
}

function stampReceipt(draft, { format, version, memoryHome, scope, at } = {}) {
  draft.format = format ?? draft.format ?? RECEIPT_FORMAT;
  if (version) draft.version = version;
  if (memoryHome) draft.memoryHome = memoryHome;
  if (scope) draft.scope = scope;
  draft.at = at ?? new Date().toISOString();
  return draft;
}

/**
 * Whether the recorded bindings still point at the memory home in use.
 *
 * This is the "the store moved but every host still reads the old one" failure. It is silent at
 * install time and only surfaces later as agents that remember nothing, so it is worth a check.
 *
 * A legacy receipt recorded no home and therefore cannot answer the question; that is reported as
 * `unknown` rather than as `ok`, because claiming agreement would be a guess.
 */
export function bindingDrift(receipt, home) {
  if (!receipt?.exists) return { status: 'no-receipt', expected: home ? path.resolve(home) : null, bound: null };
  if (receipt.malformed) return { status: 'unknown', expected: home ? path.resolve(home) : null, bound: null, reason: receipt.malformed };
  if (!receipt.memoryHome) return { status: 'unknown', expected: home ? path.resolve(home) : null, bound: null, reason: '这份安装记录没有记录它绑定的 memory home（旧格式）。重跑 setup 后会补上，届时 doctor 才能核对。' };
  const bound = path.resolve(receipt.memoryHome);
  const expected = path.resolve(home);
  if (bound === expected) return { status: 'ok', expected, bound };
  return { status: 'drift', expected, bound };
}

/**
 * Whether the launcher and the scripts a binding invokes still exist.
 *
 * A binding stores absolute paths, so moving or renaming the checkout leaves every host pointing
 * at files that are gone - which looks like a broken memory rather than a moved install.
 */
export function launcherReport({ command = '', files = [] } = {}) {
  const checks = [];
  if (command) checks.push({ label: 'launcher', path: command, exists: fs.existsSync(command) });
  for (const file of files) checks.push({ label: path.basename(file), path: file, exists: fs.existsSync(file) });
  return { ok: checks.every((check) => check.exists), checks };
}

/**
 * What this run is about to do, named rather than implied.
 *
 * `first-install`, `no-change`, `upgrade`, `rebind`, `refresh` and `uninstall` are different
 * operations with different risks, and a user reading a report should not have to infer which one
 * happened from a changed-file count.
 *
 * More than one can be true at once - upgrading the program *and* pointing it at a different home
 * is a realistic move - so the remaining matches are reported in `also` instead of being dropped
 * by the priority order.
 */
export function describeIntent({ mode = 'apply', receipt = null, changed = 0, home = '', version = '', forced = false } = {}) {
  const resolved = home ? path.resolve(home) : '';
  if (mode === 'uninstall') return { kind: 'uninstall', reason: '从安装记录恢复宿主原文件，并删除对应的记录条目。', also: [] };

  const tracked = Object.keys(receipt?.files ?? {}).length;
  if (!receipt?.exists || tracked === 0) return { kind: 'first-install', reason: '这台机器上还没有安装记录，本次是首次绑定。', also: [] };

  const conditions = [];
  if (receipt.version && version && receipt.version !== version) {
    conditions.push({ kind: 'upgrade', from: receipt.version, to: version, reason: `安装记录来自 memkeel ${receipt.version}，当前是 ${version}：本次会把绑定刷新到新版本写入的路径。` });
  }
  if (receipt.memoryHome && resolved && path.resolve(receipt.memoryHome) !== resolved) {
    conditions.push({ kind: 'rebind', from: receipt.memoryHome, to: resolved, reason: `安装记录绑定的是另一个 memory home（${receipt.memoryHome}），本次要改指 ${resolved}。` });
  }
  if (changed === 0) conditions.push({ kind: 'no-change', reason: '绑定已经与当前配置一致，本次不需要改动任何文件。' });
  if (forced) conditions.push({ kind: 'rebind', reason: '本次带 --force，会覆盖与当前声明不一致的既有条目。' });
  if (!conditions.length) conditions.push({ kind: 'refresh', reason: '绑定与当前声明有差异，本次只写入差异部分。' });

  const [primary, ...also] = conditions;
  return { ...primary, also };
}
