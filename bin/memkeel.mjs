#!/usr/bin/env node
// Memkeel CLI entry point.
//
// The implementation lives in ../memory.mjs so that existing hooks, scripts and
// documentation that invoke it keep working unchanged; this shim only provides the
// stable `memkeel` command name for the npm bin.
if (process.argv[2] === 'knowledge') {
  process.argv.splice(2, 1);
  await import('../scripts/knowledge-upgrade.mjs');
} else {
  await import('../memory.mjs');
}
