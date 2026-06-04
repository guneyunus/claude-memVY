# Engram Plan B — Project-Local Runtime Foundation (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Follow superpowers:test-driven-development for each task.

**Goal:** Build the pure, side-effect-free foundation for Engram's project-local runtime — a `ProjectRootResolver` that maps any cwd to `{ project root, project-local data dir, deterministic worker port, slug }`, plus global-config path helpers that locate user secrets at `~/.engram` (separate from per-project state) — all unit-tested, with a runnable CLI for inspection.

**Architecture:** Two new pure modules under `src/engram/` with **no imports of the frozen `src/shared/paths.ts` constants** (so they stay pure and reusable before module-load). `project-root.ts` derives per-project paths/port from a given cwd; `global-config.ts` locates the global config home. A tiny standalone CLI (`resolve-cli.ts`) prints the resolved runtime as JSON. This plan deliberately does **NOT** wire anything into the live hook/worker runtime — that is Plan B2.

**Tech Stack:** TypeScript, Bun test runner, Node `crypto`/`path`/`child_process`/`os`.

**Reference spec:** `docs/superpowers/specs/2026-06-04-engram-project-local-memory-design.md` (§4.1 ProjectRootResolver, §4.5 EngramConfig, §2 decisions).

## Why this is split from the "wiring" (Plan B2)

Milestone-1 mechanics investigation found three hard constraints that make the *wiring* risky and deserving of its own plan, while the *foundation* below is pure and safe:
1. `DATA_DIR`, `USER_SETTINGS_PATH`, `PID_FILE` are **module-load-time frozen consts** (`src/shared/paths.ts:40,50` etc.) — per-project values must be set in `process.env` **before** those modules load. Getting the injection point right (launcher vs shell prelude) is a Plan B2 design question.
2. The generated `plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`, `plugin/.mcp.json` are **byte-for-byte canonical-verified** (`scripts/build-hooks.js` `verifyShellTemplateCanonical`, and `tests/infrastructure/plugin-distribution.test.ts`). Changing the hook prelude forces regenerating those three committed files. (Plan B2.)
3. Secrets (`~/.engram/.env` via `EnvManager.envFilePath()`, and API-key settings keys read by the providers) currently resolve through `DATA_DIR`. Redirecting them to a global location touches `EnvManager` + provider read-sites. (Plan B2.)

This plan produces a tested foundation those wiring steps will consume.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/engram/project-root.ts` | Pure: cwd → `{ root, dataDir, port, slug }`; deterministic port; git-root detection with cwd fallback | Create |
| `src/engram/global-config.ts` | Pure: locate the global config home (`~/.engram`), settings + env paths; `ENGRAM_GLOBAL_DIR` override | Create |
| `src/engram/resolve-cli.ts` | Standalone CLI: prints `resolveProjectRuntime(cwd)` as JSON (for inspection + future Plan B2 use) | Create |
| `tests/engram/project-root.test.ts` | Unit tests for the resolver (pure fns + real temp-git-repo + fallback) | Create |
| `tests/engram/global-config.test.ts` | Unit tests for global-config paths + override | Create |

No existing files are modified in this plan.

---

## Task 1: `project-root.ts` — pure path/port helpers (no git)

**Files:**
- Create: `src/engram/project-root.ts`
- Test: `tests/engram/project-root.test.ts`

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `tests/engram/project-root.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { resolve, join } from 'node:path';
import {
  projectDataDir,
  projectWorkerPort,
  projectSlug,
  PORT_BASE,
  PORT_RANGE,
} from '../../src/engram/project-root.js';

