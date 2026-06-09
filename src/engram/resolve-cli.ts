#!/usr/bin/env bun
// Inspector: prints the resolved project-local runtime for a cwd as JSON.
// Usage: bun src/engram/resolve-cli.ts [cwd]
// Plan B2 will reuse resolveProjectRuntime() at the process entry to set
// CLAUDE_MEM_DATA_DIR / CLAUDE_MEM_WORKER_PORT before the paths module loads.
import { resolveProjectRuntime } from './project-root.js';

const cwd = process.argv[2] ?? process.cwd();
process.stdout.write(JSON.stringify(resolveProjectRuntime(cwd), null, 2) + '\n');
