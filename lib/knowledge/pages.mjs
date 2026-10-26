import { sha } from '../transport.mjs';
import { redactSecrets } from '../redaction.mjs';

const START = '<!-- MEMKEEL-KNOWLEDGE:START -->';
const END = '<!-- MEMKEEL-KNOWLEDGE:END -->';
const safe = (text) => redactSecrets(text).replaceAll(START, '&lt;!-- MEMKEEL-KNOWLEDGE:START --&gt;')
  .replaceAll(END, '&lt;!-- MEMKEEL-KNOWLEDGE:END --&gt;');

export function pageRevision(projection, topic) {
  return sha(JSON.stringify({ facts: projection.facts.filter((r) => r.topic === topic),
    actions: projection.actions.filter((r) => r.topic === topic),
    conflicts: projection.conflicts.filter((r) => r.topic === topic) }));
}

export function pageState(manifest, projection, topic, pendingTopics = []) {
  if (pendingTopics.includes(topic)) return 'dirty';
  if (projection.conflicts.some((r) => r.topic === topic)) return 'blocked';
  if (!manifest) return 'missing';
  return manifest.templateVersion === 1 && manifest.revision === pageRevision(projection, topic) ? 'fresh' : 'dirty';
}

export function buildStatusPage(projection, topic, { pendingTopics = [] } = {}) {

  if (pendingTopics.includes(topic)) throw new Error('Pending topic cannot publish a current page');
  if (projection.conflicts.some((r) => r.topic === topic)) throw new Error('Conflicted topic cannot publish a current page');
  const facts = projection.facts.filter((r) => r.topic === topic);
  const actions = projection.actions.filter((r) => r.topic === topic && r.status === 'open');
  const conflicts = projection.conflicts.filter((r) => r.topic === topic);
  const lines = ['## Recorded Current Conclusions',
    'Recorded evidence is not current runtime verification or execution permission.',
    ...facts.map((r) => `- ${safe(r.text)}\n  Source: ${r.event_id}; occurred: ${r.at}`),
    '\n## Open Actions', ...actions.map((r) => `- [ ] ${safe(r.text)} (${r.id})`),
    '\n## Unresolved Conflicts', ...conflicts.map((r) => `- ${safe(r.key)} (${r.event_id})`),
  ];
  const body = lines.join('\n');
  return { body, manifest: { templateVersion: 1, topic, revision: pageRevision(projection, topic),
    bodyHash: sha(body), sourceEventIds: [...new Set([...facts, ...actions].map((r) => r.event_id))],
    builtAt: new Date().toISOString() } };
}

// Only the uniquely marked block is replaceable; all manual bytes outside it survive.
export function inspectPage(manifest, projection, topic, pendingTopics, text) {
  if (projection.conflicts.some((r) => r.topic === topic)) return { state: 'blocked', integrity: 'conflicted-evidence' };
  if (pendingTopics.includes(topic)) return { state: 'dirty', integrity: 'pending-evidence' };
  if (text === null) return { state: 'missing', integrity: 'missing-file' };
  if (!manifest) return { state: 'missing', integrity: 'untracked' };
  try { replacePageBlock(text, '', manifest); }
  catch { return { state: 'blocked', integrity: 'managed-content-changed' }; }
  if (manifest.topic !== topic) return { state: 'blocked', integrity: 'topic-mismatch' };
  return { state: pageState(manifest, projection, topic, pendingTopics), integrity: 'verified' };
}

export function replacePageBlock(existing, body, previousManifest = null) {
  const startCount = existing.split(START).length - 1;
  const endCount = existing.split(END).length - 1;
  if (!startCount && !endCount) {
    if (previousManifest) throw new Error('Managed block removed');
    return `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}${START}\n${body}\n${END}\n`;
  }
  if (startCount !== 1 || endCount !== 1 || existing.indexOf(END) < existing.indexOf(START)) {
    throw new Error('Ambiguous managed boundary');
  }
  const start = existing.indexOf(START); const end = existing.indexOf(END);
  const oldBody = existing.slice(start + START.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  if (!previousManifest || sha(oldBody) !== previousManifest.bodyHash) throw new Error('Managed content was manually changed');
  return `${existing.slice(0, start)}${START}\n${body}\n${END}${existing.slice(end + END.length)}`;
}
