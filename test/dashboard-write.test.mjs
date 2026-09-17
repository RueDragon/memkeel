import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../dashboard.mjs';
import { applyLayout } from '../lib/layout.mjs';
import { createTransport } from '../lib/storage/index.mjs';
import { ensureWorkspace, record, loadEvents, reduceEvents } from '../lib/core.mjs';
import { makeToken, verifyToken, planCloseAction, stateFingerprint } from '../lib/dashboard-actions.mjs';
import { readManualHabits, preferenceProjection } from '../lib/preferences.mjs';
import { inside } from '../lib/transport.mjs';
import { isMessageReference, makeTranslator, renderMessages } from '../lib/messages.mjs';

// A refusal carries the issues it was built from rather than a sentence, so an assertion about
// wording renders them the way the settings page does. The locale is pinned for determinism.
const zhT = makeTranslator('zh-Hans');
const enT = makeTranslator('en');
const zh = (value) => renderMessages(value, zhT);
const en = (value) => renderMessages(value, enT);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  const policyRoot = path.join(root, 'policy');
  for (const dir of ['events', 'topics', 'projects', 'digest']) fs.mkdirSync(path.join(vaultRoot, dir), { recursive: true });
  fs.mkdirSync(policyRoot, { recursive: true });
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });

  const config = applyLayout({ memoryRoot: vaultRoot, vaultRoot, policyRoot, storage: 'filesystem', layout: 'neutral', vaultName: '', obsidianCli: '', topics: [], workspaceAliases: {} });
  fs.writeFileSync(path.join(policyRoot, 'config.json'), JSON.stringify(config, null, 2));
  const transport = createTransport(config);
  transport.create('habits.md', '# Habits\n\n```json\n{"rules":[]}\n```\n');
  transport.create('digest/evidence.md', '---\ntype: session-closeout\ndate: 2026-09-01\n---\n# Evidence\n\nUser said: always verify the write.\n');

  const route = ensureWorkspace(config, transport, projectDir);
  const topic = { id: `${route.id}/rules`, workspace: route.id, title: 'Rules', aliases: [], path: `topics/${route.id}--rules.md` };
  const persisted = JSON.parse(fs.readFileSync(path.join(policyRoot, 'config.json'), 'utf8'));
  persisted.topics.push(topic);
  fs.writeFileSync(path.join(policyRoot, 'config.json'), JSON.stringify(persisted, null, 2));
  config.topics = persisted.topics;

  record(config, transport, {
    event_id: 'write-fixture-0001',
    workspace: route.id, topic: topic.id, agent: 'fixture',
    occurred_at: '2026-09-01T00:00:00+08:00',
    evidence: ['digest/evidence.md'],
    actions: [{ id: 'todo-one', status: 'open', text: 'Close me from the dashboard' }],
    preferences: [{ id: 'prefer-verify', status: 'candidate', scope: route.id, text: 'Always verify the write' }],
    facts: [{ key: 'revise-me', text: 'original value' }],
  });

  const loader = () => applyLayout({ ...JSON.parse(fs.readFileSync(path.join(policyRoot, 'config.json'), 'utf8')), policyRoot });
  return { transport, loader, route, topic };
}

