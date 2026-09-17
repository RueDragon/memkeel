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
import { msg } from './messages.mjs';

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
    label: msg('cli.privacy.vocab.notCollected.label'),
    meaning: msg('cli.privacy.vocab.notCollected.meaning'),
    supported: true,
    reversible: msg('cli.privacy.vocab.notCollected.reversible'),
  },
  {
    state: 'retained-not-retrieved',
    label: msg('cli.privacy.vocab.retained.label'),
    meaning: msg('cli.privacy.vocab.retained.meaning'),
    supported: true,
    reversible: msg('cli.privacy.vocab.retained.reversible'),
  },
  {
    state: 'physically-deleted',
    label: msg('cli.privacy.vocab.physical.label'),
    meaning: msg('cli.privacy.vocab.physical.meaning'),
    supported: false,
    reversible: msg('cli.privacy.vocab.physical.reversible'),
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
    return { collecting: false, decidedBy: 'global', reason: msg('cli.privacy.decision.global'), matched };
  }

  // Exclusions are checked before the scope switches: an explicit denial outranks a broader allow.
  const values = { paths: cwd, sessionTypes: sessionType, sources: source };
  for (const kind of EXCLUSION_KINDS) {
    for (const rule of collection.exclude[kind]) {
      if (matchExclusion(kind, rule, values[kind])) {
        matched.push({ kind, rule });
        return { collecting: false, decidedBy: `exclude:${kind}`, reason: msg('cli.privacy.decision.excluded', { kind, rule }), matched };
      }
    }
  }

  if (workspace && collection.workspaces[workspace] === false) {
    return { collecting: false, decidedBy: 'workspace', reason: msg('cli.privacy.decision.workspace', { workspace }), matched };
  }
  if (host && collection.hosts[host] === false) {
    return { collecting: false, decidedBy: 'host', reason: msg('cli.privacy.decision.host', { host }), matched };
  }

  const specific = workspace && collection.workspaces[workspace] === true ? 'workspace'
    : host && collection.hosts[host] === true ? 'host' : 'global';
  return { collecting: true, decidedBy: specific, reason: msg('cli.privacy.decision.collecting'), matched };
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
        note: msg(kind === 'paths' ? 'cli.exclusions.pathsNote' : 'cli.exclusions.exactNote'),
      });
    }
  }
  return {
    version: 1,
    rules: rows,
    unmatched: rows.filter((row) => row.matches.length === 0).map((row) => ({ kind: row.kind, rule: row.rule })),
    note: msg('cli.exclusions.note'),
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
    // The inputs the decision was computed for. Reported so a reader cannot mistake a context-free
    // answer for a statement about their current session: a workspace-level opt-out legitimately
    // does not apply when no workspace was named.
    context: {
      host: context.host ?? null,
      workspace: context.workspace ?? null,
      cwd: context.cwd ?? null,
      sessionType: context.sessionType ?? null,
      source: context.source ?? null,
      scoped: Boolean(context.host || context.workspace || context.cwd || context.sessionType || context.source),
    },
    scopes: {
      global: collection.enabled === false ? 'off' : 'on',
      hosts: Object.entries(collection.hosts).map(([host, on]) => ({ host, state: on ? 'on' : 'off' })),
      workspaces: Object.entries(collection.workspaces).map(([workspace, on]) => ({ workspace, state: on ? 'on' : 'off' })),
      exclusions: EXCLUSION_KINDS.flatMap((kind) => collection.exclude[kind].map((rule) => ({ kind, rule }))),
    },
    // Stated in the payload, not only in the docs: three different things get called "deleted".
    vocabulary: DELETION_VOCABULARY,
    // Said plainly because it is the honest limit of this switch.
    permanentDeletion: msg('cli.privacy.permanentDeletion'),
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
      {
        target: msg('cli.cleanupPreview.contextsTarget'),
        rule: msg('cli.cleanupPreview.contextsRule', { days: collection.retention.contextDays }),
        effect: msg('cli.cleanupPreview.contextsEffect'),
      },
      {
        target: msg('cli.cleanupPreview.backupsTarget'),
        rule: msg('cli.cleanupPreview.backupsRule', { keep: collection.retention.backups }),
        effect: msg('cli.cleanupPreview.backupsEffect'),
      },
      {
        target: msg('cli.cleanupPreview.runtimeTarget'),
        rule: msg('cli.cleanupPreview.runtimeRule', { days: collection.retention.diagnosticsDays }),
        effect: msg('cli.cleanupPreview.runtimeEffect'),
      },
    ],
    notCovered: [
      msg('cli.cleanupPreview.notCovered.ledger'),
      msg('cli.cleanupPreview.notCovered.copied'),
      msg('cli.cleanupPreview.notCovered.hostSessions'),
      msg('cli.cleanupPreview.notCovered.replacements'),
    ],
    note: msg('cli.cleanupPreview.note'),
  };
}
