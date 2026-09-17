// The one config contract.
//
// `config.json` is the only configuration the program reads, and four entry points need it:
// the CLI, the MCP server, the hook runner and the web console. Each of them used to repeat
// the same read-and-normalise line, so a change to defaults or validation had to be made in
// four places or the entries silently disagreed. They now all call `loadConfig` here.
//
// What lives here:
//   - where the memory home is, and the precedence that decides it,
//   - reading and parsing the document,
//   - the field tables and the validator the settings page and the CLI share,
//   - the effective view (normalised values plus where each one came from),
//   - the migration plan for a document written by an older shape.
//
// What deliberately does NOT live here: the dashboard's preview/execute handshake. That is a
// console concern (`lib/dashboard-actions.mjs`) and imports the validator from this module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLayout, normalizeLayout } from './layout.mjs';
import { atomicJson, inside } from './transport.mjs';
import { DEFAULT_LOCALE, makeTranslator, msg, renderMessages } from './messages.mjs';

/** A configuration problem the user can act on. Never a raw fs/JSON stack trace. */
export class ConfigError extends Error {}

export const CONFIG_FILE = 'config.json';
export const DEFAULT_HOME_DIR = '.memkeel';

// Bumped when the shape of the document changes in a way a migration has to express. This is
// deliberately NOT the `version` field: that one records which release wrote the file and is
// left alone by migrations, so a release number is never rewritten into a schema number.
export const CONFIG_SCHEMA_VERSION = 1;

// Top-level keys this program understands. Anything else is preserved untouched and reported
// as a note rather than rejected: a store may carry keys written by a newer build, and
// dropping them would be worse than ignoring them.
export const CONFIG_KNOWN_KEYS = Object.freeze([
  'version', 'configSchema', 'memoryRoot', 'vaultRoot', 'vaultName', 'obsidianCli', 'storage',
  'layout', 'roles', 'policyRoot', 'activeLimit', 'recentLimit', 'recentDays', 'budgetBytes',
  'workspaceAliases', 'hook', 'topics', 'catalogTopics', 'dashboardTokenSecret', '_comment',
  '_storage',
  // Written by `memkeel migrate` (DATA-02) to record where a store was moved from. Known rather than
  // merely tolerated so a migrated store does not report its own provenance as a typo.
  'migration',
  // The collection policy (PRIV-01). Optional with documented defaults: an absent section means
  // "collect", so an existing store keeps behaving exactly as it did before the switch existed.
  'collection',
]);

// Keys kept readable for older stores. Each maps to the modern role it feeds, so a legacy file
// keeps working while validation warns that the modern spelling exists.
export const CONFIG_DEPRECATED_KEYS = Object.freeze({
  preferenceCandidatesNote: 'roles.candidatesNote',
  eventsRoot: 'roles.eventsRoot',
  topicsRoot: 'roles.topicsRoot',
  projectRoot: 'roles.projectRoot',
  inboxRoot: 'roles.inboxRoot',
  habitsNote: 'roles.habitsNote',
  actionsNote: 'roles.actionsNote',
  mistakesNote: 'roles.mistakesNote',
  experienceNote: 'roles.experienceNote',
});

// These tables are display data, and the settings page and the CLI both show them. The labels are
// therefore message references rather than sentences: the language is decided by whichever surface
// is printing (the page renders them through `shared()`, the CLI through `renderMessages`), and the
// sentences below that quote a label pass the same reference as a parameter instead of spelling the
// label again - one home per label, so the table and the messages cannot drift apart.
//
// Three editable groups, and only three. Roles are logical names, so a store can be
// reorganised without code depending on physical paths.
export const CONFIG_ROLE_FIELDS = Object.freeze([
  ['eventsRoot', msg('cli.config.role.eventsRoot')],
  ['topicsRoot', msg('cli.config.role.topicsRoot')],
  ['projectRoot', msg('cli.config.role.projectRoot')],
  ['habitsNote', msg('cli.config.role.habitsNote')],
  ['actionsNote', msg('cli.config.role.actionsNote')],
  ['mistakesNote', msg('cli.config.role.mistakesNote')],
  ['candidatesNote', msg('cli.config.role.candidatesNote')],
  ['experienceNote', msg('cli.config.role.experienceNote')],
  ['inboxRoot', msg('cli.config.role.inboxRoot')],
]);

