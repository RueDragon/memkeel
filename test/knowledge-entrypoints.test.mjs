import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('CLI and MCP expose read-only knowledge operations on the configured home', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-entrypoint-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault'); fs.mkdirSync(vault);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ storage: 'filesystem', vaultRoot: vault,
    memoryRoot: vault, topics: [{ id: 'demo/a', workspace: 'demo', path: 'topics/a.md', title: 'Demo' }] }));
  const cli = spawnSync(process.execPath, [path.join(root, 'bin/memkeel.mjs'), 'knowledge', 'inspect', '--home', home, '--workspace', 'demo'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).mode, 'read-only');
  const requests = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'agent_memory_read', arguments: { action: 'knowledge_inspect', workspace: 'demo' } } }];
  const mcp = spawnSync(process.execPath, [path.join(root, 'mcp-server.mjs'), '--home', home], {
    encoding: 'utf8', input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n' });
  assert.equal(mcp.status, 0, mcp.stderr);
  const replies = mcp.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(replies[0].result.tools[0].inputSchema.properties.action.enum.includes('knowledge_recall'));
  assert.equal(replies[1].result.isError, undefined);
  assert.equal(JSON.parse(replies[1].result.content[0].text).mode, 'read-only');
  assert.ok(!fs.existsSync(path.join(home, 'state')));
});
