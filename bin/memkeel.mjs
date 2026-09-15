#!/usr/bin/env node
// Memkeel CLI entry point.
//
// The implementation lives in ../memory.mjs so that existing hooks, scripts and
// documentation that invoke it keep working unchanged; this shim only provides the
// stable `memkeel` command name for the npm bin.
import '../memory.mjs';