// [key, label, min, max, hint]
export const CONFIG_NUMBER_FIELDS = Object.freeze([
  ['activeLimit', msg('cli.config.number.activeLimit.label'), 1, 200, msg('cli.config.number.activeLimit.hint')],
  ['recentLimit', msg('cli.config.number.recentLimit.label'), 1, 500, msg('cli.config.number.recentLimit.hint')],
  ['recentDays', msg('cli.config.number.recentDays.label'), 1, 3650, msg('cli.config.number.recentDays.hint')],
  ['budgetBytes', msg('cli.config.number.budgetBytes.label'), 256, 16 * 1024 * 1024, msg('cli.config.number.budgetBytes.hint')],
]);

export const CONFIG_LAYOUT_OPTIONS = Object.freeze([
  ['neutral', msg('cli.config.layout.neutral')],
  ['obsidian-notion', msg('cli.config.layout.obsidian-notion')],
]);

export const CONFIG_STORAGE_OPTIONS = Object.freeze([
  ['filesystem', msg('cli.config.storage.filesystem')],
  ['obsidian-cli', msg('cli.config.storage.obsidian-cli')],
]);

export const CONFIG_FIELD_LABELS = Object.freeze({
  storage: msg('cli.config.field.storage'),
  memoryRoot: msg('cli.config.field.memoryRoot'),
  vaultRoot: msg('cli.config.field.vaultRoot'),
  vaultName: msg('cli.config.field.vaultName'),
  obsidianCli: msg('cli.config.field.obsidianCli'),
  layout: msg('cli.config.field.layout'),
  activeLimit: msg('cli.config.field.activeLimit'),
  recentLimit: msg('cli.config.field.recentLimit'),
  recentDays: msg('cli.config.field.recentDays'),
  budgetBytes: msg('cli.config.field.budgetBytes'),
});

// The checkout this program ships in. A memory store must never live inside it: the
// checkout is disposable, the store is not.
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function configFilePath(config) {
  return path.join(config.policyRoot, CONFIG_FILE);
}

export function readConfigFile(config) {
  const file = configFilePath(config);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`无法读取配置文件 ${file}：${error.message}`); }
  try { return { file, text, raw: JSON.parse(text) }; }
  catch (error) { throw new Error(`配置文件不是合法 JSON（${file}）：${error.message}`); }
}

const trimText = (value) => String(value ?? '').trim();

