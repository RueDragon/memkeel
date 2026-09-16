// Collection policy (PRIV-01).
//
// The plan's requirement is blunt and worth restating, because it is the whole reason this module
// exists: turning collection off must cover the hook queue, checkpoints, evidence, logs and
// historical ingest — "not just hide the UI". A switch that only changes what a page renders leaves
// the text on disk, which is worse than no switch at all, because it claims a guarantee it does not
// provide. So this module answers one question, once, for every layer that writes conversation text:
//
//     may this conversation be collected, and who decided that?
//
// Four scopes decide it, and the precedence is deliberately ordered so the answer can only ever get
// more private, never less:
//
//   1. `enabled: false` is a hard stop. Nothing below it re-enables collection. A global off switch
//      that a stale per-host entry could override would be a trap, not a feature.
//   2. An exclusion rule that matches wins. An explicit denial is the most specific statement a user
//      can make about a path, a session type or a source.
//   3. `workspaces[<id>] === false` stops that workspace.
//   4. `hosts[<host>] === false` stops that host.
//
// `true` values are accepted so a config can state its intent, but they never override a broader
// denial — that is the point of the ordering above.
//
// Matching is exact, not fuzzy, and each kind says what it means: a `paths` rule matches the path
// itself or anything inside it; `sessionTypes` and `sources` match the whole value. No globs, no
// substring surprises, and `previewExclusions` evaluates the rules against real values so the answer
// is inspectable before it is trusted.
import path from 'node:path';

export const COLLECTION_DEFAULTS = Object.freeze({
  enabled: true,
  hosts: {},
  workspaces: {},
  exclude: { paths: [], sessionTypes: [], sources: [] },
  retention: { contextDays: 30, backups: 5, diagnosticsDays: 14 },
});

export const EXCLUSION_KINDS = Object.freeze(['paths', 'sessionTypes', 'sources']);

// The three states the plan asks to be kept apart. They are separate words because confusing them is
// how a user ends up believing a record is gone when it is merely unlisted.
export const DELETION_VOCABULARY = Object.freeze([
  {
    state: 'not-collected',
    label: '不采集',
    meaning: '这段会话根本没有被写入。没有队列条目、没有检查点、没有证据、没有访问日志。',
    supported: true,
    reversible: 'nothing to reverse',
  },
  {
    state: 'retained-not-retrieved',
    label: '软删除 / 不参与检索',
    meaning: '原始记录仍然完整存在于账本里，只是不再进入默认摘要与普通召回。历史与来源仍可追溯。',
    supported: true,
    reversible: 'yes — 记录一直在，恢复检索只是改回策略',
  },
  {
    state: 'physically-deleted',
    label: '物理删除',
    meaning: '把已写入的事件从账本中真正抹掉。本程序不提供：账本是只追加的、事件带校验的不可变记录，就地删除会破坏它自身的完整性，也无法收回已经产生的备份与外部同步副本。',
    supported: false,
    reversible: 'no',
  },
]);

function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asStringArray(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : []; }

