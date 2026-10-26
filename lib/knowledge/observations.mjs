import { sha } from '../transport.mjs';
import { redactSecrets } from '../redaction.mjs';

export function evidenceFingerprint(sources) {
  return sha(JSON.stringify(sources.map((s) => [s.id, s.hash]).sort((a, b) => a[0].localeCompare(b[0]))));
}

// Model proposals are data, never executable instructions or confirmed facts.
export function validateObservation(proposal, sources, { workspace, topic } = {}) {
  if (!proposal || typeof proposal.claim !== 'string' || !proposal.claim.trim()
    || proposal.claim.length > 4000 || !['failure-pattern', 'preference-tendency', 'explanation'].includes(proposal.kind)) {
    throw new Error('Invalid observation proposal');
  }
  if (!workspace || !topic?.startsWith(`${workspace}/`)) throw new Error('Invalid observation scope');
  const byId = new Map(sources.map((s) => [s.id, s]));
  if (byId.size !== sources.length) throw new Error('Duplicate evidence id');
  const references = (refs) => {
    if (!Array.isArray(refs) || refs.length > 64) throw new Error('Evidence references required');
    const seen = new Set();
    return refs.map((ref) => {
      const source = byId.get(ref?.id);
      if (!source || source.workspace !== workspace || source.topic !== topic
        || !/^[a-f0-9]{64}$/.test(source.hash ?? '') || typeof source.root !== 'string' || !source.root.trim()
        || typeof ref.quote !== 'string' || !ref.quote.trim()
        || !source.text.includes(ref.quote) || seen.has(ref.id)) throw new Error('Invalid evidence reference');
      seen.add(ref.id);
      return { id: ref.id, quote: redactSecrets(ref.quote), hash: source.hash, root: source.root };
    });
  };
  const support = references(proposal.support);
  const counterevidence = references(proposal.counterevidence ?? []);
  if (!support.length) throw new Error('Supporting evidence required');
  // Origin identity must be established by the importer/reviewer. Event or note
  // counts alone cannot establish independent evidence.
  const independentSources = new Set(support.map((r) => r.root)).size;
  return { id: sha(JSON.stringify([workspace, topic, proposal.claim])).slice(0, 24),
    workspace, topic, kind: proposal.kind, claim: redactSecrets(proposal.claim),
    status: 'candidate', authority: 'inference-not-instruction', support, counterevidence,
    evidenceState: counterevidence.length ? 'contested' : independentSources > 1 ? 'corroborated' : 'single-source',
    independentSources, sourceFingerprint: evidenceFingerprint(sources),
  };
}

export function validateStoredObservation(o) {
  const text = (value) => typeof value === 'string' && value.trim().length > 0;
  if (!o || !text(o.workspace) || !text(o.topic) || !o.topic.startsWith(`${o.workspace}/`)
    || !text(o.claim) || o.claim.length > 4000 || !/^[a-f0-9]{24}$/.test(o.id ?? '')
    || !['failure-pattern', 'preference-tendency', 'explanation'].includes(o.kind)
    || !['candidate', 'retired'].includes(o.status) || o.authority !== 'inference-not-instruction'
    || !/^[a-f0-9]{64}$/.test(o.sourceFingerprint ?? '')) throw new Error('Invalid stored observation');
  for (const refs of [o.support, o.counterevidence]) {
    if (!Array.isArray(refs) || refs.length > 64) throw new Error('Invalid stored evidence');
    const seen = new Set();
    for (const ref of refs) {
      if (!ref || !text(ref.id) || !text(ref.quote) || !text(ref.root)
        || !/^[a-f0-9]{64}$/.test(ref.hash ?? '') || seen.has(ref.id)) throw new Error('Invalid stored evidence');
      seen.add(ref.id);
    }
  }
  if (!o.support.length) throw new Error('Supporting evidence required');
  const count = new Set(o.support.map((r) => r.root)).size;
  const state = o.counterevidence.length ? 'contested' : count > 1 ? 'corroborated' : 'single-source';
  if (o.independentSources !== count || o.evidenceState !== state) throw new Error('Inconsistent stored evidence state');
  return o;
}

export function observationState(observation, sources) {
  validateStoredObservation(observation);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const stale = evidenceFingerprint(sources) !== observation.sourceFingerprint
    || [...observation.support, ...observation.counterevidence].some((ref) => {
    const source = byId.get(ref.id);
    return !source || source.hash !== ref.hash || source.status === 'invalidated'
      || (source.text !== undefined && (typeof source.text !== 'string' || !redactSecrets(source.text).includes(ref.quote)));
  });
  return { stale, usable: !stale && observation.status !== 'retired' && observation.evidenceState !== 'contested',
    authority: 'inference-not-instruction' };
}
