# Engram Plan B4 — `/api/whoami` + Per-Project Port Collision (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps. Follow superpowers:test-driven-development per task.

**Goal:** Eliminate the per-project worker port collision that B2 left as a known limitation. Each project claims a real, free port (deterministic candidate, incrementing on conflict), persists it to `<dataDir>/worker.port`, and verifies worker ownership via a new `/api/whoami` endpoint so a stale/squatted port is detected and re-claimed instead of silently sharing another project's worker + DB.

**Architecture:**
- `engram-resolve.cjs` gains `claimPort(dataDir, candidate, {isPortFree, whoami})` — persisted-port fast path (reuse if idle, or if the worker there reports my `dataDir`), else bind-probe from the candidate to the first free port, claim + persist it. Dependency-injected (`isPortFree`, `whoami`) so it is unit-testable WITHOUT a real worker. `resolveRuntimeEnv` is UNCHANGED (so the B2 parity test still holds).
- `bun-runner.js` awaits `claimPort` to set `CLAUDE_MEM_WORKER_PORT` (only when not already set), inside the existing fail-open try/catch.
- `/api/whoami` core GET route returns `{ dataDir, dbPath, port }` via a small `whoamiInfo()` function (subprocess-probe testable).

**Per-hook cost:** on the fast path with the worker running, `claimPort` does one failed bind + one localhost `/api/whoami` GET (~a few ms). Acceptable; documented. (A timestamp-cached trust window is a possible future optimization.)

**Tech Stack:** Node ESM (`bun-runner.js`), CommonJS (`engram-resolve.cjs`, with `node:net`/`node:http`), TypeScript (`whoami.ts`), Bun test (dependency injection + subprocess probes).

**Reference:** carry-forward notes (B4 section) — port state MUST be `<dataDir>/worker.port` (NOT `settings.json`, which is now global per B3); single-instance keys on absolute `root`. Spec §4.1.

## Scope

**IN:** `claimPort` + `worker.port` persistence + bind-probe-increment + whoami squat-recovery; `/api/whoami`; isolated tests. After B4, the runtime trio (B2 injection + B3 config-split + B4 collision) is complete and **go-live-ready** (still: this plan does NOT run build-and-sync).

