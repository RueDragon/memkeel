import fs from 'node:fs';
import path from 'node:path';
import { sha, inside } from './transport.mjs';

const dirs = ['.agents', '.codex', '.zcode', '.claude', '.dsh'];
const normalized = (value) => path.resolve(value).toLowerCase();
export function auditMemorySkill(home, policyRoot) {
  const roots = dirs.map((dir) => path.join(home, dir, 'skills/obsidian-memory-first'));
  const present = (file) => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const activeDefinitions = roots.map((root) => path.join(root, 'SKILL.md')).filter(present);
  const manifestFile = path.join(policyRoot, 'state/retired-memory-skill.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const permitted = new Set(roots.flatMap((root) => ['SKILL.md', 'agents/openai.yaml'].map((file) => normalized(path.join(root, file)))));
  const archivedSources = []; const invalidArchives = [];
  for (const row of manifest?.files ?? []) {
    try {
      if (!permitted.has(normalized(row.source))) throw new Error('Not a retired skill file');
      const relative = path.relative(path.join(policyRoot, 'backups'), row.backup);
      const file = inside(path.join(policyRoot, 'backups'), relative);
      if (!row.sha256 || sha(fs.readFileSync(file)) !== row.sha256.toLowerCase()) throw new Error('Archive hash mismatch');
      archivedSources.push(normalized(row.source));
    } catch (error) { invalidArchives.push({ source: row.source, error: error.message }); }
  }
  return { activeDefinitions, archivedSources, invalidArchives, retired: activeDefinitions.length === 0 && invalidArchives.length === 0 };
}
