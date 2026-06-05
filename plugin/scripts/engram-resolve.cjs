'use strict';
// Plain-CommonJS mirror of src/engram/project-root.ts, required by bun-runner.js
// (which runs under `node`, BEFORE bun, and cannot import the TypeScript module).
// SOURCE OF TRUTH: src/engram/project-root.ts. Keep in sync — parity is asserted
// by tests/engram/engram-resolve.test.ts. Constants MUST match project-root.ts.
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { basename, join, resolve } = require('node:path');

const PORT_BASE = 37800;
const PORT_RANGE = 150; // ports 37800..37949

function resolveProjectRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
    return out ? resolve(out) : resolve(cwd);
  } catch {
    return resolve(cwd);
  }
}

function projectWorkerPort(root) {
  const digest = createHash('sha1').update(resolve(root)).digest();
  return PORT_BASE + (digest.readUInt32BE(0) % PORT_RANGE);
}

function resolveRuntimeEnv(cwd) {
  const root = resolveProjectRoot(cwd);
  return {
    root,
    dataDir: join(root, '.mem', '.runtime'),
    port: projectWorkerPort(root),
    slug: basename(root),
  };
}

module.exports = { resolveRuntimeEnv, resolveProjectRoot, projectWorkerPort, PORT_BASE, PORT_RANGE };