function insideRepository(target) {
  let cursor = path.resolve(target);
  const tail = [];
  while (!fs.existsSync(cursor)) {
    tail.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const resolved = fs.existsSync(cursor) ? path.join(fs.realpathSync(cursor), ...tail) : path.resolve(target);
  const rel = path.relative(fs.realpathSync(REPOSITORY_ROOT), resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A store root is acceptable when it exists and is writable, or when the nearest
// existing ancestor is a writable directory. `create` is set only by the write path, so
// merely opening the settings page never creates a directory.
function resolveStoreDir(value, field, issues, { create = false } = {}) {
  // The label is the same reference the field table carries, so a message and the table cannot
  // disagree about what a field is called.
  const label = CONFIG_FIELD_LABELS[field];
  if (!value) { issues.push({ field, message: msg('cli.config.storeRoot.empty', { label }) }); return null; }
  if (!path.isAbsolute(value)) { issues.push({ field, message: msg('cli.config.storeRoot.notAbsolute', { label, value }) }); return null; }
  if (insideRepository(value)) {
    issues.push({ field, message: msg('cli.config.storeRoot.insideCheckout', { label, root: REPOSITORY_ROOT }) });
    return null;
  }
  const target = path.resolve(value);
  if (fs.existsSync(target)) {
    let stat;
    try { stat = fs.statSync(target); } catch (error) { issues.push({ field, message: msg('cli.config.storeRoot.unreadable', { label, error: error.message }) }); return null; }
    if (!stat.isDirectory()) { issues.push({ field, message: msg('cli.config.storeRoot.notADirectory', { label, target }) }); return null; }
    try { fs.accessSync(target, fs.constants.W_OK); } catch { issues.push({ field, message: msg('cli.config.storeRoot.notWritable', { label, target }) }); return null; }
    return target;
  }
  let cursor = path.dirname(target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) { issues.push({ field, message: msg('cli.config.storeRoot.cannotCreate', { label, target }) }); return null; }
    cursor = parent;
  }
  let stat;
  try { stat = fs.statSync(cursor); } catch (error) { issues.push({ field, message: msg('cli.config.storeRoot.parentUnreadable', { label, error: error.message }) }); return null; }
  if (!stat.isDirectory()) { issues.push({ field, message: msg('cli.config.storeRoot.parentNotDirectory', { label, target }) }); return null; }
  try { fs.accessSync(cursor, fs.constants.W_OK); } catch { issues.push({ field, message: msg('cli.config.storeRoot.parentNotWritable', { label, target }) }); return null; }
  if (!create) return target;
  try { fs.mkdirSync(target, { recursive: true }); } catch (error) { issues.push({ field, message: msg('cli.config.storeRoot.createFailed', { label, error: error.message }) }); return null; }
  return target;
}

// Validates the editable groups and returns their normalized form. Every problem is
// collected rather than thrown one at a time, so the settings page can list all of them;
// the write path turns any non-empty list into a refusal (fail closed).
export function inspectConfigGroups(candidate = {}, { createRoots = false } = {}) {
  const issues = [];
  const notes = [];

  const storage = trimText(candidate.storage) || 'filesystem';
  if (!CONFIG_STORAGE_OPTIONS.some(([id]) => id === storage)) {
    issues.push({ field: 'storage', message: msg('cli.config.storage.invalid', { value: trimText(candidate.storage) || msg('cli.config.value.empty') }) });
  }
  const layout = trimText(candidate.layout) || 'neutral';
  if (!CONFIG_LAYOUT_OPTIONS.some(([id]) => id === layout)) {
    issues.push({ field: 'layout', message: msg('cli.config.layout.invalid', { value: trimText(candidate.layout) || msg('cli.config.value.empty') }) });
  }
  const obsidianCli = trimText(candidate.obsidianCli);
  const vaultName = trimText(candidate.vaultName);
  if (storage === 'obsidian-cli') {
    if (!obsidianCli) issues.push({ field: 'obsidianCli', message: msg('cli.config.obsidianCli.required') });
    if (!vaultName) issues.push({ field: 'vaultName', message: msg('cli.config.vaultName.required') });
  }

  const configuredMemoryRoot = trimText(candidate.memoryRoot);
  const memoryRoot = resolveStoreDir(configuredMemoryRoot, 'memoryRoot', issues, { create: createRoots });
  // An empty vaultRoot is unusable at runtime (every note path is resolved against it),
  // so it is materialised from memoryRoot instead of being written back as an empty string.
  const vaultRootValue = trimText(candidate.vaultRoot) || configuredMemoryRoot;
  const vaultRoot = resolveStoreDir(vaultRootValue, 'vaultRoot', issues, { create: createRoots });
  if (!trimText(candidate.vaultRoot) && configuredMemoryRoot) notes.push(msg('cli.config.note.vaultRootDerived'));

  const configuredRoles = candidate.roles && typeof candidate.roles === 'object' ? candidate.roles : {};
  const roles = {};
  for (const [key, label] of CONFIG_ROLE_FIELDS) {
    const value = trimText(configuredRoles[key]).replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!value) { issues.push({ field: `roles.${key}`, message: msg('cli.config.role.required', { role: key, label }) }); continue; }
    roles[key] = value;
  }
  if (memoryRoot && !fs.existsSync(memoryRoot)) notes.push(msg('cli.config.note.memoryRootAbsent'));
  // Preview validates new roots without creating them.
  for (const root of [memoryRoot, vaultRoot].filter(Boolean)) {
    for (const [key, label] of CONFIG_ROLE_FIELDS) {
      const value = roles[key];
      if (!value) continue;
      try {
        const rel = path.relative(root, path.resolve(root, value));
        if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes root');
        if (fs.existsSync(root)) inside(root, value);
      } catch (error) {
        issues.push({ field: `roles.${key}`, message: msg('cli.config.role.outsideRoot', { role: key, label, error: error.message }) });
      }
    }
  }
  const numbers = {};
  for (const [key, label, min, max] of CONFIG_NUMBER_FIELDS) {
    const raw = candidate[key];
    const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push({ field: key, message: msg('cli.config.number.notInteger', { label, key, min, max, value: raw === undefined ? msg('cli.config.value.unset') : JSON.stringify(raw) }) });
      continue;
    }
    numbers[key] = value;
  }

  return {
    groups: {
      storage,
      layout,
      obsidianCli,
      vaultName,
      memoryRoot: configuredMemoryRoot,
      vaultRoot: vaultRootValue,
      roles,
      ...numbers,
    },
    issues,
    notes,
  };
}

