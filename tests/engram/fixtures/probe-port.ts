// Prints getWorkerPort() and whether reading it created a PER-PROJECT settings.json
// (it must not — the port default must come from the GLOBAL settings). Run via bun
// with CLAUDE_MEM_DATA_DIR + ENGRAM_GLOBAL_DIR set and CLAUDE_MEM_WORKER_PORT unset.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkerPort } from '../../../src/shared/worker-utils.js';

const port = getWorkerPort();
const perProjectSettings = join(process.env.CLAUDE_MEM_DATA_DIR ?? '', 'settings.json');

process.stdout.write(JSON.stringify({
  workerPort: port,
  perProjectSettingsCreated: existsSync(perProjectSettings),
}));
