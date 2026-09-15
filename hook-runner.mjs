import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processHook } from './lib/hooks.mjs';
import { drainCheckpoints } from './lib/checkpoints.mjs';
import { createTransport } from './lib/storage/index.mjs';
import { applyLayout } from './lib/layout.mjs';

const homeArg = process.argv.indexOf('--home');
const root = homeArg >= 0 ? process.argv[homeArg + 1] : process.env.MEMKEEL_HOME ?? path.join(os.homedir(), '.memkeel');
if (!root) throw new Error('--home requires a directory');
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Hook payload exceeds bounded input');
  const input = JSON.parse(raw);
  const config = applyLayout({ ...JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')), policyRoot: root });
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