/** Fold anything a hand-edited config may contain into the documented shape. Never throws. */
export function normalizeCollection(raw) {
  const source = asObject(raw);
  const exclude = asObject(source.exclude);
  const retention = asObject(source.retention);
  const limits = {};
  for (const [key, fallback] of Object.entries(COLLECTION_DEFAULTS.retention)) {
    const value = Number(retention[key]);
    limits[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  }
  const booleans = (value) => Object.fromEntries(Object.entries(asObject(value))
    .filter(([, flag]) => typeof flag === 'boolean'));
  return {
    enabled: source.enabled === false ? false : true,
    hosts: booleans(source.hosts),
    workspaces: booleans(source.workspaces),
    exclude: Object.fromEntries(EXCLUSION_KINDS.map((kind) => [kind, asStringArray(exclude[kind])])),
    retention: limits,
  };
}

/** Case-insensitive only where the filesystem is, so a rule cannot match by accident on Linux. */
function fold(value) {
  const text = String(value ?? '').trim();
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Does one rule of this kind match this value?
 *
 * `paths` matches the directory itself or anything under it; the other kinds match the whole value.
 * The distinction is stated here rather than left to the caller because "which paths are excluded"
 * has to have exactly one answer.
 */
export function matchExclusion(kind, rule, value) {
  if (typeof rule !== 'string' || !rule.trim() || value === undefined || value === null || value === '') return false;
  if (kind === 'paths') {
    const candidate = path.resolve(String(value));
    const target = path.resolve(rule.trim());
    return inside(fold(candidate), fold(target));
  }
  return fold(rule) === fold(value);
}

/**
 * The one decision every write layer asks for.
 *
 * Returns `{ collecting, decidedBy, reason, matched }`. `decidedBy` names the scope that decided, so
 * a user can see *why* something was not collected instead of guessing — an off switch with no
 * explanation is indistinguishable from a bug.
 */
export function resolveCollection(config, { host, workspace, cwd, sessionType, source } = {}) {
  const collection = normalizeCollection(config?.collection);
  const matched = [];

  if (collection.enabled === false) {
    return { collecting: false, decidedBy: 'global', reason: '全局采集开关已关闭（collection.enabled = false）', matched };
  }

  // Exclusions are checked before the scope switches: an explicit denial outranks a broader allow.
  const values = { paths: cwd, sessionTypes: sessionType, sources: source };
  for (const kind of EXCLUSION_KINDS) {
    for (const rule of collection.exclude[kind]) {
      if (matchExclusion(kind, rule, values[kind])) {
        matched.push({ kind, rule });
        return { collecting: false, decidedBy: `exclude:${kind}`, reason: `排除规则命中：${kind} = ${rule}`, matched };
      }
    }
  }

  if (workspace && collection.workspaces[workspace] === false) {
    return { collecting: false, decidedBy: 'workspace', reason: `工作区 ${workspace} 的采集开关已关闭`, matched };
  }
  if (host && collection.hosts[host] === false) {
    return { collecting: false, decidedBy: 'host', reason: `宿主 ${host} 的采集开关已关闭`, matched };
  }

  const specific = workspace && collection.workspaces[workspace] === true ? 'workspace'
    : host && collection.hosts[host] === true ? 'host' : 'global';
  return { collecting: true, decidedBy: specific, reason: '采集开启', matched };
}

/**
 * Evaluate every rule against supplied values, so the semantics can be inspected before they are
 * relied on. A rule that matches nothing is reported as such rather than quietly kept.
 */
export function previewExclusions(config, samples = {}) {
  const collection = normalizeCollection(config?.collection);
  const rows = [];
  for (const kind of EXCLUSION_KINDS) {
    const candidates = Array.isArray(samples[kind]) ? samples[kind] : samples[kind] === undefined ? [] : [samples[kind]];
    for (const rule of collection.exclude[kind]) {
      const hits = candidates.filter((value) => matchExclusion(kind, rule, value));
      rows.push({
        kind,
        rule,
        matches: hits,
        note: kind === 'paths'
          ? '匹配该目录本身及其内部的所有路径'
          : '整值精确匹配（大小写按平台规则）',
      });
    }
  }
  return {
    version: 1,
    rules: rows,
    unmatched: rows.filter((row) => row.matches.length === 0).map((row) => ({ kind: row.kind, rule: row.rule })),
    note: '未命中的规则不是错误：它只说明本次给出的样本没有落在该规则下。',
  };
}

/** The effective policy, for the CLI and the settings page to render the same answer. */
export function privacyView(config, context = {}) {
  const collection = normalizeCollection(config?.collection);
  const decision = resolveCollection(config, context);
  return {
    version: 1,
    collection,
    decision,
    scopes: {
      global: collection.enabled === false ? 'off' : 'on',
      hosts: Object.entries(collection.hosts).map(([host, on]) => ({ host, state: on ? 'on' : 'off' })),
      workspaces: Object.entries(collection.workspaces).map(([workspace, on]) => ({ workspace, state: on ? 'on' : 'off' })),
      exclusions: EXCLUSION_KINDS.flatMap((kind) => collection.exclude[kind].map((rule) => ({ kind, rule }))),
    },
    // Stated in the payload, not only in the docs: three different things get called "deleted".
    vocabulary: DELETION_VOCABULARY,
    // Said plainly because it is the honest limit of this switch.
    permanentDeletion: '物理删除未实现，且不是配置开关能提供的能力：账本只追加，事件带校验；就地删除会破坏其完整性，也无法收回已产生的备份与外部同步副本。请用「不采集」阻止写入，用保留策略让派生材料过期，并在采集前就把敏感目录排除。',
  };
}

/**
 * What a cleanup *would* touch. Preview only — this module never deletes anything.
 *
 * Physical removal of ledger events is deliberately absent (see `privacyView.permanentDeletion`), so
 * the honest deliverable is an accurate scope statement rather than a destructive command that
 * cannot keep its promise.
 */
export function cleanupPreview(config, context = {}) {
  const collection = normalizeCollection(config?.collection);
  const decision = resolveCollection(config, context);
  return {
    version: 1,
    dryRun: true,
    executed: false,
    decision,
    retention: collection.retention,
    scope: [
      { target: '短期任务上下文（contexts）', rule: `超过 ${collection.retention.contextDays} 天转为休眠、仅历史可查`, effect: '不移除事件；只是不再进入默认注入' },
      { target: '备份归档', rule: `仅保留最近 ${collection.retention.backups} 份`, effect: '本命令不会删除任何归档，需要你自己清理' },
      { target: '诊断日志', rule: `保留 ${collection.retention.diagnosticsDays} 天`, effect: '不含会话正文；导出默认已脱敏' },
    ],
    notCovered: [
      '已写入账本的事件（不可变、只追加）。',
      '已经复制出去的备份、快照与外部同步副本。',
      '宿主自己的会话记录文件——它们由宿主管理，本程序只读不写。',
    ],
    note: '只读预览：没有删除任何文件。',
  };
}
