// Deterministic, read-only report over caller-supplied rows. Never loads a store,
// applies decisions or copies memory bodies into the returned report.
import { buildGovernanceCandidates, deduplicate, evidenceReferences, governanceScope } from './governance.mjs';
import { partitionVisibility } from './visibility.mjs';

function value(item, names, fallback = '') {
  for (const name of names) if (item?.[name] !== undefined && item?.[name] !== null && item[name] !== '') return item[name];
  return fallback;
}

function dateOf(item) {
  const raw = value(item, ['occurred_at', 'occurredAt', 'at', 'updatedAt', 'updated_at', 'recorded_at', 'recordedAt']);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : 'unknown';
}

function bytesOf(item) {
  const raw = value(item, ['bytes', 'byteLength', 'sizeBytes', 'size'], null);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  const text = value(item, ['text', 'summary', 'body', 'content'], '');
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
}

function typeOf(item) { return String(value(item, ['type', 'kind', 'category'], 'unknown')); }
function projectOf(item) { return governanceScope(item).workspace || 'unknown'; }

function grouped(rows, getter, measure = () => 1) {
  const groups = new Map();
  for (const row of rows) groups.set(getter(row), (groups.get(getter(row)) ?? 0) + measure(row));
  // Map/Object.fromEntries safely handle labels such as __proto__ and constructor.
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

function statistics(rows) {
  return {
    count: rows.length, bytes: rows.reduce((total, item) => total + bytesOf(item), 0),
    byType: grouped(rows, typeOf), byProject: grouped(rows, projectOf), byDate: grouped(rows, dateOf),
    bytesByType: grouped(rows, typeOf, bytesOf), bytesByProject: grouped(rows, projectOf, bytesOf), bytesByDate: grouped(rows, dateOf, bytesOf),
  };
}

export function governanceReport(items, { now = new Date(), history = false, dedupe = true, ...lifecycle } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  const visibility = partitionVisibility(items, { history, now });
  const included = history ? [...visibility.visible, ...visibility.historical] : visibility.visible;
  const deduped = dedupe ? deduplicate(included, { includeDropped: history, now }) : { kept: included, duplicates: [] };
  const candidates = buildGovernanceCandidates(deduped.kept, { ...lifecycle, now });
  const duplicateDetails = deduped.duplicates.map(({ item, duplicateOf, digest }) => ({
    id: item?.id ?? item?.key ?? item?.event_id ?? null, event_id: item?.event_id ?? null,
    duplicateOf: duplicateOf?.id ?? duplicateOf?.key ?? duplicateOf?.event_id ?? null,
    duplicateEventId: duplicateOf?.event_id ?? null,
    ...governanceScope(item), digest, action: 'merge',
    reason: 'normalized exact text and workspace/topic/task/branch/type/state match; candidate only',
    evidence: evidenceReferences(item), duplicateEvidence: evidenceReferences(duplicateOf),
    recovery: 'No changes applied. Retain both source events; any approved display merge must be reversible from their references.',
  }));
  const counts = Object.fromEntries(['retain', 'review', 'archive', 'hide'].map((action) => [action, candidates.filter((row) => row.action === action).length]));
  return {
    generatedAt: new Date(now).toISOString(), mode: 'report-only', applied: false,
    counts: { ...counts, merge: duplicateDetails.length },
    statsScope: 'included rows after exact scoped deduplication',
    byteBasis: 'nonnegative explicit bytes/byteLength/sizeBytes/size; otherwise UTF-8 text/summary/body/content bytes, not on-disk ledger size',
    stats: statistics(deduped.kept), rawStats: statistics(items),
    visibility: { visible: visibility.visible.length, historical: visibility.historical.length, hidden: visibility.hidden.length },
    duplicateCount: duplicateDetails.length, duplicates: duplicateDetails.length, duplicateDetails, candidates,
  };
}

function line(value) { return String(value ?? '').replace(/[\r\n]+/g, ' '); }

export function formatGovernanceReport(report) {
  if (!report || typeof report !== 'object' || !report.counts || !Array.isArray(report.candidates)) throw new TypeError('Invalid governance report');
  const lines = [
    '# Memory governance candidates', '', `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}; applied: ${report.applied}; no decisions have been applied`,
    `Visibility: ${report.visibility.visible} visible, ${report.visibility.historical} historical, ${report.visibility.hidden} hidden`,
    `Duplicates: ${report.duplicateCount ?? report.duplicates ?? 0}`,
    `Actions: retain=${report.counts.retain}, review=${report.counts.review}, archive=${report.counts.archive}, hide=${report.counts.hide}, merge=${report.counts.merge ?? 0}`,
    '', '## Statistics',
    `Scope: ${report.statsScope}; raw input includes hidden/history rows.`,
    `Byte basis: ${report.byteBasis}`,
    `- Selected count/bytes: ${report.stats?.count ?? 0}/${report.stats?.bytes ?? 0}`,
    `- By type: ${JSON.stringify(report.stats?.byType ?? {})}; bytes=${JSON.stringify(report.stats?.bytesByType ?? {})}`,
    `- By project: ${JSON.stringify(report.stats?.byProject ?? {})}; bytes=${JSON.stringify(report.stats?.bytesByProject ?? {})}`,
    `- By date: ${JSON.stringify(report.stats?.byDate ?? {})}; bytes=${JSON.stringify(report.stats?.bytesByDate ?? {})}`,
    `- Raw input statistics: ${JSON.stringify(report.rawStats ?? {})}`,
    '', '## Candidates',
  ];
  for (const row of [...report.candidates, ...(report.duplicateDetails ?? [])]) {
    const evidence = row.evidence?.length ? row.evidence.map(line).join(', ') : '(no evidence reference supplied; review required)';
    lines.push(`- ${line(row.id ?? '(unknown)')} [${line(row.workspace || 'unknown')}/${line(row.topic)}]: **${row.action}** (${row.lifecycle ?? 'duplicate'}) — ${line(row.reason)}; evidence=${evidence}; recovery=${line(row.recovery)}`);
    if (row.duplicateOf) lines.push(`  Duplicate of ${line(row.duplicateOf)}; evidence=${(row.duplicateEvidence ?? []).map(line).join(', ') || '(none)'}`);
  }
  if (!report.candidates.length && !report.duplicateDetails?.length) lines.push('- None.');
  return lines.join('\n');
}
