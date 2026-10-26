#!/usr/bin/env node
import { loadConfig } from '../lib/config.mjs';
import { loadEvents, reduceEvents, consumptionStatus, recall } from '../lib/core.mjs';
import { shadowRecall } from '../lib/search/shadow.mjs';

const args = process.argv.slice(2);
const options = {};
try {
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]; const value = args[i + 1];
    if (!['--home', '--workspace', '--query', '--max-units', '--endpoint', '--model'].includes(name)
      || !value || value.startsWith('--')) throw new Error('Invalid argument');
    if (options[name] !== undefined) throw new Error('Duplicate argument');
    options[name] = value;
  }
  if (!options['--home'] || !options['--workspace'] || !options['--query']) {
    throw new Error('Usage: node scripts/shadow-recall.mjs --home DIR --workspace ID --query TEXT [--max-units N]');
  }
  const { config } = loadConfig(options['--home']);
  const workspace = options['--workspace'];
  if (!config.topics.some((t) => t.workspace === workspace)) throw new Error('Unknown workspace id');
  const events = loadEvents(config);
  const result = await shadowRecall({ topics: config.topics, projection: reduceEvents(events),
    pendingTopics: consumptionStatus(config, events).pendingTopics,
    query: options['--query'], workspace,
    maxUnits: Number(options['--max-units'] ?? 200),
    embeddingOptions: { endpoint: options['--endpoint'], model: options['--model'] },
  });
  result.baseline = recall(config, options['--query'], workspace);
  console.log(JSON.stringify(result, null, 2));
  if (result.degraded) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
