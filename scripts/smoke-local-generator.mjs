#!/usr/bin/env node
import { generatorSmoke } from '../lib/knowledge/generator-smoke.mjs';

try {
  const args = process.argv.slice(2); const options = {}; const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!['--model', '--endpoint'].includes(key) || seen.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/smoke-local-generator.mjs --model LOADED_MODEL [--endpoint LOOPBACK_URL]');
    }
    seen.add(key); options[key.slice(2)] = args[++i];
  }
  console.log(JSON.stringify(await generatorSmoke(options), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
