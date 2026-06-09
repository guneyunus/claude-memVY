# Engram Plan B2 — Launcher Injection of Per-Project Runtime (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Follow superpowers:test-driven-development per task.

**Goal:** Make every hook invocation inject a **per-project** `CLAUDE_MEM_DATA_DIR` (= `<git-root>/.mem/.runtime`) and `CLAUDE_MEM_WORKER_PORT` (deterministic per project) into the worker process **before** `paths.ts` freezes `DATA_DIR` — by editing the launcher `bun-runner.js`, which spawns the worker with `env: process.env`. This routes each project to its own worker + DB. Fail-open: any resolver error leaves the env untouched (current global behavior), never breaking a hook.

**Architecture:** `bun-runner.js` runs under `node` and **spawns** `bun worker-service.cjs <args>` with `env: process.env` and preserved cwd (verified: `plugin/scripts/bun-runner.js:122-138`). Setting `process.env.CLAUDE_MEM_DATA_DIR`/`CLAUDE_MEM_WORKER_PORT` in the launcher before that spawn is inherited by the child, and `paths.ts:resolveDataDir()` reads `CLAUDE_MEM_DATA_DIR` first at the child's module-eval (`paths.ts:18-21,40`). Because `bun-runner.js` is plain hand-written `.js` (no build step, cannot import the TypeScript resolver), the resolution logic lives in a plain-CommonJS mirror `plugin/scripts/engram-resolve.cjs` whose parity with the tested TS `src/engram/project-root.ts` is asserted by a test.

