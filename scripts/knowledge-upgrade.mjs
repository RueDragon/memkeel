#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { loadEvents, reduceEvents, consumptionStatus } from '../lib/core.mjs';
import { inside, atomicJson, sha, withLock, inspectLock } from '../lib/transport.mjs';
import { retrievalCorpus } from '../lib/search/corpus.mjs';
import { buildSemanticIndex, indexedRecall, embeddingProfile, contentHash, INDEX_VERSION, validateSemanticIndex } from '../lib/search/semantic-index.mjs';
import { validateObservation, observationState } from '../lib/knowledge/observations.mjs';
import { proposeObservation } from '../lib/knowledge/local-generator.mjs';
import { appendObservation, loadObservationJournal, projectObservations } from '../lib/knowledge/observation-ledger.mjs';
import { publishPage } from '../lib/knowledge/refresh.mjs';
import { buildStatusPage, pageState, pageRevision, inspectPage } from '../lib/knowledge/pages.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
try {
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--execute') { options.execute = true; continue; }
    if (!['--home', '--workspace', '--query', '--topic', '--proposal', '--model', '--key', '--supersedes', '--reason',
      '--model-revision', '--query-prefix', '--document-prefix', '--endpoint', '--chunk-chars', '--overlap-chars'].includes(key)
      || !args[i + 1] || args[i + 1].startsWith('--') || options[key] !== undefined) throw new Error('Invalid arguments');
    options[key] = args[++i];
  }
  if (!options['--home'] || !options['--workspace']) throw new Error('Explicit --home and --workspace required');
  const { config } = loadConfig(options['--home']);
  const workspace = options['--workspace'];
  const embeddingConfig = { model: options['--model'], embeddingOptions: {
    modelRevision: options['--model-revision'], queryPrefix: options['--query-prefix'],
    documentPrefix: options['--document-prefix'], endpoint: options['--endpoint'],
    ...(options['--chunk-chars'] !== undefined ? { chunkChars: Number(options['--chunk-chars']) } : {}),
    ...(options['--overlap-chars'] !== undefined ? { overlapChars: Number(options['--overlap-chars']) } : {}),
  } };
  if (!config.topics.some((t) => t.workspace === workspace)) throw new Error('Unknown workspace');
  const stateDir = path.join(config.policyRoot, 'state', 'knowledge-upgrade');
  const events = loadEvents(config); const projection = reduceEvents(events);
  const pendingTopics = consumptionStatus(config, events).pendingTopics;
  const units = retrievalCorpus(config, events, projection, 'all', workspace, pendingTopics);
  const revision = sha(JSON.stringify(units));
  const indexFile = path.join(stateDir, `${workspace}.index.json`);
  let previous = null; let indexIssue = null;
  if (fs.existsSync(indexFile)) {
    try {
      previous = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (previous?.version === INDEX_VERSION) validateSemanticIndex(previous);
      else { previous = null; indexIssue = 'incompatible-index-version'; }
    } catch { previous = null; indexIssue = 'invalid-index-file'; }
  }
  let result;
  if (command === 'index') {
    const profile = embeddingProfile(embeddingConfig.model, embeddingConfig.embeddingOptions);
    if (!options.execute) result = { mode: 'plan', units: units.length, target: indexFile, profile, indexIssue };
    else {
      const index = await buildSemanticIndex(units, { ...embeddingConfig, previous, revision, sourceCheck: () => {
        const fresh = loadEvents(config);
        return sha(JSON.stringify(retrievalCorpus(config, fresh, reduceEvents(fresh), 'all', workspace,
          consumptionStatus(config, fresh).pendingTopics))) === revision;
      } });
      withLock(path.join(config.policyRoot, 'state'), () => {
        const fresh = loadEvents(config);
        if (sha(JSON.stringify(retrievalCorpus(config, fresh, reduceEvents(fresh), 'all', workspace,
          consumptionStatus(config, fresh).pendingTopics))) !== revision) throw new Error('Sources changed before index publication');
        atomicJson(indexFile, index);
      });
      result = { mode: 'executed', units: units.length, dimension: index.dimension, stats: index.stats };
    }
  } else if (command === 'recall') {
    if (options.execute) throw new Error('Recall cannot execute writes');
    if (!options['--query']) throw new Error('--query required');
    const eligible = retrievalCorpus(config, events, projection, options['--query'], workspace, pendingTopics);
    result = await indexedRecall(eligible, options['--query'], previous, embeddingConfig);
  } else if (command === 'observation') {
    const topic = options['--topic'];
    if (!config.topics.some((t) => t.id === topic && t.workspace === workspace)) throw new Error('Unknown topic');
    if (!options['--proposal'] && !options['--model']) throw new Error('--proposal file or explicit local --model required');
    const sources = projection.facts.filter((f) => f.topic === topic).map((f) => ({
      id: `${f.event_id}/${f.key}`, text: f.text, workspace, topic,
      root: 'unverified-origin', hash: sha(f.text),
    }));
    if (pendingTopics.includes(topic)) throw new Error('Pending evidence');
    if (projection.conflicts.some((c) => c.topic === topic)) throw new Error('Conflicted evidence');
    if (config.topics.some((t) => t.id === topic && ['archived', 'superseded'].includes(t.status)))
      throw new Error('Inactive evidence topic');
    result = options['--proposal']
      ? validateObservation(JSON.parse(fs.readFileSync(options['--proposal'], 'utf8')), sources, { workspace, topic })
      : await proposeObservation(sources, { workspace, topic }, { model: options['--model'] });
    if (options.execute && result.id) withLock(path.join(config.policyRoot, 'state'), () => {
      const fresh = loadEvents(config);
      const currentProjection = reduceEvents(fresh);
      const currentSources = currentProjection.facts.filter((f) => f.topic === topic)
        .map((f) => ({ id: `${f.event_id}/${f.key}`, hash: sha(f.text) }));
      if (observationState(result, currentSources).stale || consumptionStatus(config, fresh).pendingTopics.includes(topic)
        || currentProjection.conflicts.some((c) => c.topic === topic)) {
        throw new Error('Evidence changed before candidate publication');
      }
      appendObservation(path.join(stateDir, 'observation-journal'), {
        workspace, topic, key: options['--key'] ?? result.id,
        operation: options['--supersedes'] ? 'revise' : 'propose',
        ...(options['--supersedes'] ? { supersedes: options['--supersedes'] } : {}), observation: result,
      });
    });
    result = { mode: options.execute ? 'executed-candidate' : 'plan', observation: result };
  } else if (command === 'page') {
    // Observation reads are exposed by the separate inspect command, never in facts.
    const topic = config.topics.find((t) => t.id === options['--topic'] && t.workspace === workspace);
    if (!topic) throw new Error('Unknown topic');
    // Stage in a separate derived page, never replace canonical topic/manual notes.
    const relative = `${config.projectRoot}/knowledge-upgrade/${topic.id.replace('/', '--')}.md`;
    const file = inside(config.vaultRoot, relative);
    const manifestFile = path.join(stateDir, `${topic.id.replace('/', '--')}.page.json`);
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
    const oldText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const intentFile = `${manifestFile}.pending`;
    const pendingIntent = fs.existsSync(intentFile) ? JSON.parse(fs.readFileSync(intentFile, 'utf8')) : null;
    const diagnosis = inspectPage(manifest, projection, topic.id, pendingTopics, fs.existsSync(file) ? oldText : null);
    const state = diagnosis.state;
    result = { mode: 'plan', ...diagnosis, target: relative };
    if (options.execute) {
      if (state === 'blocked' && (projection.conflicts.some((r) => r.topic === topic.id)
        || !pendingIntent || sha(oldText) !== pendingIntent.nextHash)) throw new Error('Resolve page integrity or topic conflicts before publication');
      const page = buildStatusPage(projection, topic.id, { pendingTopics });
      const fresh = loadEvents(config);
      if (pageRevision(reduceEvents(fresh), topic.id) !== page.manifest.revision
        || consumptionStatus(config, fresh).pendingTopics.includes(topic.id)) throw new Error('Sources changed before publication');
      if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== oldText) throw new Error('Page changed before publication');
      // Publish through the existing readback-verifying storage transport.
      const { createTransport } = await import('../lib/storage/index.mjs');
      const transport = createTransport(config);
      let publication;
      withLock(path.join(config.policyRoot, 'state'), () => {
        const latest = loadEvents(config);
        if (pageRevision(reduceEvents(latest), topic.id) !== page.manifest.revision
          || consumptionStatus(config, latest).pendingTopics.includes(topic.id)) throw new Error('Sources changed before publication');
        if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== oldText) throw new Error('Page changed before lock');
        publication = publishPage({ relative, existing: oldText, page, previousManifest: manifest, pendingIntent, transport,
        writeIntent: (intent) => atomicJson(intentFile, intent),
        writeManifest: (value) => atomicJson(manifestFile, value),
        clearIntent: () => fs.rmSync(intentFile, { force: true }),
        sourceCheck: () => {
          const current = loadEvents(config);
          return pageRevision(reduceEvents(current), topic.id) === page.manifest.revision
            && !consumptionStatus(config, current).pendingTopics.includes(topic.id);
        },
      });
      });
      result = { mode: 'executed', target: relative, recovered: publication.recovered,
        state: pageState(publication.manifest, projection, topic.id, pendingTopics) };
    }
  } else if (command === 'inspect') {
    if (options.execute) throw new Error('Inspect cannot execute writes');
    const observations = projectObservations(loadObservationJournal(path.join(stateDir, 'observation-journal')))
      .filter((o) => o.workspace === workspace).map((o) => {
        const sources = projection.facts.filter((f) => f.topic === o.topic).map((f) => ({
          id: `${f.event_id}/${f.key}`, hash: sha(f.text), text: f.text,
        }));
        const topic = config.topics.find((t) => t.id === o.topic && t.workspace === workspace);
        const blockedReason = o.status === 'retired' ? 'retired' : !topic || ['archived', 'superseded'].includes(topic.status)
          ? 'inactive-topic' : pendingTopics.includes(o.topic) ? 'pending-evidence'
          : projection.conflicts.some((c) => c.topic === o.topic) ? 'conflicted-evidence' : null;
        return { ...o, ...observationState(o, sources),
          ...(blockedReason ? { usable: false, stale: true, blockedReason } : {}) };
      });
    const pages = config.topics.filter((t) => t.workspace === workspace).map((topic) => {
      const file = path.join(stateDir, `${topic.id.replace('/', '--')}.page.json`);
      const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      const pageFile = inside(config.vaultRoot, `${config.projectRoot}/knowledge-upgrade/${topic.id.replace('/', '--')}.md`);
      const text = fs.existsSync(pageFile) ? fs.readFileSync(pageFile, 'utf8') : null;
      return { topic: topic.id, ...inspectPage(manifest, projection, topic.id, pendingTopics, text) };
    });
    const profile = embeddingProfile(embeddingConfig.model, embeddingConfig.embeddingOptions);
    const compatible = previous?.version === INDEX_VERSION && previous.profile?.fingerprint === profile.fingerprint;
    const stored = new Map((previous?.rows ?? []).map((row) => [row.id, row.hash]));
    const index = { exists: fs.existsSync(indexFile), issue: indexIssue, version: previous?.version ?? null, compatible,
      profile: previous?.profile ?? null, requestedProfile: profile,
      weightRevisionDeclared: profile.modelRevision !== 'unverified-model-id',
      eligibleUnits: units.length, staleUnits: compatible ? units.filter((u) => stored.get(u.id) !== contentHash(u)).length : units.length };
    const locks = { writer: inspectLock(path.join(config.policyRoot, 'state')), refresh: inspectLock(stateDir) };
    const queueFile = path.join(stateDir, 'refresh-queue.json');
    const queue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : [];
    if (!Array.isArray(queue)) throw new Error('Invalid refresh queue');
    const refresh = queue.filter((task) => task.workspace === workspace).map((task) => ({
      topic: task.topic, revision: task.revision, status: task.status, attempts: task.attempts,
      retryExhausted: task.status !== 'done' && task.attempts >= 3,
      ...(task.error ? { error: 'refresh-failed' } : {}),
    }));
    result = { mode: 'read-only', locks, index, refresh, observations, pages };
  } else if (command === 'retire') {
    const payload = { workspace, topic: options['--topic'], key: options['--key'],
      supersedes: options['--supersedes'], reason: options['--reason'], operation: 'retire' };
    const directory = path.join(stateDir, 'observation-journal');
    const records = loadObservationJournal(directory);
    projectObservations([...records, { id: sha(JSON.stringify(payload)), payload }]);
    result = { mode: 'plan', payload };
    if (options.execute) result = withLock(path.join(config.policyRoot, 'state'), () => appendObservation(directory, payload));
  } else throw new Error('Commands: index | recall | observation | page | inspect | retire');
  console.log(JSON.stringify(result, null, 2));
  if (result.degraded) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
