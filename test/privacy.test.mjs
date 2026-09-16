// Coverage for the collection policy and the privacy lifecycle (PRIV-01).
//
// The plan's acceptance criterion is the one that matters here: a session whose collection is off must
// leave no body text in *any* persistent layer. A switch that only changes what a page renders leaves
// the text on disk, so the central test does not assert that a flag is false — it walks every file the
// run could have written and asserts the text is nowhere, and then repeats the run with collection on
// to prove the search would have found it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processHook } from '../lib/hooks.mjs';
import { drainCheckpoints } from '../lib/checkpoints.mjs';
import { checkpointHealth } from '../lib/checkpoint-audit.mjs';
import { AccessLog } from '../lib/access-log.mjs';
import { loadEvents } from '../lib/core.mjs';
import { sha } from '../lib/transport.mjs';
import {
  DELETION_VOCABULARY, cleanupPreview, matchExclusion, normalizeCollection, previewExclusions,
  privacyView, resolveCollection,
} from '../lib/privacy.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault'), workRoot: 'work', projectRoot: 'work/projects', inboxRoot: 'work/inbox',
    eventsRoot: 'work/events', habitsNote: 'work/habits.md', actionsNote: 'work/actions.md', mistakesNote: 'work/mistakes.md', preferenceCandidatesNote: 'work/candidates.md',
    activeLimit: 6, recentLimit: 6, budgetBytes: 14000, topics: [] };
  for (const dir of ['work/projects', 'work/events', 'work/inbox']) fs.mkdirSync(path.join(config.vaultRoot, dir), { recursive: true });
  fs.mkdirSync(config.policyRoot, { recursive: true });
  fs.writeFileSync(path.join(config.policyRoot, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(config.vaultRoot, config.habitsNote), '# Habits\n' + String.fromCharCode(96).repeat(3) + 'json\n{"rules":[]}\n' + String.fromCharCode(96).repeat(3));
  const transport = {
    create(p, c) { const file = path.join(config.vaultRoot, p); assert.equal(fs.existsSync(file), false); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, c); },
    append(p, c) { fs.appendFileSync(path.join(config.vaultRoot, p), '\n\n' + c); },
    verify(p) { return fs.readFileSync(path.join(config.vaultRoot, p), 'utf8'); },
    managed(p, h, b) { const file = path.join(config.vaultRoot, p); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, h + '\n<!-- AUTO-MANAGED:START -->\n' + b + '\n<!-- AUTO-MANAGED:END -->'); },
  };
  const project = (name) => { const cwd = path.join(root, 'projects', name); fs.mkdirSync(cwd, { recursive: true }); return cwd; };
  const call = (cwd, session, event, extra = {}) => ({ cwd, session_id: session, hook_event_name: event, ...extra });
  return { root, config, transport, project, call };
}

/** Every regular file under a directory. */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Run one ordinary turn through the hook: prompt, a tool call, then Stop. */
function turn(config, f, cwd, session, marker) {
  processHook(config, 'claude', f.call(cwd, session, 'UserPromptSubmit', { prompt: `please inspect ${marker}` }));
  processHook(config, 'claude', f.call(cwd, session, 'PostToolUse', { tool_name: 'Read', tool_input: {}, tool_response: {} }));
  processHook(config, 'claude', f.call(cwd, session, 'Stop', { last_assistant_message: `the reply also mentions ${marker}` }));
}

// ------------------------------------------------------------------ the policy

test('an absent or malformed collection section means collect, exactly as before', () => {
  assert.deepEqual(normalizeCollection(undefined), { enabled: true, hosts: {}, workspaces: {}, exclude: { paths: [], sessionTypes: [], sources: [] }, retention: { contextDays: 30, backups: 5, diagnosticsDays: 14 } });
  // A hand-edited document must never make the program throw, and must never be read as "off" by
  // accident: a typo that silently stopped collection would be its own kind of data loss.
  const messy = normalizeCollection({ enabled: 'no', hosts: 'codex', workspaces: [1, 2], exclude: { paths: ['ok', 7, ''] }, retention: { contextDays: -3, backups: 'x' } });
  assert.equal(messy.enabled, true);
  assert.deepEqual(messy.hosts, {});
  assert.deepEqual(messy.workspaces, {});
  assert.deepEqual(messy.exclude.paths, ['ok']);
  assert.equal(messy.retention.contextDays, 30, 'a negative day count falls back rather than deleting everything');
  assert.equal(messy.retention.backups, 5);
});

test('the global switch is a hard stop that no narrower scope can override', () => {
  const config = { collection: { enabled: false, hosts: { codex: true }, workspaces: { w: true } } };
  const decision = resolveCollection(config, { host: 'codex', workspace: 'w' });
  assert.equal(decision.collecting, false);
  assert.equal(decision.decidedBy, 'global');
});