function displayValue(value) {
  if (value === undefined || value === null) return msg('cli.config.value.unset');
  const text = String(value);
  return text === '' ? msg('cli.config.value.empty') : text;
}

// `field` is the human label the confirmation dialog prints and `key` is the machine
// name, because these fields have no entry in the dialog's own label table.
export function configChanges(raw, next) {
  const changes = [];
  const compare = (key, label, before, after) => {
    if (String(before ?? '') === String(after ?? '')) return;
    changes.push({ field: label, key, from: displayValue(before), to: displayValue(after) });
  };
  for (const key of Object.keys(CONFIG_FIELD_LABELS)) compare(key, CONFIG_FIELD_LABELS[key], raw[key], next[key]);
  const rawRoles = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  for (const [key, label] of CONFIG_ROLE_FIELDS) {
    compare(`roles.${key}`, msg('cli.config.changeField.role', { role: key, label }), rawRoles[key], next.roles[key]);
  }
  return changes;
}

// ------------------------------------------------------------------ home resolution

/**
 * Resolve the memory home. One precedence, shared by every entry point:
 * an explicit `--home` beats `MEMKEEL_HOME`, which beats the per-user default.
 *
 * `source` is reported so a diagnostic can say why a directory was chosen instead of
 * leaving the user to guess which of the three won.
 */
export function resolveHome({ home = '', env = process.env, homedir = os.homedir() } = {}) {
  const explicit = typeof home === 'string' ? home.trim() : '';
  const fromEnv = typeof env?.MEMKEEL_HOME === 'string' ? env.MEMKEEL_HOME.trim() : '';
  if (explicit) return { home: path.resolve(explicit), source: 'explicit --home' };
  if (fromEnv) return { home: path.resolve(fromEnv), source: 'MEMKEEL_HOME' };
  return { home: path.resolve(path.join(homedir, DEFAULT_HOME_DIR)), source: `default ${path.join(homedir, DEFAULT_HOME_DIR)}` };
}

// ------------------------------------------------------------------ loading

/**
 * Read `<home>/config.json` and return the normalised config the core expects.
 * Throws ConfigError with an actionable line for a missing home or a malformed document,
 * so a first-run user never sees a raw ENOENT stack trace.
 */