async function withServer(loader, fn) {
  const server = createServer(loader);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const post = (base, route, body) => fetch(`${base}/api/write/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('preview returns a plan and token without writing anything', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const before = loadEvents(loader()).length;
    const res = await post(base, 'close-action/preview', { topic: 'fixture', actionId: 'todo-one' }).catch(() => null);
    // topic id is dynamic; resolve it from the fixture instead.
    const config = loader();
    const topic = config.topics[0].id;
    const ok = await post(base, 'close-action/preview', { topic, actionId: 'todo-one' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.token);
    assert.ok(body.fingerprint);
    assert.equal(body.plan.kind, 'close-action');
    assert.equal(loadEvents(config).length, before, 'preview must not write');
  });
});

test('execute closes the action through a real event', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const preview = await (await post(base, 'close-action/preview', { topic, actionId: 'todo-one' })).json();
    const result = await (await post(base, 'execute', {
      action: 'close-action', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token,
    })).json();
    assert.ok(result.event_id);
    const projection = reduceEvents(loadEvents(config));
    const action = projection.actions.find((row) => row.id === 'todo-one');
    assert.equal(action.status, 'done');
  });
});

test('a stale fingerprint is rejected instead of writing', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const preview = await (await post(base, 'close-action/preview', { topic, actionId: 'todo-one' })).json();
    // Simulate an intervening write by mutating the fingerprint the client sends.
    const res = await post(base, 'execute', { action: 'close-action', plan: preview.plan, fingerprint: 'deadbeef', token: preview.token });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /State changed since preview|different state/);
  });
});

test('a tampered plan is rejected even with a valid token', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const preview = await (await post(base, 'close-action/preview', { topic, actionId: 'todo-one' })).json();
    const tampered = { ...preview.plan, actionId: 'todo-one', text: 'tampered text' };
    const res = await post(base, 'execute', { action: 'close-action', plan: tampered, fingerprint: preview.fingerprint, token: preview.token });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /does not match the previewed payload/);
  });
});

test('compose-event preview validates and execute appends a new action', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const before = loadEvents(config).length;
    const previewRes = await post(base, 'compose-event/preview', {
      kind: 'action', topic, text: 'Compose a brand new todo', evidence: ['digest/evidence.md'],
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    assert.equal(preview.plan.kind, 'compose-event');
    assert.equal(loadEvents(config).length, before, 'preview must not write');
    const exec = await (await post(base, 'execute', {
      action: 'compose-event', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token,
    })).json();
    assert.ok(exec.event_id);
    const projection = reduceEvents(loadEvents(config));
    assert.equal(projection.actions.filter((a) => a.text === 'Compose a brand new todo').length, 1);
  });
});

test('compose-event refuses an event with no evidence', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const res = await post(base, 'compose-event/preview', { kind: 'action', topic, text: 'No evidence here', evidence: [] });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /evidence/i);
  });
});

test('compose-event refuses an evidence path that does not exist', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const res = await post(base, 'compose-event/preview', { kind: 'action', topic, text: 'Bad evidence', evidence: ['does/not/exist.md'] });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /Missing evidence/i);
  });
});

test('an expired token is refused', async (t) => {
  const { loader } = fixture(t);
  const config = loader();
  const events = loadEvents(config);
  const projection = reduceEvents(events);
  const plan = planCloseAction(config, projection, { topic: config.topics[0].id, actionId: 'todo-one' });
  const token = makeToken(config, { action: 'close-action', plan, fingerprint: stateFingerprint(config, events), now: Date.now() - 11 * 60 * 1000 });
  assert.throws(() => verifyToken(config, token), /expired/);
});

test('a token signed with another secret is refused', async (t) => {
  const { loader } = fixture(t);
  const config = loader();
  const events = loadEvents(config);
  const plan = planCloseAction(config, reduceEvents(events), { topic: config.topics[0].id, actionId: 'todo-one' });
  const forged = makeToken({ ...config, dashboardTokenSecret: 'other' }, { action: 'close-action', plan, fingerprint: stateFingerprint(config, events) });
  assert.throws(() => verifyToken(config, forged), /signature mismatch/);
});

test('a plan summary travels as a reference that the dialog renders', async (t) => {
  const { loader } = fixture(t);
  const config = loader();
  const plan = planCloseAction(config, reduceEvents(loadEvents(config)), { topic: config.topics[0].id, actionId: 'todo-one' });
  // A plan summary is shown in the confirmation dialog and is never written to the ledger, so it is
  // a reference: a plain string here would be a hardcoded language again and the dialog would have
  // nothing to render. Both halves are pinned - that it is a reference, and that it resolves in
  // either language.
  assert.ok(isMessageReference(plan.summary), JSON.stringify(plan.summary));
  assert.match(zh(plan.summary), /^关闭待办：/);
  assert.match(en(plan.summary), /^Close action: /);
});

test('habit rejection needs no quote, confirmation does', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const manual = readManualHabits(fs.readFileSync(inside(config.vaultRoot, config.habitsNote), 'utf8'));
    const prefs = preferenceProjection(loadEvents(config), manual);
    const candidate = prefs.candidates.find((row) => row.id === 'prefer-verify');
    const rejectPreview = await (await post(base, 'habit-decision/preview', {
      candidateEvent: candidate.source_event, preferenceId: 'prefer-verify', decision: 'rejected',
    })).json();
    assert.equal(rejectPreview.plan.requiresUserQuote, false);
    const rejected = await (await post(base, 'execute', {
      action: 'habit-decision', plan: rejectPreview.plan.plan, fingerprint: rejectPreview.fingerprint, token: rejectPreview.token,
    })).json();
    assert.ok(rejected.event_id);

    // A confirmation with no quote must be refused at execute time.
    const confirmPreview = await (await post(base, 'habit-decision/preview', {
      candidateEvent: candidate.source_event, preferenceId: 'prefer-verify', decision: 'confirmed',
    })).json();
    const res = await post(base, 'execute', {
      action: 'habit-decision', plan: confirmPreview.plan.plan, fingerprint: confirmPreview.fingerprint, token: confirmPreview.token,
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /require the user quote/);
  });
});

test('a quote absent from the evidence cannot confirm a habit', async (t) => {
  const { loader, } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const candidate = preferenceProjection(loadEvents(config), []).candidates.find((row) => row.id === 'prefer-verify');
    const preview = await (await post(base, 'habit-decision/preview', {
      candidateEvent: candidate.source_event, preferenceId: 'prefer-verify', decision: 'confirmed', userQuote: 'this quote is not in the evidence file',
    })).json();
    const res = await post(base, 'execute', {
      action: 'habit-decision', plan: preview.plan.plan, fingerprint: preview.fingerprint, token: preview.token,
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /quote is absent|must exist/i);
  });
});

test('changing the quote after preview invalidates the token and requires a fresh preview', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const candidate = preferenceProjection(loadEvents(config), []).candidates.find((row) => row.id === 'prefer-verify');
    const first = await (await post(base, 'habit-decision/preview', {
      candidateEvent: candidate.source_event, preferenceId: 'prefer-verify', decision: 'confirmed', userQuote: 'first wording',
    })).json();
    // Executing a plan whose quote differs from the one the token signed must fail,
    // which is why the UI re-previews after the user types their quote.
    const res = await post(base, 'execute', {
      action: 'habit-decision',
      plan: { ...first.plan.plan, userQuote: 'different wording' },
      fingerprint: first.fingerprint,
      token: first.token,
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /does not match the previewed payload/);
  });
});

// --- Revision / retirement / conflict resolution -------------------------------------

test('revise-fact appends a superseding event and leaves no conflict', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const before = reduceEvents(loadEvents(config)).facts.find((f) => f.key === 'revise-me');
    const preview = await (await post(base, 'revise-fact/preview', {
      topic, key: 'revise-me', text: 'revised value', expectedEvent: before.event_id,
    })).json();
    assert.equal(preview.plan.kind, 'revise-fact');
    const exec = await (await post(base, 'execute', {
      action: 'revise-fact', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token,
    })).json();
    assert.ok(exec.event_id);
    const projection = reduceEvents(loadEvents(config));
    assert.equal(projection.facts.find((f) => f.key === 'revise-me').text, 'revised value');
    assert.equal(projection.conflicts.length, 0, 'an explicit supersede must not create a conflict');
  });
});

test('revise-fact refuses a stale expectedEvent', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const res = await post(base, 'revise-fact/preview', { topic, key: 'revise-me', text: 'new', expectedEvent: 'some-other-event-id' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /changed since it was opened/);
  });
});

test('retiring a fact removes it from the active view but keeps the event', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const current = reduceEvents(loadEvents(config)).facts.find((f) => f.key === 'revise-me');
    const preview = await (await post(base, 'revise-fact/preview', {
      topic, key: 'revise-me', retire: true, expectedEvent: current.event_id,
    })).json();
    const exec = await (await post(base, 'execute', {
      action: 'revise-fact', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token,
    })).json();
    const projection = reduceEvents(loadEvents(config));
    assert.equal(projection.facts.find((f) => f.key === 'revise-me'), undefined, 'retired fact leaves the active view');
    const retireEvent = loadEvents(config).find((e) => e.event_id === exec.event_id);
    assert.equal(retireEvent.facts[0].status, 'invalidated');
    assert.equal(retireEvent.facts[0].supersedes, current.event_id, 'history stays linked');
  });
});

test('resolving a conflict clears it and keeps the chosen value', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    // Two disagreeing facts create a conflict; adopting the incoming one supersedes the
    // currently retained event.
    const transport = createTransport(config);
    record(config, transport, {
      event_id: 'conflict-incoming-0002', workspace: config.topics[0].workspace, topic, agent: 'fixture',
      occurred_at: '2026-09-02T00:00:00+08:00', evidence: ['digest/evidence.md'],
      facts: [{ key: 'revise-me', text: 'a different claim' }],
    });
    let projection = reduceEvents(loadEvents(config));
    assert.equal(projection.conflicts.length, 1);
    const conflict = projection.conflicts[0];
    const preview = await (await post(base, 'revise-fact/preview', {
      topic, key: 'revise-me', text: conflict.incoming.text, expectedEvent: conflict.current.event_id,
    })).json();
    await post(base, 'execute', { action: 'revise-fact', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token });
    projection = reduceEvents(loadEvents(config));
    assert.equal(projection.conflicts.length, 0, 'an explicit choice ends the disagreement');
    assert.equal(projection.facts.find((f) => f.key === 'revise-me').text, 'a different claim');
  });
});

test('revise-learning supersedes a context and supports retirement', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const transport = createTransport(config);
    record(config, transport, {
      event_id: 'context-original-0001', workspace: config.topics[0].workspace, topic, agent: 'fixture',
      occurred_at: '2026-09-03T00:00:00+08:00', evidence: ['digest/evidence.md'],
      contexts: [{ id: 'ctx-one', task: 'a task', text: 'context v1', ttl_days: 7, certainty: 'reported' }],
    });
    const preview = await (await post(base, 'revise-learning/preview', {
      type: 'contexts', topic, id: 'ctx-one', text: 'context v2', expectedEvent: 'context-original-0001',
    })).json();
    assert.equal(preview.plan.kind, 'revise-learning');
    await post(base, 'execute', { action: 'revise-learning', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token });
    const events = loadEvents(config);
    const updated = events.flatMap((e) => e.contexts ?? []).filter((c) => c.id === 'ctx-one');
    assert.equal(updated.length, 2);
    assert.equal(updated[1].text, 'context v2');
    assert.equal(updated[1].supersedes, 'context-original-0001');
  });
});

test('revise-action updates the text of an existing action', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const topic = config.topics[0].id;
    const before = reduceEvents(loadEvents(config)).actions.find((a) => a.id === 'todo-one');
    const preview = await (await post(base, 'revise-action/preview', {
      topic, actionId: 'todo-one', text: 'A clearer todo', expectedEvent: before.event_id,
    })).json();
    await post(base, 'execute', { action: 'revise-action', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token });
    const action = reduceEvents(loadEvents(config)).actions.find((a) => a.id === 'todo-one');
    assert.equal(action.text, 'A clearer todo');
    assert.equal(action.status, 'open', 'a text revision must not close the action');
  });
});

test('revoke-habit refuses a rule that is not backed by an event decision', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const res = await post(base, 'revoke-habit/preview', { preferenceId: 'no-such-event-rule' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /not a rule an event confirmed|not found/i);
    // When the sentence is the one this page words itself, it travels as a reference beside the
    // string, so the page can render it in the reader's language instead of the server's.
    if (/not a rule an event confirmed/i.test(body.error)) assert.match(zh(body.ref), /不是事件确认的规则/);
  });
});

// --- Settings: editing the one config file -------------------------------------------

const ROLE_KEYS = ['eventsRoot', 'topicsRoot', 'projectRoot', 'habitsNote', 'actionsNote', 'mistakesNote', 'candidatesNote', 'experienceNote', 'inboxRoot'];
const ROLE_DEFAULTS = {
  eventsRoot: 'events', topicsRoot: 'topics', projectRoot: 'projects',
  habitsNote: 'habits.md', actionsNote: 'actions.md', mistakesNote: 'mistakes.md',
  candidatesNote: 'candidates.md', experienceNote: 'experience.md', inboxRoot: 'digest',
};

// Roles as the settings page prefills them: whatever the config currently resolves to.
function rolesOf(config) {
  const roles = {};
  for (const key of ROLE_KEYS) roles[key] = config.roles?.[key] ?? ROLE_DEFAULTS[key];
  return roles;
}

// Exactly the three editable groups, as the settings page submits them.
function configPayload(config, over = {}) {
  return {
    storage: 'filesystem',
    memoryRoot: config.memoryRoot,
    vaultRoot: config.vaultRoot,
    vaultName: '',
    obsidianCli: '',
    layout: 'neutral',
    roles: rolesOf(config),
    activeLimit: 8,
    recentLimit: 4,
    recentDays: 21,
    budgetBytes: 20000,
    ...over,
  };
}

const configFileOf = (config) => path.join(config.policyRoot, 'config.json');
const readConfigFile = (config) => JSON.parse(fs.readFileSync(configFileOf(config), 'utf8'));

test('update-config previews the change and only then writes the editable groups', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const beforeText = fs.readFileSync(configFileOf(config), 'utf8');
    const before = JSON.parse(beforeText);
    const previewRes = await post(base, 'update-config/preview', configPayload(config, {
      activeLimit: 9, recentDays: 30, budgetBytes: 24000,
    }));
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    assert.equal(preview.plan.kind, 'update-config');
    assert.ok(preview.token, 'preview returns a signed token');
    assert.ok(preview.fingerprint, 'preview returns the state fingerprint');
    assert.ok(preview.plan.changes.some((change) => change.key === 'activeLimit'));
    assert.equal(fs.readFileSync(configFileOf(config), 'utf8'), beforeText, 'preview must not touch the config file');

    const execRes = await post(base, 'execute', {
      action: 'update-config', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token,
    });
    assert.equal(execRes.status, 200);
    const result = await execRes.json();
    assert.equal(result.kind, 'update-config');
    assert.equal(result.restartRequired, true, 'a config write reports that hosts must restart');
    const after = readConfigFile(config);
    assert.equal(after.activeLimit, 9);
    assert.equal(after.recentDays, 30);
    assert.equal(after.budgetBytes, 24000);
    assert.equal(after.roles.eventsRoot, 'events');
    // Keys outside the three editable groups survive untouched.
    assert.deepEqual(after.topics, before.topics);
    assert.deepEqual(after.workspaceAliases, before.workspaceAliases);
  });
});

test('update-config creates a missing memory root instead of refusing it', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const fresh = path.join(config.policyRoot, 'fresh-store');
    assert.equal(fs.existsSync(fresh), false);
    const preview = await (await post(base, 'update-config/preview', configPayload(config, {
      memoryRoot: fresh, vaultRoot: fresh,
    }))).json();
    assert.equal(fs.existsSync(fresh), false, 'preview must not create the store');
    const execRes = await post(base, 'execute', {
      action: 'update-config', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token,
    });
    assert.equal(execRes.status, 200);
    assert.ok(fs.statSync(fresh).isDirectory(), 'the store root is created');
    assert.equal(readConfigFile(config).memoryRoot, fresh);
  });
});

test('update-config rejects a write when the journal moved after the preview', async (t) => {
  const { loader, route, topic } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const beforeText = fs.readFileSync(configFileOf(config), 'utf8');
    const preview = await (await post(base, 'update-config/preview', configPayload(config))).json();
    // An intervening event moves the fingerprint the token was bound to.
    record(config, createTransport(config), {
      event_id: 'intervening-0001', workspace: route.id, topic: topic.id, agent: 'fixture',
      occurred_at: '2026-09-02T00:00:00+08:00', evidence: ['digest/evidence.md'],
      facts: [{ key: 'intervening', text: 'the journal moved' }],
    });
    const res = await post(base, 'execute', {
      action: 'update-config', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token,
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /State changed since preview/);
    assert.equal(fs.readFileSync(configFileOf(config), 'utf8'), beforeText, 'a stale execute must not write');
  });
});

test('update-config rejects a write when the config file changed after the preview', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const preview = await (await post(base, 'update-config/preview', configPayload(config, { recentDays: 30 }))).json();
    // A hand edit between preview and execute must win: the plan pins the bytes it saw.
    const edited = { ...readConfigFile(config), vaultName: 'edited-by-hand' };
    fs.writeFileSync(configFileOf(config), JSON.stringify(edited, null, 2));
    const res = await post(base, 'execute', {
      action: 'update-config', plan: preview.plan, fingerprint: preview.fingerprint, token: preview.token,
    });
    assert.equal(res.status, 500);
    const refusedBody = await res.json();
    assert.match(refusedBody.error, /changed after the preview/);
    assert.match(zh(refusedBody.ref), /配置文件在预览之后被改动/);
    assert.equal(readConfigFile(config).vaultName, 'edited-by-hand', 'the hand edit is not overwritten');
  });
});

test('update-config refuses a role that points outside the memory root', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    for (const escape of ['../outside', 'C:/outside-store', 'nested/../../outside']) {
      const res = await post(base, 'update-config/preview', configPayload(config, {
        roles: { ...rolesOf(config), eventsRoot: escape },
      }));
      assert.equal(res.status, 500, `role ${escape} must be refused`);
      const refused = await res.json();
      assert.match(refused.error, /roles\.eventsRoot.*must stay inside the memory store root/);
      // The refusal carries the issues themselves beside the sentence assembled from them, which is
      // what lets the settings page word them in the reader's own language.
      assert.ok(Array.isArray(refused.issues) && refused.issues.some((line) => /roles\.eventsRoot.*记忆库根目录内/.test(zh(line))),
        `the refusal must carry structured issues, got ${JSON.stringify(refused.issues)}`);
    }
  });
});

test('update-config refuses numeric parameters outside their allowed range', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const zero = await post(base, 'update-config/preview', configPayload(config, { activeLimit: 0 }));
    assert.equal(zero.status, 500);
    const refusedZero = await zero.json();
    assert.match(refusedZero.error, /activeLimit.*must be an integer between 1 and 200/);
    assert.ok(Array.isArray(refusedZero.issues) && refusedZero.issues.some((line) => /activeLimit/.test(zh(line))),
      `the refusal must carry structured issues, got ${JSON.stringify(refusedZero.issues)}`);

    const fractional = await post(base, 'update-config/preview', configPayload(config, { budgetBytes: 12.5 }));
    assert.equal(fractional.status, 500);
    assert.match((await fractional.json()).error, /budgetBytes.*must be an integer/);

    const missing = await post(base, 'update-config/preview', configPayload(config, { recentDays: null }));
    assert.equal(missing.status, 500);
    assert.match((await missing.json()).error, /recentDays/);
  });
});

test('update-config refuses a memory root that points at this repository', async (t) => {
  const { loader } = fixture(t);
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await withServer(loader, async (base) => {
    const config = loader();
    const res = await post(base, 'update-config/preview', configPayload(config, {
      memoryRoot: repository, vaultRoot: repository,
    }));
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /must not point at this program/);
  });
});

test('update-config requires both obsidian fields for the obsidian-cli backend', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const missingCli = await post(base, 'update-config/preview', configPayload(config, { storage: 'obsidian-cli' }));
    assert.equal(missingCli.status, 500);
    assert.match((await missingCli.json()).error, /requires obsidianCli/);

    const missingVault = await post(base, 'update-config/preview', configPayload(config, {
      storage: 'obsidian-cli', obsidianCli: 'C:/tools/obsidian.exe',
    }));
    assert.equal(missingVault.status, 500);
    assert.match((await missingVault.json()).error, /requires vaultName/);

    const complete = await post(base, 'update-config/preview', configPayload(config, {
      storage: 'obsidian-cli', obsidianCli: 'C:/tools/obsidian.exe', vaultName: 'my-vault',
    }));
    assert.equal(complete.status, 200, 'both fields present is a valid preview');
  });
});

test('update-config refuses a preview that changes nothing', async (t) => {
  const { loader } = fixture(t);
  const config = loader();
  const raw = readConfigFile(config);
  Object.assign(raw, { activeLimit: 6, recentLimit: 6, recentDays: 14, budgetBytes: 14000 });
  fs.writeFileSync(configFileOf(config), JSON.stringify(raw, null, 2));
  await withServer(loader, async (base) => {
    const res = await post(base, 'update-config/preview', configPayload(loader(), {
      activeLimit: 6, recentLimit: 6, recentDays: 14, budgetBytes: 14000,
    }));
    const body = await res.json();
    assert.equal(res.status, 500, `unexpected changes: ${JSON.stringify(body.plan?.changes)}`);
    assert.match(body.error, /configuration is unchanged/);
  });
});

test('update-config ignores fields outside the three editable groups', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const config = loader();
    const before = readConfigFile(config);
    const preview = await (await post(base, 'update-config/preview', {
      ...configPayload(config, { recentDays: 30 }),
      topics: [{ id: 'injected/topic', workspace: 'injected', title: 'Injected', path: 'topics/injected.md' }],
      policyRoot: 'C:/tmp/elsewhere',
    })).json();
    assert.equal(preview.plan.next.policyRoot, before.policyRoot, 'policyRoot is not editable from the console');
    assert.deepEqual(preview.plan.next.topics, before.topics, 'topics are not editable from the console');
  });
});
test('vaultRoot alone cannot target the repository and invalid new roots stay absent', async (t) => {
  const { loader } = fixture(t);
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await withServer(loader, async (base) => {
    const config = loader();
    const res = await post(base, 'update-config/preview', configPayload(config, { vaultRoot: repository }));
    assert.equal(res.status, 500);
    const fresh = path.join(config.policyRoot, 'invalid-store');
    const invalid = await post(base, 'update-config/preview', configPayload(config, {
      memoryRoot: fresh, vaultRoot: fresh, roles: { ...rolesOf(config), eventsRoot: '../escape' },
    }));
    assert.equal(invalid.status, 500);
    assert.equal(fs.existsSync(fresh), false);
  });
});