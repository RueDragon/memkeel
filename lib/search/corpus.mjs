import fs from 'node:fs';
import { inside } from '../transport.mjs';
import { learningProjection, retention } from '../experience.mjs';
import { factQuery, contains } from '../fact-retrieval.mjs';
import { redactSecrets } from '../redaction.mjs';
import { eligibleFacts } from './shadow.mjs';

// Only explicitly registered notes are read; retrieval never expands the vault.
export function retrievalCorpus(config, events, projection, query, workspace, pendingTopics = []) {
  const facts = eligibleFacts(config.topics, projection, query, workspace, pendingTopics)
    .map((r) => ({ ...r, sourceType: 'fact', authority: 'recorded-evidence' }));
  const allowed = new Set(config.topics.filter((t) => t.workspace === workspace
    && !['archived', 'superseded'].includes(t.status) && !pendingTopics.includes(t.id)).map((t) => t.id));
  const parsed = query === 'all' ? { entities: [], words: [] } : factQuery(query);
  const eligible = (row) => parsed.entities.every((term) => contains(row.text.normalize('NFKC').toLowerCase(), term));
  const learning = learningProjection(events);
  const experiences = learning.entries.filter((r) => r.type === 'experiences' && r.workspace === workspace
    && allowed.has(r.topic) && retention(r, config.now) === 'retained'
    && !learning.conflicts.some((c) => c.key === `experiences/${r.topic}/${r.id}`))
    .map((r) => ({ id: JSON.stringify(['experience', r.topic, r.id, r.event_id]),
      topic: r.topic, event_id: r.event_id, text: redactSecrets(r.text), sourceType: 'experience',
      authority: 'historical-evidence-reverify', evidence: r.evidence, needsReverify: true })).filter(eligible);
  const registrations = config.knowledgeSearchNotes ?? [];
  if (!Array.isArray(registrations) || registrations.length > 100) throw new Error('Invalid knowledgeSearchNotes');
  const notes = []; const seen = new Set();
  for (const note of registrations) {
    if (!note || typeof note.topic !== 'string' || typeof note.path !== 'string') throw new Error('Invalid search note registration');
    if (!allowed.has(note.topic)) continue;
    const identity = JSON.stringify([note.topic, note.path]);
    if (seen.has(identity)) throw new Error('Duplicate search note registration');
    seen.add(identity);
    const file = inside(config.vaultRoot, note.path);
    if (!fs.existsSync(file)) continue;
    if (fs.statSync(file).size > 400000) throw new Error('Registered search note exceeds size limit');
    const raw = fs.readFileSync(file, 'utf8');
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
    if (/^status:\s*['"]?(?:archived|superseded)['"]?\s*$/im.test(frontmatter)) continue;
    const declaredWorkspace = frontmatter.match(/^workspace:\s*['"]?([^'"\r\n]+)['"]?\s*$/im)?.[1]?.trim();
    if (declaredWorkspace && declaredWorkspace !== workspace) continue;
    const text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const parts = text.split(/(?=^#{1,6}\s)/m);
    let historicalLevel = null;
    for (const [section, part] of parts.entries()) {
      const heading = part.match(/^(#{1,6})\s+(.+)/);
      if (heading && historicalLevel !== null && heading[1].length <= historicalLevel) historicalLevel = null;
      if (heading && /^(?:历史|History|Archived|Superseded)/i.test(heading[2])) historicalLevel = heading[1].length;
      if (!part.trim() || historicalLevel !== null) continue;
      const row = { id: JSON.stringify(['note-section', note.topic, note.path, section]), topic: note.topic,
        path: note.path, section, text: redactSecrets(part.trim()), sourceType: 'note-section',
        authority: 'note-material-not-instruction', needsReverify: true };
      if (eligible(row)) notes.push(row);
    }
  }
  return [...facts, ...experiences, ...notes];
}