export function readConfigDocument(home) {
  const file = path.join(home, CONFIG_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new ConfigError(`No memory home at ${home}: ${file} does not exist. Run \`memkeel init\` first.`);
    throw new ConfigError(`Cannot read ${file}: ${error.message}`);
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch (error) { throw new ConfigError(`${file} is not valid JSON: ${error.message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${file} must contain a JSON object.`);
  return { file, text, raw };
}

/**
 * The single load used by the CLI, the MCP server, the hook runner and the console.
 * Returns the document as well as the applied layout, so a caller can report on what it
 * read without parsing the file a second time.
 */
export function loadConfig(home) {
  const resolved = typeof home === 'string' ? { home, source: 'given' } : resolveHome(home ?? {});
  const { file, text, raw } = readConfigDocument(resolved.home);
  return { home: resolved.home, homeSource: resolved.source, file, text, raw, config: applyLayout({ ...raw, policyRoot: resolved.home }) };
}

// ------------------------------------------------------------------ validation

/**
 * Validate a config document for the CLI.
 *
 * Shares `inspectConfigGroups` with the settings page, so a value the CLI accepts is a value
 * the console accepts and the other way round. On top of the group checks this reports the
 * document-level policy the console never sees: an unknown top-level key, a deprecated flat
 * role key, and a store root that two different fields disagree about.
 *
 * Returns `{ ok, issues, notes, groups }`. It never writes and never creates a directory.
 */
export function validateConfig(raw = {}) {
  // Fold legacy flat role keys into the modern block before validating, because that is exactly
  // what the runtime does through `normalizeLayout`: a config written in the old spelling works,
  // so validation must not call it invalid. The settings page still requires the modern block,
  // because it is an editor for that block and writes it back - a deliberate asymmetry, and the
  // note below says so rather than leaving the user to guess.
  const deprecated = Object.keys(CONFIG_DEPRECATED_KEYS).filter((key) => raw[key] !== undefined);
  const candidate = { ...raw };
  if (deprecated.length) {
    const roles = { ...(raw.roles && typeof raw.roles === 'object' ? raw.roles : {}) };
    for (const key of deprecated) {
      const role = CONFIG_DEPRECATED_KEYS[key].replace('roles.', '');
      if (roles[role] === undefined) roles[role] = raw[key];
    }
    candidate.roles = roles;
  }

  const { groups, issues, notes } = inspectConfigGroups(candidate, { createRoots: false });
  const allNotes = [...notes];

  // `version` records which release wrote the file, so it stays a string and is never a schema
  // number. The shape of the document is tracked separately by `configSchema` below.
  if (raw.version !== undefined && typeof raw.version !== 'string') {
    issues.push({ field: 'version', message: msg('cli.config.version.notString', { value: JSON.stringify(raw.version) }) });
  }
  // A missing `configSchema` is a note, not an error: a document written before the field
  // existed is still readable, and `config migrate` explains how to add it.
  if (raw.configSchema === undefined) {
    allNotes.push(msg('cli.config.note.schemaMissing', { version: CONFIG_SCHEMA_VERSION }));
  } else if (!Number.isInteger(raw.configSchema)) {
    issues.push({ field: 'configSchema', message: msg('cli.config.schema.notInteger', { value: JSON.stringify(raw.configSchema) }) });
  } else if (raw.configSchema > CONFIG_SCHEMA_VERSION) {
    issues.push({ field: 'configSchema', message: msg('cli.config.schema.newer', { version: raw.configSchema, supported: CONFIG_SCHEMA_VERSION }) });
  }

  // Unknown top-level keys are preserved and reported. Rejecting them would break a store
  // written by a newer build; silently ignoring them would hide a typo like `vaultroot`.
  const known = new Set(CONFIG_KNOWN_KEYS);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) allNotes.push(msg('cli.config.note.unknownKey', { key }));
  }

  // Deprecated flat role keys still feed the role map, so they are not errors - but the caller
  // should know the modern spelling exists.
  for (const key of deprecated) allNotes.push(msg('cli.config.note.deprecatedKey', { key, target: CONFIG_DEPRECATED_KEYS[key] }));

  // One authoritative store root. memoryRoot is the store; vaultRoot is where notes resolve.
  // Code resolves note paths against vaultRoot, so two different values would mean "the store
  // is here but its content is there" - an ambiguity that must be reported, never papered over
  // by picking one silently.
  const memoryRoot = trimText(raw.memoryRoot);
  const vaultRoot = trimText(raw.vaultRoot);
  if (memoryRoot && vaultRoot) {
    const a = path.resolve(memoryRoot);
    const b = path.resolve(vaultRoot);
    if (a !== b) {
      issues.push({
        field: 'memoryRoot',
        message: msg('cli.config.roots.disagree', { a, b }),
      });
    }
  } else if (!memoryRoot && !vaultRoot) {
    issues.push({ field: 'memoryRoot', message: msg('cli.config.roots.bothEmpty') });
  }

  return { ok: issues.length === 0, issues, notes: allNotes, groups, deprecated };
}

// ------------------------------------------------------------------ effective view

const maskPath = (value) => {
  const text = trimText(value);
  if (!text) return '';
  // Keep the shape of the path (drive or root, and the last segment) so a user can recognise
  // which store this is, without printing their full profile path into a shared log.
  const normalized = text.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return text;
  const root = normalized.startsWith('/') ? '/' : `${parts[0]}/`;
  return `${root}…/${parts.at(-1)}`;
};

/**
 * The normalised values the program will actually use, each with where it came from, so
 * `config show --effective` can explain the result instead of echoing the file.
 *
 * `sources` distinguishes an explicit value in the file, a legacy flat key, and a default.
 * Paths are masked unless `revealPaths` is set.
 */