test('precedence runs exclusion, then workspace, then host, then global', () => {
  const base = { collection: { enabled: true, workspaces: { w: false }, hosts: { codex: false } } };
  assert.equal(resolveCollection(base, { host: 'codex', workspace: 'w' }).decidedBy, 'workspace');
  assert.equal(resolveCollection(base, { host: 'codex', workspace: 'other' }).decidedBy, 'host');
  assert.equal(resolveCollection(base, { host: 'claude', workspace: 'other' }).decidedBy, 'global');
  assert.equal(resolveCollection(base, { host: 'claude', workspace: 'other' }).collecting, true);

  // An explicit denial outranks a broader allow, which is the only ordering in which a user can be
  // sure an exclusion means what it says.
  const excluded = { collection: { enabled: true, hosts: { codex: true }, exclude: { sessionTypes: ['scratch'] } } };
  const decision = resolveCollection(excluded, { host: 'codex', workspace: 'w', sessionType: 'scratch' });
  assert.equal(decision.collecting, false);
  assert.equal(decision.decidedBy, 'exclude:sessionTypes');
  assert.deepEqual(decision.matched, [{ kind: 'sessionTypes', rule: 'scratch' }]);
});

test('a path rule covers the directory itself and its contents, and not a name that merely starts the same', () => {
  const rule = path.join(os.tmpdir(), 'private', 'work');
  assert.equal(matchExclusion('paths', rule, rule), true);
  assert.equal(matchExclusion('paths', rule, path.join(rule, 'deep', 'file.md')), true);
  // The boundary that a prefix comparison gets wrong.
  assert.equal(matchExclusion('paths', rule, path.join(os.tmpdir(), 'private', 'workshop')), false);
  assert.equal(matchExclusion('paths', rule, path.join(os.tmpdir(), 'private')), false);
});

test('session types and sources match the whole value', () => {
  assert.equal(matchExclusion('sessionTypes', 'scratch', 'scratch'), true);
  assert.equal(matchExclusion('sessionTypes', 'scratch', 'scratchpad'), false);
  assert.equal(matchExclusion('sources', 'transcript', 'Transcript'), process.platform === 'win32');
  assert.equal(matchExclusion('sessionTypes', 'scratch', ''), false);
  assert.equal(matchExclusion('sessionTypes', '', 'scratch'), false);
});

test('the exclusion preview evaluates the rules and names the ones nothing matched', () => {
  const config = { collection: { exclude: { paths: [path.join(os.tmpdir(), 'excluded')], sessionTypes: ['scratch'] } } };
  const preview = previewExclusions(config, { paths: [path.join(os.tmpdir(), 'excluded', 'a'), path.join(os.tmpdir(), 'kept')], sessionTypes: ['normal'] });
  const paths = preview.rules.find((row) => row.kind === 'paths');
  assert.deepEqual(paths.matches, [path.join(os.tmpdir(), 'excluded', 'a')]);
  assert.deepEqual(preview.unmatched, [{ kind: 'sessionTypes', rule: 'scratch' }]);
});

test('the effective policy says which scope decided, and states the limit of physical deletion', () => {
  const view = privacyView({ collection: { enabled: true, workspaces: { w: false } } }, { workspace: 'w' });
  assert.equal(view.decision.collecting, false);
  assert.equal(view.decision.decidedBy, 'workspace');
  assert.equal(view.scopes.workspaces.find((row) => row.workspace === 'w').state, 'off');
  assert.equal(view.vocabulary.length, 3);
  assert.deepEqual(view.vocabulary.map((row) => row.state), DELETION_VOCABULARY.map((row) => row.state));
  // The unsupported state is marked unsupported in the payload, not only in prose.
  assert.equal(view.vocabulary.find((row) => row.state === 'physically-deleted').supported, false);
  assert.match(view.permanentDeletion, /物理删除未实现/);
});

test('a cleanup preview deletes nothing and lists what it does not cover', () => {
  const preview = cleanupPreview({ collection: { retention: { contextDays: 7, backups: 2, diagnosticsDays: 3 } } });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.executed, false);
  assert.equal(preview.retention.contextDays, 7);
  assert.match(preview.scope[0].rule, /7 天/);
  assert.ok(preview.notCovered.some((line) => /已写入账本的事件/.test(line)));
  assert.match(preview.note, /没有删除任何文件/);
});

// ------------------------------------------------------------------ acceptance

