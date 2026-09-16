// Redacted diagnostic export (PRIV-01, plan item 7).
//
// The purpose of this file is to be safe to hand to someone else. That makes the exclusions the
// design, not a detail: an export that carries the user's absolute paths, their configuration
// credentials or the body of their evidence is not "mostly fine", it is a disclosure. So every field
// is either a count, a version, a boolean, or a value that has been through `redactPath` — and the
// paths that are structurally meaningful (the memory home and the store) are replaced by placeholders
// rather than shortened, because a basename can still identify a person's project.
//
// What is deliberately absent, and stated as absent in the payload so a reader can tell the
// difference between "not collected" and "dropped by accident":
//
//   - no session text, no hook-queue or checkpoint contents;
//   - no note bodies and no event evidence;
//   - no full paths, and no host configuration bytes;
//   - no credentials: `dashboardTokenSecret` and the Obsidian CLI path never leave the process.
import fs from 'node:fs';
import path from 'node:path';
import { loadEvents, loadRoutes } from './core.mjs';
import { normalizeCollection, privacyView } from './privacy.mjs';

export const DIAGNOSTICS_FORMAT = 1;

/** Fields that are dropped outright rather than shortened. */
export const DIAGNOSTICS_DROPPED_FIELDS = Object.freeze(['dashboardTokenSecret', 'obsidianCli']);

export const DIAGNOSTICS_POLICY = Object.freeze([
  { excluded: '会话正文与提示词', detail: 'hook 队列、检查点与会话状态文件的内容一律不导出。' },
  { excluded: '证据与笔记正文', detail: '只导出计数，不导出任何事件证据或笔记内容。' },
  { excluded: '完整路径', detail: 'memory home 与 store 替换为占位符，其余绝对路径只保留最后一段。' },
  { excluded: '凭据', detail: `以下字段整体丢弃：${DIAGNOSTICS_DROPPED_FIELDS.join('、')}。` },
]);

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Replace a path with something that still explains its role without identifying the machine.
 *
 * The memory home and the store become fixed placeholders — a diagnostic reader needs to know *which*
 * root a path belonged to, and nothing more. Anything else keeps only its last segment, prefixed so
 * it is obvious that something was removed.
 */
export function redactPath(value, { home, store } = {}) {
  if (typeof value !== 'string' || !value.trim()) return '';
  // A relative value is a layout name (`work/events`), not a location on this machine, so it carries
  // nothing that identifies the user. Tested before resolving, because `path.resolve` would turn it
  // into an absolute path and erase exactly the distinction that matters.
  if (!path.isAbsolute(value)) return value.replaceAll('\\', '/');
  const resolved = path.resolve(value);
  // The most specific root wins, because a store nested inside the home is still the store and saying
  // `<memory-home>` about it would hide which root the path actually belonged to.
  const candidates = [];
  if (home && inside(resolved, path.resolve(home))) candidates.push({ root: path.resolve(home), label: '<memory-home>' });
  if (store && inside(resolved, path.resolve(store))) candidates.push({ root: path.resolve(store), label: '<store>' });
  if (candidates.length) return candidates.sort((a, b) => b.root.length - a.root.length)[0].label;
  const base = path.basename(resolved);
  return base ? `…/${base}` : '…';
}

/** The configuration with credentials removed and every path reduced to a placeholder. */
export function redactConfig(config = {}) {
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    if (DIAGNOSTICS_DROPPED_FIELDS.includes(key)) continue;
    out[key] = value;
  }
  for (const key of ['policyRoot', 'vaultRoot', 'memoryRoot']) {
    if (key in out) out[key] = redactPath(out[key], { home: config.policyRoot, store: config.vaultRoot });
  }
  // `roles.root` is the store root in absolute form, so it is a path like any other. A role that is
  // relative (`events`, `topics`) is a layout name rather than a location and is left alone.
  if (out.roles && typeof out.roles === 'object') {
    out.roles = Object.fromEntries(Object.entries(out.roles)
      .map(([key, value]) => [key, typeof value === 'string' && path.isAbsolute(value)
        ? redactPath(value, { home: config.policyRoot, store: config.vaultRoot }) : value]));
  }
  if (out.workspaceAliases && typeof out.workspaceAliases === 'object') {
    out.workspaceAliases = Object.fromEntries(Object.entries(out.workspaceAliases)
      .map(([id, list]) => [id, Array.isArray(list) ? list.map((entry) => redactPath(entry, { home: config.policyRoot, store: config.vaultRoot })) : []]));
  }
  return out;
}

/**
 * Build the export in memory. No filesystem writes happen here, so the caller can inspect it first.
 */
