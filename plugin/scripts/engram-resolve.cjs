'use strict';
// Plain-CommonJS mirror of src/engram/project-root.ts, required by bun-runner.js
// (which runs under `node`, BEFORE bun, and cannot import the TypeScript module).
// SOURCE OF TRUTH: src/engram/project-root.ts. Keep in sync — parity is asserted
// by tests/engram/engram-resolve.test.ts. Constants MUST match project-root.ts.
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { basename, join, resolve } = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');

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

/** Resolves true if the TCP port can be bound on localhost right now. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** GET /api/whoami on a local worker; resolves its JSON or null if unreachable. */
function whoami(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/whoami', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Resolve THIS project's worker port. Fast path: a previously-claimed
 * <dataDir>/worker.port — reused if idle, or if the worker bound there reports
 * my dataDir (ownership-verified via /api/whoami). Otherwise (first run or a
 * foreign squatter) bind-probe from the deterministic candidate to the first
 * free port, claim + persist it. Two never-before-seen projects therefore never
 * share a worker. Deps are injectable for testing.
 */
async function claimPort(dataDir, candidate, opts = {}) {
  const free = opts.isPortFree || isPortFree;
  const who = opts.whoami || whoami;
  const portFile = join(dataDir, 'worker.port');

  if (existsSync(portFile)) {
    const persisted = parseInt(String(readFileSync(portFile, 'utf8')).trim(), 10);
    if (Number.isInteger(persisted) && persisted >= PORT_BASE && persisted < PORT_BASE + PORT_RANGE) {
      if (await free(persisted)) return persisted;          // reserved & idle → reuse
      const info = await who(persisted);
      if (info && info.dataDir === dataDir) return persisted; // my worker → reuse
      // else: squatted by another project → fall through and re-claim
    }
  }

  for (let i = 0; i < PORT_RANGE; i++) {
    const p = PORT_BASE + (((candidate - PORT_BASE) + i) % PORT_RANGE);
    if (await free(p)) {
      try { mkdirSync(dataDir, { recursive: true }); writeFileSync(portFile, String(p)); } catch { /* best-effort */ }
      return p;
    }
  }
  return candidate; // degenerate: whole range busy — fall back to the candidate
}

module.exports = { resolveRuntimeEnv, resolveProjectRoot, projectWorkerPort, claimPort, isPortFree, PORT_BASE, PORT_RANGE };
