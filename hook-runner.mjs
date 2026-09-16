import fs from 'node:fs';
import { processHook } from './lib/hooks.mjs';
import { drainCheckpoints } from './lib/checkpoints.mjs';
import { createTransport } from './lib/storage/index.mjs';
import { loadConfig, resolveHome } from './lib/config.mjs';

// Home precedence is shared with the CLI and the MCP server.
const homeArg = process.argv.indexOf('--home');
if (homeArg >= 0 && !process.argv[homeArg + 1]) throw new Error('--home requires a directory');
const { home: root } = resolveHome({ home: homeArg >= 0 ? process.argv[homeArg + 1] : '' });
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Hook payload exceeds bounded input');
  const input = JSON.parse(raw);
  const { config } = loadConfig(root);
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { result = processHook(config, process.argv[2], input); break; }
    catch (error) { if (!/Writer locked/.test(error.message) || attempt === 19) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  process.stdout.write(JSON.stringify(result ?? {}) + '\n');
  if (['Stop', 'PreCompact', 'SessionEnd'].includes(input.hook_event_name)) {
    const drained = drainCheckpoints(config, createTransport(config), { limit: 2 });
    if (drained.errors.length) {
      process.stderr.write('Memory checkpoint queued for maintenance; durable write not complete: ' + drained.errors.map((r) => r.error).join('; ') + '\n');
      process.exitCode = 1;
    }
  }
} catch (error) {
  // Do not prevent unrelated work when recall is unavailable. Definite command
  // violations use a deny result; transport failures are visible, never success.
  process.stderr.write(`agent-memory-hook unavailable: ${error.message}\n`);
  process.exitCode = 1;
}