**Tech Stack:** Node ESM (`bun-runner.js`), CommonJS (`engram-resolve.cjs`), Bun test runner, TypeScript (Plan B's `project-root.ts`).

**Reference:** spec §4.1/§4.6; carry-forward notes `docs/superpowers/plans/engram-carry-forward-notes.md`; Plan B foundation `src/engram/project-root.ts`.

## Scope boundaries (read before starting)

**IN scope (B2):** launcher injection of `DATA_DIR` + deterministic candidate `PORT`; the CJS resolver mirror; isolated verification.

**OUT of scope — deliberately deferred:**
- **Config split (Plan B3):** redirecting secret/settings reads to global `~/.engram`. Until B3 lands, a per-project `DATA_DIR` would make secrets per-project. **Therefore B2 must NOT be shipped to the live install** — do NOT run `npm run build-and-sync` or restart the live worker as part of this plan. B2 changes the repo + isolated tests only.
- **Port-collision auto-increment + `/api/whoami` (Plan B4):** B2 uses the deterministic candidate port with no collision handling. Two projects whose roots hash to the same port would share a worker. Documented limitation; B4 adds whoami-verified bind-or-increment.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `plugin/scripts/engram-resolve.cjs` | Plain-CJS mirror of `project-root.ts`: `resolveRuntimeEnv(cwd) → {root,dataDir,port,slug}`. Required by `bun-runner.js`. | Create |
| `plugin/scripts/bun-runner.js` | Inject per-project `DATA_DIR`+`PORT` env before spawning the worker (fail-open); fix stale `.claude-mem` fallback | Modify |
| `tests/engram/fixtures/stub-worker.cjs` | Test stub: prints the env the launcher injected | Create |
| `tests/engram/engram-resolve.test.ts` | Unit + parity tests for the CJS resolver | Create |
| `tests/engram/bun-runner-injection.test.ts` | Isolated integration: real `bun-runner.js` injects env into a spawned stub | Create |

---

## Task 1: `engram-resolve.cjs` — CommonJS resolver mirror

**Files:**
- Create: `plugin/scripts/engram-resolve.cjs`
- Test: `tests/engram/engram-resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/engram/engram-resolve.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveProjectRuntime, projectWorkerPort } from '../../src/engram/project-root.js';

const require = createRequire(import.meta.url);
const resolveMod = require('../../plugin/scripts/engram-resolve.cjs');

describe('engram-resolve.cjs', () => {
  it('exports resolveRuntimeEnv', () => {
    expect(typeof resolveMod.resolveRuntimeEnv).toBe('function');
  });

  it('matches the TS resolver (parity) for a temp git repo', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engram-cjs-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      const sub = join(dir, 'a', 'b');
      mkdirSync(sub, { recursive: true });
      const ts = resolveProjectRuntime(sub);
      const cjs = resolveMod.resolveRuntimeEnv(sub);
      expect(cjs.root).toBe(ts.root);
      expect(cjs.dataDir).toBe(ts.dataDir);
      expect(cjs.port).toBe(ts.port);
      expect(cjs.slug).toBe(ts.slug);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('port is in range and matches projectWorkerPort', () => {
    const dir = resolve('/tmp/acme/widget');
    expect(resolveMod.resolveRuntimeEnv(dir).port).toBe(projectWorkerPort(dir));
  });

  it('PORT_BASE/PORT_RANGE constants match the TS module', () => {
    expect(resolveMod.PORT_BASE).toBe(37800);
    expect(resolveMod.PORT_RANGE).toBe(150);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx bun test tests/engram/engram-resolve.test.ts`
Expected: FAIL — `Cannot find module '../../plugin/scripts/engram-resolve.cjs'`.

- [ ] **Step 3: Implement the CJS resolver**

Create `plugin/scripts/engram-resolve.cjs`:

```js
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx bun test tests/engram/engram-resolve.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/scripts/engram-resolve.cjs tests/engram/engram-resolve.test.ts
git commit -m "feat(engram): add CommonJS runtime resolver mirror for bun-runner"
```

---

## Task 2: Inject the per-project env in `bun-runner.js`

**Files:**
- Modify: `plugin/scripts/bun-runner.js`

- [ ] **Step 1: Add the fail-open injection after argument fixup**

In `plugin/scripts/bun-runner.js`, find this block (around lines 86–88):

```js
args[0] = fixBrokenScriptPath(args[0]);

const bunPath = findBun();
```

Replace it with:

```js
args[0] = fixBrokenScriptPath(args[0]);

// Engram: inject the per-project runtime (DATA_DIR + worker port) from the
// hook's cwd BEFORE spawning the worker, so the child's paths.ts freezes the
// project-local DATA_DIR and getWorkerPort selects the project-local port.
// SOURCE OF TRUTH for the values: src/engram/project-root.ts (mirrored in
// ./engram-resolve.cjs). Fail-open: any error leaves env untouched so the
// worker falls back to the global ~/.engram behavior — a hook is never broken.
try {
  const mod = await import('./engram-resolve.cjs');
  const resolveRuntimeEnv = mod.default?.resolveRuntimeEnv ?? mod.resolveRuntimeEnv;
  if (typeof resolveRuntimeEnv === 'function') {
    const rt = resolveRuntimeEnv(process.cwd());
    if (!process.env.CLAUDE_MEM_DATA_DIR) process.env.CLAUDE_MEM_DATA_DIR = rt.dataDir;
    if (!process.env.CLAUDE_MEM_WORKER_PORT) process.env.CLAUDE_MEM_WORKER_PORT = String(rt.port);
  }
} catch {
  // leave env as-is (global default); never break the hook on resolver failure
}

const bunPath = findBun();
```

- [ ] **Step 2: Fix the stale `.claude-mem` fallback (consistency)**

In the same file, find (around line 148):

```js
    const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
```

Replace with:

```js
    const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.engram');
```

- [ ] **Step 3: Sanity-run bun-runner with a no-op to confirm it still parses/loads**

Run (from repo root): `node plugin/scripts/bun-runner.js`
Expected: prints `Usage: node bun-runner.js <script> [args...]` and exits 1 (the existing arg-count guard at lines 81–84 — proves the file still parses and the injection block did not throw at load).

- [ ] **Step 4: Commit**

```bash
git add plugin/scripts/bun-runner.js
git commit -m "feat(engram): inject per-project DATA_DIR + worker port in bun-runner (fail-open)"
```

---

## Task 3: Isolated integration — real launcher injects env into a spawned stub

This proves the end-to-end injection WITHOUT a real worker and WITHOUT touching the live install: we run the actual `bun-runner.js` pointed at a stub "worker" that just prints the env it received.

**Files:**
- Create: `tests/engram/fixtures/stub-worker.cjs`
- Create: `tests/engram/bun-runner-injection.test.ts`

- [ ] **Step 1: Create the stub worker**

Create `tests/engram/fixtures/stub-worker.cjs`:

```js
'use strict';
// Test stub: stands in for worker-service.cjs. Prints the per-project env that
// bun-runner injected, so the injection can be asserted without a real worker.
process.stdout.write(JSON.stringify({
  dataDir: process.env.CLAUDE_MEM_DATA_DIR || null,
  port: process.env.CLAUDE_MEM_WORKER_PORT || null,
}));
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/engram/bun-runner-injection.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveProjectRuntime } from '../../src/engram/project-root.js';

const REPO = process.cwd();
const BUN_RUNNER = join(REPO, 'plugin', 'scripts', 'bun-runner.js');
const STUB = join(REPO, 'tests', 'engram', 'fixtures', 'stub-worker.cjs');

describe('bun-runner per-project injection (isolated)', () => {
  it('injects DATA_DIR + PORT from the hook cwd into the spawned child', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'engram-inject-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
      const expected = resolveProjectRuntime(repo);

      // Run the REAL launcher pointed at the stub "worker", with cwd = the temp
      // repo. bun-runner spawns `bun stub-worker.cjs hook claude-code context`
      // with env: process.env, so the stub prints the injected values.
      // Non-empty stdin avoids bun-runner's empty-payload diagnostic branch.
      const res = spawnSync('node', [BUN_RUNNER, STUB, 'hook', 'claude-code', 'context'], {
        cwd: repo,
        input: '{}',
        encoding: 'utf8',
        windowsHide: true,
      });

      if (res.status !== 0 || !res.stdout.trim()) {
        throw new Error(
          `bun-runner did not run the stub cleanly (status=${res.status}). ` +
          `stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}. ` +
          `If stderr mentions "Bun not found", install bun on PATH for this test.`,
        );
      }

      const printed = JSON.parse(res.stdout.trim());
      expect(printed.dataDir).toBe(expected.dataDir);
      expect(Number(printed.port)).toBe(expected.port);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT override an explicit CLAUDE_MEM_DATA_DIR already in the env', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'engram-inject2-')));
    const override = resolve(repo, 'custom-data');
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
      const res = spawnSync('node', [BUN_RUNNER, STUB, 'hook', 'claude-code', 'context'], {
        cwd: repo,
        input: '{}',
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: override },
      });
      if (res.status !== 0 || !res.stdout.trim()) {
        throw new Error(`stub did not run cleanly: status=${res.status} stderr=${res.stderr}`);
      }
      const printed = JSON.parse(res.stdout.trim());
      expect(printed.dataDir).toBe(override); // explicit env wins (fail-open guard)
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `npx bun test tests/engram/bun-runner-injection.test.ts`
Expected: PASS (2 tests). (Requires `bun` resolvable by `bun-runner.js`'s `findBun()` — `where bun`/`which bun` or `~/.bun/bin`. This dev environment has bun on PATH; if a CI lacks it, this test will fail loudly with the "Bun not found" hint rather than silently pass.)

- [ ] **Step 4: Commit**

```bash
git add tests/engram/fixtures/stub-worker.cjs tests/engram/bun-runner-injection.test.ts
git commit -m "test(engram): isolated bun-runner injection integration (stub worker)"
```

---

## Task 4: Full verification (no live worker)

**Files:** none.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck:root`
Expected: clean. (Only `.cjs`/`.js`/test files added; `engram-resolve.cjs` is not part of the TS project, but the test imports it via `createRequire` so tsc does not type-check it.)

