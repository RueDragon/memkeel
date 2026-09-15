import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicJson, sha } from './lib/transport.mjs';

const home = os.homedir();
const root = process.env.MEMKEEL_HOME ?? path.join(home, '.memkeel');
const policyFile = path.join(root, 'bootstrap.md');
const policy = fs.readFileSync(policyFile, 'utf8').trim();
const start = '<!-- AGENT-POLICY:START -->'; const end = '<!-- AGENT-POLICY:END -->';
const check = process.argv.includes('--check');
const backupRoot = path.join(root, 'backups', `publish-${Date.now()}`);
const records = [];
function publish(file, agent, mode = 'block') {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const body = mode === 'import' ? `@${policyFile.replaceAll('\\', '/')}` : policy;
  const block = `${start}\nSource: ${policyFile.replaceAll('\\', '/')}; sha256: ${sha(policy)}; adapter: ${agent}.\n${body}\n${end}`;
  let next;
  if (old.includes(start)) {
    if (old.split(start).length !== 2 || old.split(end).length !== 2 || old.indexOf(end) < old.indexOf(start)) throw new Error(`Ambiguous adapter markers: ${file}`);
    next = old.slice(0, old.indexOf(start)) + block + old.slice(old.indexOf(end) + end.length);
  } else next = `${old.trim()}${old.trim() ? '\n\n' : ''}${block}\n`;
  const matches = next === old;
  if (!matches && !check) {
    fs.mkdirSync(backupRoot, { recursive: true });
    if (old) fs.writeFileSync(path.join(backupRoot, `${agent}.md`), old, 'utf8');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== old) throw new Error(`Concurrent edit: ${file}`);
    fs.writeFileSync(file, next, 'utf8');
    if (fs.readFileSync(file, 'utf8') !== next) throw new Error(`Readback mismatch: ${file}`);
  }
  records.push({ agent, file, matches: check ? matches : true, changed: !matches, before: sha(old), after: sha(next), mode });
}
publish(path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'AGENTS.md'), 'codex');
publish(path.join(home, '.zcode', 'AGENTS.md'), 'zcode');
publish(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'CLAUDE.md'), 'claude', 'import');
publish(path.join(process.env.DSH_HOME ?? path.join(home, '.dsh'), 'AGENTS.md'), 'dsh');
// Text outside the managed markers is always preserved; existing host sessions may
// need a new task before they load changed instructions.
if (!check) atomicJson(path.join(root, 'state', 'adapters.json'), { at: new Date().toISOString(), sourceHash: sha(policy), scope: ['codex', 'zcode', 'claude', 'dsh'], records, backupRoot });
console.log(JSON.stringify(records, null, 2));
if (check && records.some((row) => !row.matches)) process.exitCode = 1;