export function buildDiagnostics(config = {}, { version = '', now = new Date().toISOString() } = {}) {
  const home = config.policyRoot;
  const store = config.vaultRoot;
  let events = [];
  let routes = [];
  const problems = [];
  try { events = loadEvents(config); } catch (error) { problems.push({ area: 'events', message: error.message }); }
  try { routes = loadRoutes(config); } catch (error) { problems.push({ area: 'routes', message: error.message }); }

  const queueRoot = home ? path.join(home, 'state/hook-queue') : '';
  let checkpoints = { pending: 0, held: 0, consumed: 0, other: 0 };
  if (queueRoot && fs.existsSync(queueRoot)) {
    checkpoints = { pending: 0, held: 0, consumed: 0, other: 0 };
    for (const name of fs.readdirSync(queueRoot)) {
      if (!name.endsWith('.json')) continue;
      let row;
      try { row = JSON.parse(fs.readFileSync(path.join(queueRoot, name), 'utf8')); } catch { checkpoints.other += 1; continue; }
      if (row.status === 'pending') checkpoints.pending += 1;
      else if (row.status === 'held') checkpoints.held += 1;
      else if (row.status === 'consumed') checkpoints.consumed += 1;
      else checkpoints.other += 1;
    }
  }

  const collection = normalizeCollection(config.collection);
  const workspaces = new Set([...events.map((event) => event.workspace), ...routes.map((route) => route.id)].filter(Boolean));

  return {
    format: DIAGNOSTICS_FORMAT,
    at: now,
    // Versions and platform identity are what a bug report actually needs.
    runtime: {
      memkeel: version,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    counts: {
      events: events.length,
      topics: Array.isArray(config.topics) ? config.topics.length : 0,
      catalogTopics: Array.isArray(config.catalogTopics) ? config.catalogTopics.length : 0,
      workspaces: workspaces.size,
      routes: routes.length,
      facts: events.reduce((sum, event) => sum + (Array.isArray(event.facts) ? event.facts.length : 0), 0),
      contexts: events.reduce((sum, event) => sum + (Array.isArray(event.contexts) ? event.contexts.length : 0), 0),
      actions: events.reduce((sum, event) => sum + (Array.isArray(event.actions) ? event.actions.length : 0), 0),
      checkpointQueue: checkpoints,
    },
    // Counted, never quoted: how many evidence citations exist is diagnostic, what they say is not.
    evidenceCitations: events.reduce((sum, event) => sum + (Array.isArray(event.evidence) ? event.evidence.length : 0), 0),
    config: redactConfig(config),
    collection: {
      enabled: collection.enabled,
      hosts: collection.hosts,
      workspaces: collection.workspaces,
      exclusionCounts: Object.fromEntries(Object.entries(collection.exclude).map(([kind, rules]) => [kind, rules.length])),
      retention: collection.retention,
      // The *rules* are not exported, only how many there are: a rule is a path, and a path is what
      // this file exists to avoid disclosing.
      effective: privacyView(config).decision,
    },
    problems,
    excluded: DIAGNOSTICS_POLICY,
    note: '这是脱敏诊断导出：不含会话正文、证据正文、完整路径与凭据。计数器是准确的，被省略的内容是明说的。',
  };
}

/**
 * Write the export to a file the user names.
 *
 * Refuses to overwrite an existing file: a diagnostic export is cheap to regenerate and expensive to
 * lose, and "the file was already there" is not something to discover after the fact.
 */
export function writeDiagnostics(target, bundle) {
  if (!target || typeof target !== 'string') throw new Error('A diagnostics export needs a destination file (--out FILE)');
  const file = path.resolve(target);
  if (fs.existsSync(file)) throw new Error(`Refusing to overwrite an existing file: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows has no POSIX mode */ }
  return { file, bytes: fs.statSync(file).size };
}

/**
 * Every string in the payload, including object keys.
 *
 * Collecting the values rather than searching the serialized text is not a stylistic choice: on
 * Windows `JSON.stringify` doubles every backslash, so `text.includes(home)` compares the
 * single-escaped and double-escaped spellings of the same path and never matches. An audit that is
 * blind to the platform it runs on is worse than no audit, because it reports `clean`.
 */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) { for (const item of value) collectStrings(item, out); }
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { out.push(key); collectStrings(item, out); }
  }
  return out;
}

/**
 * The last line of defence: does this payload actually contain anything it promised not to?
 *
 * The export is meant to be safe by construction, but a promise about disclosure deserves a check
 * that runs on the real values rather than a comment that asserts it.
 */
export function auditDiagnostics(payload, { home, store, extraStrings = [] } = {}) {
  const strings = typeof payload === 'string' ? [payload] : collectStrings(payload);
  const text = strings.join('\n');
  const leaks = [];
  for (const [label, value] of [['memory home', home], ['store', store], ...extraStrings.map((value, index) => [`extra #${index + 1}`, value])]) {
    if (typeof value === 'string' && value.trim() && strings.some((entry) => entry.includes(value))) leaks.push({ label, value: '<redacted>' });
  }
  // A dropped field must not reappear under its own name as a key.
  for (const field of DIAGNOSTICS_DROPPED_FIELDS) if (strings.includes(field)) leaks.push({ label: `field ${field}`, value: '<redacted>' });
  for (const pattern of [/\bsk-[A-Za-z0-9_-]{12,}/, /Bearer\s+[A-Za-z0-9._-]{12,}/, /(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*["']?\s*[:=]\s*[^\s,;"]+/i]) {
    if (pattern.test(text)) leaks.push({ label: 'credential-like value', value: '<redacted>' });
  }
  return { clean: leaks.length === 0, leaks };
}