- [ ] **Step 2: Full engram test directory**

Run: `npx bun test tests/engram/`
Expected: PASS — project-root (9) + global-config (3) + engram-resolve (4) + bun-runner-injection (2) = **18 tests**.

- [ ] **Step 3: Confirm the live install was NOT modified**

Run: `git status --short`
Expected: clean working tree. Confirm NO `npm run build-and-sync` was run and NO worker was started/restarted during this plan (B2 must not go live until Plan B3 config-split lands).

---

## Definition of done (Plan B2)

- `plugin/scripts/engram-resolve.cjs` mirrors `project-root.ts` (parity test green).
- `bun-runner.js` injects per-project `CLAUDE_MEM_DATA_DIR` + `CLAUDE_MEM_WORKER_PORT` before spawn, fail-open, and does not override an explicit env.
- Isolated integration proves a real `bun-runner.js` run injects the correct values for a temp git repo's cwd (no real worker, no live install touched).
- `npx bun test tests/engram/` green (18 tests); `npm run typecheck:root` clean.
- No `build-and-sync`, no worker restart, working tree clean.

## Self-review notes (author)

- **Spec coverage:** Implements the launcher-injection half of spec §4.1/§4.6 (per-project DATA_DIR/PORT before module-load), using the verified mechanism (bun-runner spawns with `env: process.env`). Config-split (§4.5) is Plan B3; port-collision + `/api/whoami` is Plan B4 — both explicitly out of scope and called out as required follow-ups (carry-forward notes).
- **No placeholders:** complete code for every file + test; exact commands and expected outputs.
- **Drift guard:** `engram-resolve.cjs` duplicates `project-root.ts` by necessity (node-land launcher cannot import TS). The parity test (`engram-resolve.test.ts`) asserts byte-equal results, failing if either drifts. Constants (`PORT_BASE`/`PORT_RANGE`) are asserted equal too.
- **Safety:** the injection is fully `try/catch` fail-open and respects a pre-existing `CLAUDE_MEM_DATA_DIR` (so Docker/tests that set it explicitly win). The plan never installs to the live plugin (no build-and-sync, no worker restart), so the user's running claude-mem is untouched. Known limitation (deterministic port, no collision handling) is documented and deferred to B4.
- **Verification realism:** the stub-worker integration runs the REAL `bun-runner.js` (not a reimplementation), so it catches injection-point and CJS-import-resolution bugs; it fails loudly if `bun` is absent rather than passing vacuously.