test('collection off leaves no body text in any persistent layer, and the same turn is collected when it is on', (t) => {
  const marker = 'ZZQ-PRIVATE-BODY-7134';

  // Control: with collection on, the turn really is captured. Without this the search below could
  // pass because the machinery never ran at all.
  const on = fixture(t);
  turn(on.config, on, on.project('visible'), 'visible-session', marker);
  const onHits = [on.config.policyRoot, on.config.vaultRoot].flatMap((root) => walk(root))
    .filter((file) => fs.readFileSync(file, 'utf8').includes(marker));
  assert.ok(onHits.length > 0, 'the control run must capture the text, or the test proves nothing');

  // The same turn, with collection switched off.
  const off = fixture(t);
  const offConfig = { ...off.config, collection: { enabled: false } };
  fs.writeFileSync(path.join(off.config.policyRoot, 'config.json'), JSON.stringify(offConfig));
  turn(offConfig, off, off.project('hidden'), 'hidden-session', marker);

  const leaks = [off.config.policyRoot, off.config.vaultRoot].flatMap((root) => walk(root))
    .filter((file) => fs.readFileSync(file, 'utf8').includes(marker));
  assert.deepEqual(leaks, [], 'no persistent layer may contain text that was not collected');

  // Nothing was queued...
  assert.equal(fs.existsSync(path.join(off.config.policyRoot, 'state/hook-queue')), false);
  assert.equal(loadEvents(offConfig).length, 0);
  // ...and the session file says why, rather than simply looking empty.
  const sessionFile = path.join(off.config.policyRoot, 'state/hook-sessions', sha('claude\0hidden-session').slice(0, 24), 'session.json');
  const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(state.prompt, '');
  assert.equal(state.checkpoint.status, 'skipped');
  assert.equal(state.checkpoint.reason, 'collection-disabled');
  assert.equal(state.checkpoint.decidedBy, 'global');
  assert.equal(state.collection.collecting, false);
});

test('turning collection off also stops checkpoints that were already queued from becoming evidence', (t) => {
  const f = fixture(t);
  const marker = 'ZZQ-QUEUED-BODY-8842';
  const cwd = f.project('queued');
  turn(f.config, f, cwd, 'queued-then-off', marker);

  const queueDir = path.join(f.config.policyRoot, 'state/hook-queue');
  const queued = fs.readdirSync(queueDir).filter((name) => name.endsWith('.json'));
  assert.equal(queued.length, 1, 'the turn must have queued exactly one checkpoint');

  // The switch is turned off before the drain runs. The queue is the gap that matters: without this
  // gate "off" would only mean "off for sessions that start later", while text already on disk kept
  // arriving in the ledger.
  const offConfig = { ...f.config, collection: { enabled: false } };
  const result = drainCheckpoints(offConfig, f.transport);
  assert.equal(result.held, 1);
  assert.equal(result.processed, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(loadEvents(offConfig).length, 0, 'no event may be created after collection is switched off');

  const row = JSON.parse(fs.readFileSync(path.join(queueDir, queued[0]), 'utf8'));
  assert.equal(row.status, 'held');
  assert.equal(row.reason, 'collection-disabled');
  assert.equal(row.decidedBy, 'global');
  // Deferred, not decided — so the health check reports it without calling the store broken, which is
  // what an unexplained red `doctor` would amount to.
  const deferred = checkpointHealth(offConfig, loadEvents(offConfig));
  assert.equal(deferred.held.length, 1);
  assert.equal(deferred.pending.length, 0);
  assert.equal(deferred.invalid.length, 0);
  assert.equal(deferred.healthy, true);

  // And the same queue drains normally once collection is on again: the gate defers, it does not
  // silently discard something the user had already agreed to keep.
  const back = drainCheckpoints(f.config, f.transport);
  assert.equal(back.held, 0);
  assert.equal(back.processed, 1);
  assert.equal(loadEvents(f.config).length, 1);
});

test('the access log stops recording queries for a workspace that opted out', (t) => {
  const f = fixture(t);
  const file = path.join(f.config.policyRoot, 'state/access-log.json');
  const log = new AccessLog(f.config);
  log.record({ kind: 'fact', id: 'a', workspace: 'public', query: 'visible query 5521' });
  assert.match(fs.readFileSync(file, 'utf8'), /visible query 5521/);

  // A per-workspace opt-out is enough: the entry carries the query that produced it, so it is
  // conversation text like any other layer.
  const scoped = { ...f.config, collection: { workspaces: { secret: false } } };
  const scopedLog = new AccessLog(scoped);
  scopedLog.record({ kind: 'fact', id: 'b', workspace: 'secret', query: 'hidden query 5521' });
  scopedLog.record({ kind: 'fact', id: 'c', workspace: 'public', query: 'second visible 5521' });
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /hidden query 5521/);
  assert.match(text, /second visible 5521/, 'the neighbouring workspace is unaffected');

  // A whole-batch write is filtered the same way, since that is how the read path records.
  const globalOff = { ...f.config, collection: { enabled: false } };
  const before = fs.readFileSync(file, 'utf8');
  new AccessLog(globalOff).recordMany([{ kind: 'fact', id: 'd', workspace: 'public', query: 'never written 5521' }]);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a fully gated batch writes nothing at all');
});