describe('project-root pure helpers', () => {
  it('projectDataDir is <root>/.mem/.runtime', () => {
    const root = resolve('/tmp/acme/widget');
    expect(projectDataDir(root)).toBe(join(root, '.mem', '.runtime'));
  });

  it('projectSlug is the basename of the root', () => {
    expect(projectSlug(resolve('/tmp/acme/widget'))).toBe('widget');
  });

  it('projectWorkerPort is deterministic and inside [PORT_BASE, PORT_BASE+PORT_RANGE)', () => {
    const root = resolve('/tmp/acme/widget');
    const a = projectWorkerPort(root);
    const b = projectWorkerPort(root);
    expect(a).toBe(b); // deterministic
    expect(a).toBeGreaterThanOrEqual(PORT_BASE);
    expect(a).toBeLessThan(PORT_BASE + PORT_RANGE);
  });

  it('projectWorkerPort differs for different roots (no trivial collision)', () => {
    const p1 = projectWorkerPort(resolve('/tmp/acme/widget'));
    const p2 = projectWorkerPort(resolve('/tmp/acme/gadget'));
    expect(p1).not.toBe(p2);
  });

  it('PORT range is disjoint from the upstream default 37700-37799', () => {
    expect(PORT_BASE).toBeGreaterThanOrEqual(37800);
    expect(PORT_BASE + PORT_RANGE).toBeLessThanOrEqual(37950);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx bun test tests/engram/project-root.test.ts`
Expected: FAIL — `Cannot find module '../../src/engram/project-root.js'` (module not created yet).

- [ ] **Step 3: Implement the pure helpers**

Create `src/engram/project-root.ts`:

```ts
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

/**
 * Deterministic per-project worker port range. Disjoint from upstream's
 * UID-derived default (37700-37799, see SettingsDefaultsManager) so an Engram
 * per-project worker never collides with a legacy global claude-mem worker.
 */
export const PORT_BASE = 37800;
export const PORT_RANGE = 150; // ports 37800..37949

/** `<root>/.mem/.runtime` — git-ignored per-project DB/chroma/logs/pid live here. */
export function projectDataDir(root: string): string {
  return join(root, '.mem', '.runtime');
}

/** Human-readable project label (directory name). Not a stable identity. */
export function projectSlug(root: string): string {
  return basename(root);
}

/**
 * Deterministic worker port derived from the absolute project root. The root
 * path differs per machine (different absolute paths), which is correct — the
 * port is a local runtime concern and is never synced. Same root on the same
 * machine always maps to the same port.
 */
export function projectWorkerPort(root: string): number {
  const digest = createHash('sha1').update(resolve(root)).digest();
  return PORT_BASE + (digest.readUInt32BE(0) % PORT_RANGE);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx bun test tests/engram/project-root.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engram/project-root.ts tests/engram/project-root.test.ts
git commit -m "feat(engram): add pure project-root path/port helpers"
```

---

## Task 2: `project-root.ts` — git-root detection + `resolveProjectRuntime`

**Files:**
- Modify: `src/engram/project-root.ts`
- Test: `tests/engram/project-root.test.ts` (append)

- [ ] **Step 1: Write the failing tests (git toplevel + fallback + composition)**

Append to `tests/engram/project-root.test.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  resolveProjectRoot,
  resolveProjectRuntime,
} from '../../src/engram/project-root.js';

describe('resolveProjectRoot (git)', () => {
  it('returns the git toplevel from the repo root and from a subdir', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engram-git-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      const sub = join(dir, 'src', 'deep');
      mkdirSync(sub, { recursive: true });
      expect(resolveProjectRoot(dir)).toBe(resolve(dir));
      expect(resolveProjectRoot(sub)).toBe(resolve(dir)); // finds toplevel from deep
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the resolved cwd when git cannot resolve the path', () => {
    // A path that does not exist on disk: `git rev-parse` throws (bad cwd),
    // the resolver catches it and returns resolve(cwd). Deterministic
    // regardless of whether tmpdir happens to sit inside a git repo.
    const ghost = join(tmpdir(), 'engram-nogit-does-not-exist-zzz');
    expect(resolveProjectRoot(ghost)).toBe(resolve(ghost));
  });
});

describe('resolveProjectRuntime', () => {
  it('composes root, dataDir, port, slug', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engram-rt-')));
    try {
      const rt = resolveProjectRuntime(dir);
      expect(rt.root).toBe(resolve(dir));
      expect(rt.dataDir).toBe(join(resolve(dir), '.mem', '.runtime'));
      expect(rt.port).toBe(projectWorkerPort(resolve(dir)));
      expect(rt.slug).toBe(projectSlug(resolve(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx bun test tests/engram/project-root.test.ts`
Expected: FAIL — `resolveProjectRoot`/`resolveProjectRuntime` are not exported yet.

- [ ] **Step 3: Implement git-root detection + composition**

Append to `src/engram/project-root.ts`:

```ts
import { execFileSync } from 'node:child_process';

/**
 * Resolve the project root for a cwd: the git toplevel if the cwd is inside a
 * repo, otherwise the cwd itself. Always returned as an absolute, normalized
 * path (`resolve`) so downstream hashing/joining is platform-stable (git emits
 * forward slashes on Windows).
 */
export function resolveProjectRoot(cwd: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return out ? resolve(out) : resolve(cwd);
  } catch {
    return resolve(cwd);
  }
}

export interface ProjectRuntime {
  /** Absolute project root (git toplevel or cwd). */
  root: string;
  /** `<root>/.mem/.runtime` — git-ignored per-project runtime data. */
  dataDir: string;
  /** Deterministic per-project worker port. */
  port: number;
  /** Directory-name label. */
  slug: string;
}

/** Map a cwd to its full project-local runtime descriptor. */
export function resolveProjectRuntime(cwd: string): ProjectRuntime {
  const root = resolveProjectRoot(cwd);
  return {
    root,
    dataDir: projectDataDir(root),
    port: projectWorkerPort(root),
    slug: projectSlug(root),
  };
}
```

- [ ] **Step 4: Run to verify all tests pass**

Run: `npx bun test tests/engram/project-root.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/engram/project-root.ts tests/engram/project-root.test.ts
git commit -m "feat(engram): add git-root detection and resolveProjectRuntime"
```

---

## Task 3: `global-config.ts` — global config home (split from per-project state)

**Files:**
- Create: `src/engram/global-config.ts`
- Test: `tests/engram/global-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/engram/global-config.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  globalConfigDir,
  globalSettingsPath,
  globalEnvPath,
} from '../../src/engram/global-config.js';

const ORIGINAL = process.env.ENGRAM_GLOBAL_DIR;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ENGRAM_GLOBAL_DIR;
  else process.env.ENGRAM_GLOBAL_DIR = ORIGINAL;
});

describe('global-config', () => {
  it('defaults to ~/.engram', () => {
    delete process.env.ENGRAM_GLOBAL_DIR;
    expect(globalConfigDir()).toBe(join(homedir(), '.engram'));
  });

  it('honors the ENGRAM_GLOBAL_DIR override', () => {
    process.env.ENGRAM_GLOBAL_DIR = join('/custom', 'engram-home');
    expect(globalConfigDir()).toBe(join('/custom', 'engram-home'));
  });

  it('settings + env paths hang off the config dir', () => {
    process.env.ENGRAM_GLOBAL_DIR = join('/custom', 'engram-home');
    expect(globalSettingsPath()).toBe(join('/custom', 'engram-home', 'settings.json'));
    expect(globalEnvPath()).toBe(join('/custom', 'engram-home', '.env'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx bun test tests/engram/global-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `global-config.ts`**

Create `src/engram/global-config.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The GLOBAL Engram config home — holds user-level secrets/config (API keys,
 * model/provider choice, feature flags) that must be shared across all projects.
 * Distinct from a project's per-project runtime dir (`<root>/.mem/.runtime`).
 * Overridable via ENGRAM_GLOBAL_DIR (used by tests and isolated harnesses).
 *
 * Plan B2 will route the secret/provider reads here so a per-project DATA_DIR
 * does not force re-entering API keys per project.
 */
export function globalConfigDir(): string {
  return process.env.ENGRAM_GLOBAL_DIR ?? join(homedir(), '.engram');
}

export function globalSettingsPath(): string {
  return join(globalConfigDir(), 'settings.json');
}

export function globalEnvPath(): string {
  return join(globalConfigDir(), '.env');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx bun test tests/engram/global-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engram/global-config.ts tests/engram/global-config.test.ts
git commit -m "feat(engram): add global-config home helpers (config split foundation)"
```

---

## Task 4: `resolve-cli.ts` — runnable inspector

A thin wrapper over the already-tested `resolveProjectRuntime()`. We do NOT add an
automated subprocess test for it (spawning `bun` cross-platform is fragile, and the
logic it wraps is fully covered by Tasks 1–2); it is verified by manual inspection.

**Files:**
- Create: `src/engram/resolve-cli.ts`

- [ ] **Step 1: Implement the CLI**

Create `src/engram/resolve-cli.ts`:

```ts
#!/usr/bin/env bun
// Inspector: prints the resolved project-local runtime for a cwd as JSON.
// Usage: bun src/engram/resolve-cli.ts [cwd]
// Plan B2 will reuse resolveProjectRuntime() at the process entry to set
// CLAUDE_MEM_DATA_DIR / CLAUDE_MEM_WORKER_PORT before the paths module loads.
import { resolveProjectRuntime } from './project-root.js';

const cwd = process.argv[2] ?? process.cwd();
process.stdout.write(JSON.stringify(resolveProjectRuntime(cwd), null, 2) + '\n');
```

- [ ] **Step 2: Run it and verify the output (manual inspection)**

Run: `npx bun src/engram/resolve-cli.ts`
Expected: prints JSON whose `root` is this repo's path, `dataDir` ends with `.mem\.runtime` (or `.mem/.runtime`), `port` is a number in 37800–37949, and `slug` is `claude-memVY`.

Also run with an explicit argument to confirm arg handling:
Run: `npx bun src/engram/resolve-cli.ts .`
Expected: same shape, `root` resolved from `.`.

- [ ] **Step 3: Commit**

```bash
git add src/engram/resolve-cli.ts
git commit -m "feat(engram): add resolve-cli inspector for project runtime"
```

---

## Task 5: Typecheck + full engram test pass

**Files:** none (verification).

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck:root`
Expected: `tsc --noEmit` clean. (The new modules use only Node built-ins and `.js` ESM import specifiers consistent with the repo's `"type": "module"` + bundler resolution.)

- [ ] **Step 2: Run the full engram test directory**

Run: `npx bun test tests/engram/`
Expected: all tests PASS (project-root: 8, global-config: 3 = 11 total).

- [ ] **Step 3: Confirm no accidental coupling to frozen paths**

Run: `grep -rn "shared/paths" src/engram/ || echo "OK: no import of frozen paths.ts"`
Expected: `OK: no import of frozen paths.ts` (the foundation must stay pure — it computes from a given cwd, never the frozen DATA_DIR const).

---

## Definition of done (Plan B)

- `src/engram/project-root.ts` + `global-config.ts` + `resolve-cli.ts` created; no existing files modified.
- `npx bun test tests/engram/` green (11 tests); `npm run typecheck:root` clean.
- `src/engram/` imports no frozen `src/shared/paths.ts` constant.
- `npx bun src/engram/resolve-cli.ts` prints a correct `ProjectRuntime` for this repo.
- No live hook/worker behavior changed (wiring is Plan B2).

## Self-review notes (author)

- **Spec coverage:** Implements spec §4.1 (ProjectRootResolver: root, dataDir, deterministic port, slug) and the path-helper half of §4.5 (global config home for secrets). The *wiring* half of §4.1/§4.5 (generator prelude / entry injection, single-instance keyed on project, redirecting secret reads) is explicitly Plan B2.
- **No placeholders:** every module + test is complete code; every step has a runnable command + expected output.
- **Determinism caveat:** `projectWorkerPort` hashes the absolute root, so two clones of the same repo at different paths/machines get different ports — intended (port is local, never synced). Cross-machine identity uses `.mem/manifest.json` (Plan C), not the port.
- **Test robustness:** git/fallback tests use `realpathSync(mkdtempSync(...))` so macOS `/var`→`/private/var` symlink normalization and Windows forward-slash git output both compare equal against `resolve(...)`.
- **Purity guard:** Task 5 Step 3 asserts `src/engram/` never imports the frozen `paths.ts` — preserving the property that these helpers can run before module-load (which Plan B2 relies on).
