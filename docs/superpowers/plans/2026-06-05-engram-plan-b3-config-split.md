# Engram Plan B3 — Config Split (secrets global, state per-project) (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Follow superpowers:test-driven-development per task.

**Goal:** Keep user **secrets and config** (`settings.json` + `.env`) at the GLOBAL `~/.engram` location regardless of a per-project `CLAUDE_MEM_DATA_DIR`, while project **runtime state** (DB, chroma, logs, pid) follows the per-project data dir. Without this, B2's per-project `DATA_DIR` would silently move API keys per project, forcing re-entry.

**Architecture:** Redirect the three settings/secret accessors in the single path authority `src/shared/paths.ts` to a new `GLOBAL_CONFIG_DIR` (= `globalConfigDir()` from `src/engram/global-config.ts`, i.e. `ENGRAM_GLOBAL_DIR ?? ~/.engram`). Because ~15 downstream read-sites consume `paths.settings()` / `USER_SETTINGS_PATH` / `paths.envFile()`, redirecting those three definitions redirects them all at once. The only sites that construct the settings path manually — `getWorkerPort`/`getWorkerHost` in `src/shared/worker-utils.ts` — are fixed to use the (now-global) `USER_SETTINGS_PATH`.

**Safety property:** When no per-project env is set, `DATA_DIR == GLOBAL_CONFIG_DIR == ~/.engram`, so `paths.settings()` is **unchanged**. The redirect only diverges once `CLAUDE_MEM_DATA_DIR` is set per-project (B2). So B3 is a no-op for the current live install and safe to land before B2 goes live. (Still: do NOT run `build-and-sync` / restart the live worker in this plan.)

**Tech Stack:** TypeScript, Bun test runner, Node built-ins. Verification via subprocess (`npx bun <probe>`) so each case loads `paths.ts` fresh with controlled env.

**Reference:** spec §4.5; carry-forward notes (config-split ordering); B2 plan; `src/engram/global-config.ts` (Plan B).

## Scope

**IN:** redirect `settings.json` + `.env` reads to global; fix `getWorkerPort`/`getWorkerHost`; isolated subprocess tests.

**OUT (unchanged, stay per-project under `DATA_DIR`):** DB (`DB_PATH`/`engram.db`), chroma, logs, pid file, archives, corpora, transcripts state, vector-db, observer-sessions. Only `settings.json` and `.env` move global. Per-project model/flag overrides are a future enhancement, not here.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/shared/paths.ts` | Add `GLOBAL_CONFIG_DIR`; redirect `USER_SETTINGS_PATH`, `paths.settings()`, `paths.envFile()` to it | Modify |
| `src/shared/worker-utils.ts` | `getWorkerPort`/`getWorkerHost` read the global `USER_SETTINGS_PATH` instead of `join(DATA_DIR, 'settings.json')` | Modify |
| `tests/engram/fixtures/probe-paths.ts` | Subprocess probe: prints resolved settings/env/db/chroma paths | Create |
| `tests/engram/fixtures/probe-port.ts` | Subprocess probe: prints `getWorkerPort()` + whether a per-project settings.json was created | Create |
| `tests/engram/config-split.test.ts` | Isolated tests (path redirect + worker-port read source) | Create |

---

## Task 1: Redirect settings + .env to `GLOBAL_CONFIG_DIR` in `paths.ts`

**Files:**
- Modify: `src/shared/paths.ts`
- Create: `tests/engram/fixtures/probe-paths.ts`
- Test: `tests/engram/config-split.test.ts`

- [ ] **Step 1: Create the path probe fixture**

Create `tests/engram/fixtures/probe-paths.ts`:

```ts
// Prints Engram path resolution for the current env. Run via:
//   bun tests/engram/fixtures/probe-paths.ts
// with CLAUDE_MEM_DATA_DIR (per-project) and ENGRAM_GLOBAL_DIR (global) set.
import { USER_SETTINGS_PATH, DB_PATH, GLOBAL_CONFIG_DIR, DATA_DIR, paths } from '../../../src/shared/paths.js';

process.stdout.write(JSON.stringify({
  globalDir: GLOBAL_CONFIG_DIR,
  dataDir: DATA_DIR,
  settingsConst: USER_SETTINGS_PATH,
  settingsFn: paths.settings(),
  envFile: paths.envFile(),
  db: DB_PATH,
  chroma: paths.chroma(),
}));
```

- [ ] **Step 2: Write the failing tests**

Create `tests/engram/config-split.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const PROBE_PATHS = join(REPO, 'tests', 'engram', 'fixtures', 'probe-paths.ts');