export function effectiveConfigView(raw = {}, { revealPaths = false } = {}) {
  const roles = normalizeLayout(raw);
  const show = (value) => (revealPaths ? trimText(value) : maskPath(value));
  const entries = [];
  const push = (key, value, source, kind = 'text') => {
    entries.push({ key, value: kind === 'path' ? show(value) : value, source, kind });
  };

  // Storage and layout resolve to a default when absent.
  push('storage', trimText(raw.storage) || 'filesystem', raw.storage === undefined ? 'default' : 'file');
  push('layout', trimText(raw.layout) || 'neutral', raw.layout === undefined ? 'default' : 'file');
  const memoryRootFrom = raw.memoryRoot !== undefined ? 'file' : raw.vaultRoot !== undefined ? 'derived from vaultRoot' : 'unset';
  push('memoryRoot', trimText(raw.memoryRoot) || trimText(raw.vaultRoot), memoryRootFrom, 'path');
  const vaultRootFrom = raw.vaultRoot !== undefined ? 'file' : raw.memoryRoot !== undefined ? 'derived from memoryRoot' : 'unset';
  push('vaultRoot', trimText(raw.vaultRoot) || trimText(raw.memoryRoot), vaultRootFrom, 'path');
  push('vaultName', trimText(raw.vaultName), raw.vaultName === undefined ? 'default' : 'file');
  // obsidianCli is a path and can carry a user name; it is masked like the roots.
  push('obsidianCli', trimText(raw.obsidianCli), raw.obsidianCli === undefined ? 'default' : 'file', 'path');
  for (const [key, , min, max] of CONFIG_NUMBER_FIELDS) {
    const value = raw[key];
    push(key, value === undefined ? `(default, ${min}..${max})` : value, value === undefined ? 'default' : 'file', 'number');
  }

  const configuredRoles = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  for (const [role] of CONFIG_ROLE_FIELDS) {
    const explicit = trimText(configuredRoles[role]);
    const legacyKey = Object.entries(CONFIG_DEPRECATED_KEYS).find(([, target]) => target === `roles.${role}`)?.[0];
    const fromLegacy = legacyKey ? trimText(raw[legacyKey]) : '';
    const source = explicit ? 'roles' : fromLegacy ? `legacy ${legacyKey}` : 'default';
    push(`roles.${role}`, roles[role], source);
  }
  return { entries, role: roles.root, deprecated: Object.keys(CONFIG_DEPRECATED_KEYS).filter((key) => raw[key] !== undefined) };
}

// ------------------------------------------------------------------ migration

/**
 * The plan for bringing a document written by an older shape up to the current one.
 * `--dry-run` prints this and writes nothing; the caller decides whether to apply it.
 *
 * Idempotent by construction: a document that already uses the modern spelling produces no
 * changes, so running the plan twice cannot produce two different results.
 */
export function planConfigMigration(raw = {}) {
  const changes = [];
  const next = { ...raw };

  // `version` records which release wrote the file and is left exactly as it is. The shape of
  // the document is tracked by `configSchema`, so a migration never rewrites a release number.
  if (next.configSchema !== CONFIG_SCHEMA_VERSION) {
    const isMissing = next.configSchema === undefined;
    changes.push({
      kind: 'schema',
      field: 'configSchema',
      from: isMissing ? msg('cli.config.value.missing') : JSON.stringify(next.configSchema),
      to: String(CONFIG_SCHEMA_VERSION),
      note: isMissing ? msg('cli.config.migrate.note.schemaMissing') : msg('cli.config.migrate.note.schemaMismatch'),
    });
    next.configSchema = CONFIG_SCHEMA_VERSION;
  }

  // Fold flat legacy role keys into `roles`, then remove the flat key. Both spellings feed the
  // same role today; keeping the flat copy would leave two places that can disagree.
  const roles = { ...(raw.roles && typeof raw.roles === 'object' ? raw.roles : {}) };
  for (const [legacyKey, target] of Object.entries(CONFIG_DEPRECATED_KEYS)) {
    const value = raw[legacyKey];
    if (value === undefined) continue;
    const role = target.replace('roles.', '');
    if (trimText(roles[role])) {
      changes.push({ kind: 'drop-legacy', field: legacyKey, from: JSON.stringify(value), to: msg('cli.config.migrate.toDroppedLegacy', { role }), note: msg('cli.config.migrate.note.legacyWins') });
    } else {
      roles[role] = value;
      changes.push({ kind: 'fold-legacy', field: legacyKey, from: JSON.stringify(value), to: target, note: msg('cli.config.migrate.note.foldLegacy') });
    }
    delete next[legacyKey];
  }
  if (changes.some((change) => change.kind.endsWith('legacy'))) next.roles = roles;

  // A missing store root is derived from the other one, never invented.
  if (!trimText(next.memoryRoot) && trimText(next.vaultRoot)) {
    changes.push({ kind: 'derive', field: 'memoryRoot', from: msg('cli.config.value.missing'), to: next.vaultRoot, note: msg('cli.config.migrate.note.deriveFromVault') });
    next.memoryRoot = next.vaultRoot;
  } else if (!trimText(next.vaultRoot) && trimText(next.memoryRoot)) {
    changes.push({ kind: 'derive', field: 'vaultRoot', from: msg('cli.config.value.missing'), to: next.memoryRoot, note: msg('cli.config.migrate.note.deriveFromMemory') });
    next.vaultRoot = next.memoryRoot;
  }

  // Defaults that init writes, added only when absent.
  for (const [key, value] of [['layout', 'neutral'], ['storage', 'filesystem'], ['vaultName', ''], ['obsidianCli', ''], ['workspaceAliases', {}], ['hook', { codexDeferAdvisory: true }], ['topics', []]]) {
    if (next[key] === undefined) {
      changes.push({ kind: 'default', field: key, from: msg('cli.config.value.missing'), to: JSON.stringify(value), note: msg('cli.config.migrate.note.default') });
      next[key] = value;
    }
  }

  return { changes, next, fromSchema: raw.configSchema === undefined ? null : raw.configSchema, toSchema: CONFIG_SCHEMA_VERSION };
}

