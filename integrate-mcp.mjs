#!/usr/bin/env node
// Compatibility entry point. The real implementation is `setup.mjs`, which binds
// MCP, hooks and the shared policy together; this file only performs the MCP half.
process.argv.push('--all-hosts', '--no-hooks', '--no-policy');
await import('./setup.mjs');
