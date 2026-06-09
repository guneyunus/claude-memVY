'use strict';
// Test stub: stands in for worker-service.cjs. Prints the per-project env that
// bun-runner injected, so the injection can be asserted without a real worker.
process.stdout.write(JSON.stringify({
  dataDir: process.env.CLAUDE_MEM_DATA_DIR || null,
  port: process.env.CLAUDE_MEM_WORKER_PORT || null,
}));