**OUT:** wiring `/api/whoami` into anything beyond `claimPort` (it's the ownership primitive; `claimPort` is its first consumer). The known residual: a TOCTOU window between "port probed free" and "worker binds it" is still handled by the worker's existing `EADDRINUSE` path (unchanged).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `plugin/scripts/engram-resolve.cjs` | Add `claimPort` + `isPortFree` + `whoami` (DI-friendly); keep `resolveRuntimeEnv` unchanged | Modify |
| `plugin/scripts/bun-runner.js` | `await claimPort(...)` to set `CLAUDE_MEM_WORKER_PORT` (fail-open, guarded) | Modify |
| `src/services/server/whoami.ts` | `whoamiInfo() → { dataDir, dbPath, port }` | Create |
| `src/services/server/Server.ts` | Register `GET /api/whoami` (mirrors `/api/version`) | Modify |
| `tests/engram/claim-port.test.ts` | Unit tests for `claimPort` (injected deps) + `isPortFree` | Create |
| `tests/engram/fixtures/probe-whoami.ts` | Subprocess probe printing `whoamiInfo()` | Create |
| `tests/engram/whoami.test.ts` | Subprocess test for `whoamiInfo()` | Create |
| `tests/engram/bun-runner-injection.test.ts` | Update: assert claimed port in range + `worker.port` written | Modify |

---

## Task 1: `claimPort` in `engram-resolve.cjs`

**Files:**
- Modify: `plugin/scripts/engram-resolve.cjs`
- Test: `tests/engram/claim-port.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/engram/claim-port.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

const require = createRequire(import.meta.url);
const { claimPort, isPortFree, PORT_BASE, PORT_RANGE } = require('../../plugin/scripts/engram-resolve.cjs');

const freeAll = { isPortFree: async () => true, whoami: async () => null };

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('claimPort', () => {
  it('claims the candidate when it is free and persists it to worker.port', async () => {
    const dir = tmp('engram-claim-');
    try {
      const port = await claimPort(dir, PORT_BASE + 5, freeAll);
      expect(port).toBe(PORT_BASE + 5);
      expect(readFileSync(join(dir, 'worker.port'), 'utf8').trim()).toBe(String(PORT_BASE + 5));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('increments to the next free port when the candidate is occupied', async () => {
    const dir = tmp('engram-claim2-');
    try {
      const isPortFree = async (p: number) => p !== PORT_BASE + 5; // candidate busy
      const port = await claimPort(dir, PORT_BASE + 5, { isPortFree, whoami: async () => null });
      expect(port).toBe(PORT_BASE + 6);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reuses a persisted port that is idle (free) without re-claiming', async () => {
    const dir = tmp('engram-claim3-');
    try {
      writeFileSync(join(dir, 'worker.port'), String(PORT_BASE + 10));
      const isPortFree = async (p: number) => p === PORT_BASE + 10; // persisted idle
      const port = await claimPort(dir, PORT_BASE + 99, { isPortFree, whoami: async () => null });
      expect(port).toBe(PORT_BASE + 10);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reuses a persisted port whose worker reports MY dataDir', async () => {
    const dir = tmp('engram-claim4-');
    try {
      writeFileSync(join(dir, 'worker.port'), String(PORT_BASE + 10));
      const port = await claimPort(dir, PORT_BASE + 99, {
        isPortFree: async () => false,         // occupied
        whoami: async () => ({ dataDir: dir }), // ...by my worker
      });
      expect(port).toBe(PORT_BASE + 10);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('re-claims when a persisted port is squatted by another project (whoami mismatch)', async () => {
    const dir = tmp('engram-claim5-');
    try {
      writeFileSync(join(dir, 'worker.port'), String(PORT_BASE + 10));
      const isPortFree = async (p: number) => p >= PORT_BASE + 20; // 10 busy(squatter); 20+ free
      const port = await claimPort(dir, PORT_BASE + 20, {
        isPortFree,
        whoami: async () => ({ dataDir: '/some/other/project' }),
      });
      expect(port).toBe(PORT_BASE + 20);
      expect(readFileSync(join(dir, 'worker.port'), 'utf8').trim()).toBe(String(PORT_BASE + 20));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('wraps within the port range', () => {
    // sanity: the range constants are what we expect
    expect(PORT_BASE).toBe(37800);
    expect(PORT_RANGE).toBe(150);
  });
});

describe('isPortFree (real)', () => {
  it('returns false for a port currently bound, true after release', async () => {
    const srv = createServer();
    const port: number = await new Promise((res) => srv.listen(0, '127.0.0.1', () => res((srv.address() as any).port)));
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(await isPortFree(port)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx bun test tests/engram/claim-port.test.ts`
Expected: FAIL — `claimPort`/`isPortFree` are not exported from `engram-resolve.cjs` yet.

- [ ] **Step 3: Implement `claimPort` + `isPortFree`**

In `plugin/scripts/engram-resolve.cjs`, add `require`s for `net`/`http`/`fs` near the top (after the existing requires):

```js
const net = require('node:net');
const http = require('node:http');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
```

Then add these functions BEFORE the `module.exports` line:

```js
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
```

Update the `module.exports` line to add the new exports:

```js
module.exports = { resolveRuntimeEnv, resolveProjectRoot, projectWorkerPort, claimPort, isPortFree, PORT_BASE, PORT_RANGE };
```

(Note: `join` and the path/crypto requires already exist at the top of the file from B2 — do not duplicate them. Only add `net`, `http`, and the `fs` destructure if not already present.)

- [ ] **Step 4: Run to verify pass**

Run: `npx bun test tests/engram/claim-port.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/scripts/engram-resolve.cjs tests/engram/claim-port.test.ts
git commit -m "feat(engram): add claimPort (bind-probe + persist + whoami recovery)"
```

---

## Task 2: `bun-runner.js` claims the port; update the integration test

**Files:**
- Modify: `plugin/scripts/bun-runner.js`
- Modify: `tests/engram/bun-runner-injection.test.ts`

- [ ] **Step 1: Use `claimPort` in the injection block**

In `plugin/scripts/bun-runner.js`, find the injection body (inside the existing try/catch):

```js
  const mod = await import('./engram-resolve.cjs');
  const resolveRuntimeEnv = mod.default?.resolveRuntimeEnv ?? mod.resolveRuntimeEnv;
  if (typeof resolveRuntimeEnv === 'function') {
    const rt = resolveRuntimeEnv(process.cwd());
    if (!process.env.CLAUDE_MEM_DATA_DIR) process.env.CLAUDE_MEM_DATA_DIR = rt.dataDir;
    if (!process.env.CLAUDE_MEM_WORKER_PORT) process.env.CLAUDE_MEM_WORKER_PORT = String(rt.port);
  }
```

Replace it with:

```js
  const mod = await import('./engram-resolve.cjs');
  const resolveRuntimeEnv = mod.default?.resolveRuntimeEnv ?? mod.resolveRuntimeEnv;
  const claimPort = mod.default?.claimPort ?? mod.claimPort;
  if (typeof resolveRuntimeEnv === 'function') {
    const rt = resolveRuntimeEnv(process.cwd());
    if (!process.env.CLAUDE_MEM_DATA_DIR) process.env.CLAUDE_MEM_DATA_DIR = rt.dataDir;
    if (!process.env.CLAUDE_MEM_WORKER_PORT) {
      // Claim a real free port for this project (deterministic candidate, then
      // increment on conflict), persisted to <dataDir>/worker.port. Falls back
      // to the bare candidate if claimPort is unavailable.
      const port = typeof claimPort === 'function' ? await claimPort(rt.dataDir, rt.port) : rt.port;
      process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    }
  }
```

- [ ] **Step 2: Update the integration test for claimed ports**

In `tests/engram/bun-runner-injection.test.ts`, the first test currently asserts the printed port equals the bare candidate `resolveProjectRuntime(repo).port`. Because the port is now *claimed* (may increment if the candidate is busy, and is written to `worker.port`), change the FIRST test's two assertions:

Find:

```ts
      const printed = JSON.parse(res.stdout.trim());
      expect(printed.dataDir).toBe(expected.dataDir);
      expect(Number(printed.port)).toBe(expected.port);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
```

Replace with:

```ts
      const printed = JSON.parse(res.stdout.trim());
      expect(printed.dataDir).toBe(expected.dataDir);
      // Port is CLAIMED now: in range, and >= the candidate (claimPort probes
      // from the candidate upward). The chosen port is persisted to worker.port.
      const claimed = Number(printed.port);
      expect(claimed).toBeGreaterThanOrEqual(expected.port);
      expect(claimed).toBeLessThan(37950);
      expect(existsSync(join(expected.dataDir, 'worker.port'))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
```

And add `existsSync` to the test's fs import at the top of the file (currently `import { mkdtempSync, rmSync, realpathSync } from 'node:fs';`):

```ts
import { mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
```

(The second test — explicit `CLAUDE_MEM_WORKER_PORT` override — is unchanged: when the port env is already set, `claimPort` is NOT called, so the override is still preserved verbatim.)

- [ ] **Step 3: Run the integration test**

Run: `npx bun test tests/engram/bun-runner-injection.test.ts`
Expected: PASS (2 tests). The first now asserts a claimed, persisted port; the override test still preserves the explicit value.

- [ ] **Step 4: Commit**

```bash
git add plugin/scripts/bun-runner.js tests/engram/bun-runner-injection.test.ts
git commit -m "feat(engram): bun-runner claims a real per-project port via claimPort"
```

---

## Task 3: `/api/whoami` route

**Files:**
- Create: `src/services/server/whoami.ts`
- Modify: `src/services/server/Server.ts`
- Create: `tests/engram/fixtures/probe-whoami.ts`
- Test: `tests/engram/whoami.test.ts`

- [ ] **Step 1: Write the failing whoami probe test**

Create `tests/engram/fixtures/probe-whoami.ts`:

```ts
// Prints whoamiInfo() for the current env (CLAUDE_MEM_DATA_DIR / ENGRAM_GLOBAL_DIR).
import { whoamiInfo } from '../../../src/services/server/whoami.js';
process.stdout.write(JSON.stringify(whoamiInfo()));
```

Create `tests/engram/whoami.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const PROBE = join(REPO, 'tests', 'engram', 'fixtures', 'probe-whoami.ts');

describe('whoamiInfo', () => {
  it('reports the per-project dataDir + dbPath and a numeric port', () => {
    const proj = resolve(mkdtempSync(join(tmpdir(), 'engram-who-')));
    const glob = resolve(mkdtempSync(join(tmpdir(), 'engram-whoglob-')));
    try {
      const env: Record<string, string | undefined> = {
        ...process.env, CLAUDE_MEM_DATA_DIR: proj, ENGRAM_GLOBAL_DIR: glob,
      };
      delete env.CLAUDE_MEM_WORKER_PORT;
      const res = spawnSync('npx', ['bun', PROBE], { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 30000, env });
      if (res.status !== 0 || !res.stdout.trim()) {
        throw new Error(`probe failed: status=${res.status} stderr=${res.stderr}`);
      }
      const out = JSON.parse(res.stdout.trim());
      expect(out.dataDir).toBe(proj);
      expect(out.dbPath).toBe(join(proj, 'engram.db'));
      expect(typeof out.port).toBe('number');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx bun test tests/engram/whoami.test.ts`
Expected: FAIL — `src/services/server/whoami.ts` does not exist.

- [ ] **Step 3: Implement `whoamiInfo()` and register the route**

Create `src/services/server/whoami.ts`:

```ts
import { DATA_DIR, DB_PATH } from '../../shared/paths.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

export interface WhoamiInfo {
  /** The per-project data dir this worker is bound to. */
  dataDir: string;
  /** The per-project SQLite db file. */
  dbPath: string;
  /** The port this worker resolves to. */
  port: number;
}

/** Identity of THIS worker — used by claimPort to verify port ownership. */
export function whoamiInfo(): WhoamiInfo {
  return { dataDir: DATA_DIR, dbPath: DB_PATH, port: getWorkerPort() };
}
```

In `src/services/server/Server.ts`, add the import near the other imports (after line 16):

```ts
import { whoamiInfo } from './whoami.js';
```

Then register the route in `setupCoreRoutes`, right after the `/api/version` route (after the block ending at line 249):

```ts
    this.app.get('/api/whoami', (_req: Request, res: Response) => {
      res.status(200).json(whoamiInfo());
    });
```

- [ ] **Step 4: Run to verify pass**

Run: `npx bun test tests/engram/whoami.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/services/server/whoami.ts src/services/server/Server.ts tests/engram/fixtures/probe-whoami.ts tests/engram/whoami.test.ts
git commit -m "feat(engram): add /api/whoami endpoint (worker identity for port ownership)"
```

---

## Task 4: Full verification

**Files:** none.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck:root`
Expected: clean. (`whoami.ts` imports `DATA_DIR`/`DB_PATH` from paths and `getWorkerPort` from worker-utils; `Server.ts` imports `whoamiInfo`. `engram-resolve.cjs` is not part of the TS project.)

- [ ] **Step 2: Full engram suite**

Run: `npx bun test tests/engram/`
Expected: PASS — project-root (9) + global-config (3) + engram-resolve (4) + bun-runner-injection (2) + config-split (3) + claim-port (7) + whoami (1) = **29 tests**.

- [ ] **Step 3: B2 parity still holds (resolveRuntimeEnv unchanged)**

Run: `npx bun test tests/engram/engram-resolve.test.ts`
Expected: PASS (4) — `resolveRuntimeEnv` still returns the bare candidate and matches the TS resolver. (claimPort is additive; it did NOT change resolveRuntimeEnv.)

- [ ] **Step 4: No live-install side effects**

Run: `git status --short`
Expected: clean. No build-and-sync, no worker restart.

---

## Definition of done (Plan B4)

- `claimPort` claims a free per-project port from the deterministic candidate, persists it to `<dataDir>/worker.port`, reuses it on subsequent runs, and re-claims when a persisted port is squatted (whoami mismatch). Two new projects never collide.
- `bun-runner.js` sets `CLAUDE_MEM_WORKER_PORT` via `claimPort` (fail-open; respects an explicit override).
- `/api/whoami` returns `{ dataDir, dbPath, port }`.
- `npx bun test tests/engram/` green (29 tests); B2 parity intact; typecheck clean; working tree clean.
- The runtime trio (B2 + B3 + B4) is now complete — go-live-ready (go-live = a later, separate step).

## Self-review notes (author)

- **Spec coverage:** Completes spec §4.1's port-collision + ownership requirement and the carry-forward B4 items (bind-or-increment, `<dataDir>/worker.port` not settings.json, whoami ownership, single-instance keyed on root via the per-project dataDir).
- **No placeholders:** every function + test is complete; commands have expected output.
- **Parity preserved:** `resolveRuntimeEnv` is untouched, so the B2 parity test (cjs vs TS) keeps passing — `claimPort` is a separate, additive export. Verified explicitly in Task 4 Step 3.
- **Testability without a real worker:** `claimPort` takes injected `isPortFree`/`whoami`, so all five branches (claim/increment/reuse-idle/reuse-mine/re-claim-squatted) are deterministic unit tests; `isPortFree` is separately tested against a real bound socket; `/api/whoami` is tested via `whoamiInfo()` subprocess probe (no Server spin-up). The bun-runner integration uses the real launcher + real `claimPort` against a temp repo.
- **Safety:** injection stays inside bun-runner's fail-open try/catch; `claimPort` write is best-effort (try/catch); explicit `CLAUDE_MEM_WORKER_PORT` still wins. No build-and-sync.
- **Documented cost/limit:** per-hook fast-path does one failed-bind + one localhost whoami when the worker is up (~few ms); the probe-free→worker-binds TOCTOU window remains covered by the worker's existing EADDRINUSE handling. Both noted, not silently dropped.