/**
 * Apply a migration.
 *
 * The write is the dangerous half, so it is gated four ways: nothing is written when the plan is
 * empty, the migrated document is validated before it is written (a migration must never turn a
 * working file into an invalid one), the exact bytes read are copied to a backup first, and the
 * result is read back and rolled back on any mismatch. A file that changed while the plan was
 * being computed is abandoned rather than overwritten.
 *
 * Returns `{ applied, file, backup, changes }`; `backup` is the rollback path and is reported so
 * the caller can print it.
 */
export function applyConfigMigration(home, { backupDir } = {}) {
  const file = path.join(home, CONFIG_FILE);
  let before;
  try { before = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new ConfigError(`Cannot read ${file}: ${error.message}`); }

  const plan = planConfigMigration(JSON.parse(before));
  if (!plan.changes.length) {
    return { applied: false, file, backup: null, changes: [], reason: msg('cli.config.migrate.alreadyCurrent', { version: CONFIG_SCHEMA_VERSION }) };
  }

  // Validate the result, not just the input: an already-broken document must not be "migrated"
  // into a differently-broken one.
  const report = validateConfig(plan.next);
  if (!report.ok) {
    // The refusal carries the issues themselves beside the sentence built from them: the sentence is
    // what a log sees, and the issues are what a caller renders in the reader's own language.
    // The sentence is rendered in the default locale rather than left as references: an Error
    // carries a string, and a caller that only has `message` (a log, a test) must not see
    // "[object Object]". The issues beside it are what a caller renders in its own language.
    const fallback = makeTranslator(DEFAULT_LOCALE);
    const rendered = report.issues.map((issue) => renderMessages(issue.message, fallback)).join('; ');
    const error = new ConfigError(`The migrated configuration does not validate, so nothing was written: ${rendered}`);
    error.issues = report.issues.map((issue) => issue.message);
    throw error;
  }

  const dir = backupDir ?? path.join(home, 'backups', 'config-migrations');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-config.json`);
  fs.writeFileSync(backup, before, 'utf8');

  // Anything could have touched the file while the plan was computed; never clobber it.
  if (fs.readFileSync(file, 'utf8') !== before) {
    throw new ConfigError('配置文件在迁移过程中被改动，已放弃写入（原文件未变）。');
  }
  atomicJson(file, plan.next);

  let written;
  try { written = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    fs.writeFileSync(file, before, 'utf8');
    throw new ConfigError(`迁移后无法回读，已回滚到写入前的内容：${error.message}`);
  }
  if (JSON.stringify(JSON.parse(written)) !== JSON.stringify(plan.next)) {
    fs.writeFileSync(file, before, 'utf8');
    throw new ConfigError(`迁移写入后校验不一致，已回滚到写入前的内容（备份：${backup}）。`);
  }

  return { applied: true, file, backup, changes: plan.changes };
}