function runProbe(probe: string, overrides: Record<string, string>): any {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  delete env.CLAUDE_MEM_WORKER_PORT; // never let the runner's env override the file under test
  const res = spawnSync('npx', ['bun', probe], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 30000, env,
  });
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(`probe failed: status=${res.status} stdout=${JSON.stringify(res.stdout)} stderr=${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

describe('config split — path redirection', () => {
  it('settings + .env resolve GLOBAL; db + chroma resolve PER-PROJECT', () => {
    const proj = resolve(mkdtempSync(join(tmpdir(), 'engram-proj-')));
    const glob = resolve(mkdtempSync(join(tmpdir(), 'engram-glob-')));
    try {
      const out = runProbe(PROBE_PATHS, { CLAUDE_MEM_DATA_DIR: proj, ENGRAM_GLOBAL_DIR: glob });
      expect(out.settingsConst).toBe(join(glob, 'settings.json'));
      expect(out.settingsFn).toBe(join(glob, 'settings.json'));
      expect(out.envFile).toBe(join(glob, '.env'));
      expect(out.db).toBe(join(proj, 'engram.db'));
      expect(out.chroma).toBe(join(proj, 'chroma'));
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('no-divergence: when DATA_DIR equals the global dir, settings and state coincide', () => {
    const dir = resolve(mkdtempSync(join(tmpdir(), 'engram-same-')));
    try {
      const out = runProbe(PROBE_PATHS, { CLAUDE_MEM_DATA_DIR: dir, ENGRAM_GLOBAL_DIR: dir });
      expect(out.settingsConst).toBe(join(dir, 'settings.json'));
      expect(out.db).toBe(join(dir, 'engram.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx bun test tests/engram/config-split.test.ts`
Expected: FAIL — `probe-paths.ts` imports `GLOBAL_CONFIG_DIR` from `paths.ts`, which does not exist yet (the probe throws at import → non-zero status → the test's thrown error).

- [ ] **Step 4: Implement the redirect in `paths.ts`**

In `src/shared/paths.ts`:

(a) Add the import after the existing `logger` import (the file's import block, around line 7):

```ts
import { globalConfigDir } from '../engram/global-config.js';
```

(b) Add `GLOBAL_CONFIG_DIR` right after the `DATA_DIR` export (around line 40):

```ts
export const DATA_DIR = resolveDataDir();
// Engram config split: user secrets/config (settings.json, .env) live here,
// GLOBAL across all projects, even when DATA_DIR is per-project (Plan B2/B3).
export const GLOBAL_CONFIG_DIR = globalConfigDir();
```

(c) Redirect `USER_SETTINGS_PATH` (was `join(DATA_DIR, 'settings.json')`):

```ts
export const USER_SETTINGS_PATH = join(GLOBAL_CONFIG_DIR, 'settings.json');
```

(d) In the `paths` object, redirect `settings` (was `join(DATA_DIR, 'settings.json')`):

```ts
  settings: () => join(GLOBAL_CONFIG_DIR, 'settings.json'),
```

(e) In the `paths` object, redirect `envFile` (was `join(DATA_DIR, '.env')`):

```ts
  envFile: () => join(GLOBAL_CONFIG_DIR, '.env'),
```

(Leave everything else — `DB_PATH`, `chroma`, `LOGS_DIR`, `workerPid`, `corpora`, `vectorDb`, etc. — keyed off `DATA_DIR` unchanged.)

- [ ] **Step 5: Run to verify pass**

Run: `npx bun test tests/engram/config-split.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/paths.ts tests/engram/fixtures/probe-paths.ts tests/engram/config-split.test.ts
git commit -m "feat(engram): config split — settings.json + .env resolve to global ~/.engram"
```

---

## Task 2: `getWorkerPort`/`getWorkerHost` read the global settings

**Files:**
- Modify: `src/shared/worker-utils.ts`
- Create: `tests/engram/fixtures/probe-port.ts`
- Test: `tests/engram/config-split.test.ts` (append)

- [ ] **Step 1: Create the worker-port probe fixture**

Create `tests/engram/fixtures/probe-port.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing test**

Append to `tests/engram/config-split.test.ts`:

```ts
import { writeFileSync } from 'node:fs';

const PROBE_PORT = join(REPO, 'tests', 'engram', 'fixtures', 'probe-port.ts');

describe('config split — worker port source', () => {
  it('getWorkerPort reads the GLOBAL settings.json and does not create a per-project one', () => {
    const proj = resolve(mkdtempSync(join(tmpdir(), 'engram-proj2-')));
    const glob = resolve(mkdtempSync(join(tmpdir(), 'engram-glob2-')));
    try {
      // Distinctive port in the GLOBAL settings; per-project dir has no settings.
      writeFileSync(join(glob, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '38500' }));
      const out = runProbe(PROBE_PORT, { CLAUDE_MEM_DATA_DIR: proj, ENGRAM_GLOBAL_DIR: glob });
      expect(out.workerPort).toBe(38500);                // came from GLOBAL settings.json
      expect(out.perProjectSettingsCreated).toBe(false); // per-project dir untouched
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx bun test tests/engram/config-split.test.ts`
Expected: the new test FAILS — current `getWorkerPort` reads `join(DATA_DIR='proj', 'settings.json')`, which does not contain `38500` (it creates the per-project file with defaults), so `workerPort` is the uid-derived default (not 38500) and/or `perProjectSettingsCreated` is `true`.

- [ ] **Step 4: Fix `worker-utils.ts`**

In `src/shared/worker-utils.ts`:

(a) Add `USER_SETTINGS_PATH` to the existing paths import (line 8, currently `import { MARKETPLACE_ROOT, DATA_DIR } from "./paths.js";`):

```ts
import { MARKETPLACE_ROOT, DATA_DIR, USER_SETTINGS_PATH } from "./paths.js";
```

(b) Replace BOTH occurrences (in `getWorkerPort` and `getWorkerHost`) of:

```ts
  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
```

with:

```ts
  const settingsPath = USER_SETTINGS_PATH; // global config (Plan B3); CLAUDE_MEM_WORKER_PORT env still overrides via applyEnvOverrides
```

- [ ] **Step 5: Run to verify pass**

Run: `npx bun test tests/engram/config-split.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/worker-utils.ts tests/engram/fixtures/probe-port.ts tests/engram/config-split.test.ts
git commit -m "feat(engram): getWorkerPort/Host read global settings (config split)"
```

---

## Task 3: Full verification + completeness guard

**Files:** none.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck:root`
Expected: clean. (`paths.ts` now imports `../engram/global-config.js` — a one-way edge; `global-config.ts` imports only node built-ins, so no cycle. `worker-utils.ts` imports the existing `USER_SETTINGS_PATH` export.)

- [ ] **Step 2: Full engram suite**

Run: `npx bun test tests/engram/`
Expected: PASS — project-root (9) + global-config (3) + engram-resolve (4) + bun-runner-injection (2) + config-split (3) = **21 tests**.

- [ ] **Step 3: Confirm no other manual `join(<dataDir>, 'settings.json' | '.env')` construction remains for secrets**

Run:
```bash
grep -rn "join(.*DATA_DIR.*'settings.json'\|join(.*DATA_DIR.*'\.env'\|'CLAUDE_MEM_DATA_DIR').*settings.json" src/ || echo "OK: no remaining per-project settings/.env construction"
```
Expected: the only matches (if any) are in `src/shared/paths.ts` bootstrap (`resolveDataDir`, line ~24, which is intentional — it reads `~/.engram/settings.json` to discover a custom data dir) and the redirected definitions themselves. No OTHER module should build a settings/.env path from `DATA_DIR`. If a new one appears, redirect it to `USER_SETTINGS_PATH`/`paths.settings()`/`paths.envFile()` and note it.

- [ ] **Step 4: Purity invariant still holds (engram does not import paths)**

Run: `grep -rn "shared/paths" src/engram/ || echo "OK: engram still does not import paths.ts"`
Expected: `OK: ...`. (B3 adds a `paths.ts → engram/global-config.ts` edge, NOT the reverse, so Plan B's purity invariant is preserved.)

- [ ] **Step 5: Confirm no live-install side effects**

Run: `git status --short`
Expected: clean. No `build-and-sync`, no worker restart.

---

## Definition of done (Plan B3)

- `settings.json` and `.env` resolve to `GLOBAL_CONFIG_DIR` (`~/.engram` by default, `ENGRAM_GLOBAL_DIR` override); DB/chroma/logs/pid stay per-project.
- `getWorkerPort`/`getWorkerHost` read the global settings; calling them never creates a per-project `settings.json`.
- No-divergence safety verified (global == data dir ⇒ unchanged behavior).
- `npx bun test tests/engram/` green (21 tests); `npm run typecheck:root` clean; purity invariant intact; working tree clean.

## Self-review notes (author)

- **Spec coverage:** Implements spec §4.5 (config split — global secrets, per-project state) via the minimal surface (paths.ts + worker-utils.ts). All ~15 `paths.settings()` / `USER_SETTINGS_PATH` / `paths.envFile()` consumers are redirected transitively.
- **No placeholders:** every edit is an exact before/after; every test is complete; commands have expected output.
- **Safety / no live impact:** redirect is a no-op when `DATA_DIR == ~/.engram` (current live state), so nothing breaks until B2's per-project env is active; plan never runs build-and-sync or restarts the worker. Verified by the no-divergence test.
- **Verification realism:** subprocess probes load `paths.ts`/`worker-utils.ts` fresh under controlled env (the only reliable way to exercise module-load-time frozen consts); the worker-port test proves the read SOURCE changed (global value 38500) and that no per-project settings file is created.
- **Layering:** `paths.ts → engram/global-config.ts` is a clean one-way dependency (no cycle; global-config imports only node built-ins) and does not violate Plan B's "engram never imports paths" purity guard (Task 3 Step 4 re-asserts it).
- **Out of scope, correctly deferred:** per-project setting overrides; `/api/whoami` + port-collision (B4); the stale `~/.claude-mem` comment in `EnvManager.ts` (cosmetic).
