# Engram Plan D — Git Sync + Two-Machine Smoke Test (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps. Follow superpowers:test-driven-development per task.

**Goal:** Make memory sync like commits — `syncOut` (export → commit → push) on the way out, `syncIn` (pull → import) on the way in — and prove the brief's success criterion with an isolated **two-machine smoke test**: machine A works → push; machine B `git pull` → the memory (observations + decisions + state) is there.

**Architecture:** Two new pure-ish modules under `src/engram/` composing Plan C's exporter/importer with a resilient git wrapper. `git-sync.ts` runs `git` via `execFileSync` with timeouts and never throws (offline / no-remote / conflict → non-fatal, local-only). `sync.ts` orchestrates: `syncOut(db, project, root, {push})` = export + `.mem` commit (+ optional push) + ensure `CLAUDE.md` `@.mem/state.md`; `syncIn(db, root, {pull})` = optional pull + import. The smoke test exercises the full A→remote→B propagation against a temp **bare** git remote and two temp DBs — real git, no worker, no network. (Wiring `syncOut`/`syncIn` into the Stop / SessionStart hooks is the **go-live** step, documented in carry-forward; this plan does not touch the worker handlers or run build-and-sync.)

**Tech Stack:** TypeScript, Node `child_process` (git) + `fs`, `bun:sqlite` (`ClaudeMemDatabase` temp DBs in tests), Bun test, real local git.

**Reference:** spec §4.4 (EngramSync), §5 (data flow), §10 (smoke test); carry-forward (Plan D). Builds on Plan C `exporter.ts`/`importer.ts`/`mem-format.ts`.

## Resilience contract (git ops)

Every git op: `cwd`-scoped, `windowsHide`, short timeout (15s; 30s for network pull/push), captures stdout+stderr, **returns a status object — never throws**. No remote / offline / rebase conflict → non-fatal; the session is never blocked (matches the existing hook IO discipline). `syncIn` always imports whatever is on disk even if pull failed.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/engram/git-sync.ts` | Resilient git wrapper: `isGitRepo`, `hasRemote`, `gitPull`, `gitCommitPaths`, `gitPush` | Create |
| `src/engram/sync.ts` | `syncOut(db, project, root, {push})` / `syncIn(db, root, {pull})` + `ensureClaudeMdImport` | Create |
| `tests/engram/git-sync.test.ts` | git wrapper against a temp repo (no remote, commit, nothing-to-commit) | Create |
| `tests/engram/smoke.test.ts` | THE success criterion: bare remote + two clones, A push → B pull → memory present | Create |

---

## Task 1: `git-sync.ts` — resilient git wrapper

**Files:**
- Create: `src/engram/git-sync.ts`
- Test: `tests/engram/git-sync.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/engram/git-sync.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isGitRepo, hasRemote, gitCommitPaths } from '../../src/engram/git-sync.js';

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@engram.local'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Engram Test'], { cwd: dir, windowsHide: true });
}

describe('git-sync wrapper', () => {
  it('isGitRepo is false for a plain dir, true after git init', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-git-'));
    try {
      expect(isGitRepo(dir)).toBe(false);
      initRepo(dir);
      expect(isGitRepo(dir)).toBe(true);
      expect(hasRemote(dir)).toBe(false); // no remote configured
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('gitCommitPaths commits new files and reports nothing-to-commit on a clean tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-commit-'));
    try {
      initRepo(dir);
      writeFileSync(join(dir, 'a.txt'), 'hello\n');
      const c1 = gitCommitPaths(dir, ['a.txt'], 'add a');
      expect(c1.ok).toBe(true);
      expect(c1.committed).toBe(true);
      const c2 = gitCommitPaths(dir, ['a.txt'], 'noop'); // nothing changed
      expect(c2.ok).toBe(true);
      expect(c2.committed).toBe(false); // nothing to commit
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never throws on a non-repo (returns ok:false)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-norepo-'));
    try {
      const c = gitCommitPaths(dir, ['x'], 'm'); // not a git repo
      expect(c.ok).toBe(false); // resilient: returns, does not throw
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx bun test tests/engram/git-sync.test.ts`
Expected: FAIL — `src/engram/git-sync.ts` does not exist.

- [ ] **Step 3: Implement `git-sync.ts`**

Create `src/engram/git-sync.ts`:

```ts
import { execFileSync } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

/** Run a git command, scoped to `root`, never throwing. */
function git(root: string, args: string[], timeout = 15000): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout,
    });
    return { ok: true, stdout: String(stdout).trim() };
  } catch (e: any) {
    const stderr = e?.stderr ? String(e.stderr) : '';
    const stdout = e?.stdout ? String(e.stdout) : '';
    return { ok: false, stdout: stdout.trim(), error: (stderr || e?.message || String(e)).trim() };
  }
}

export function isGitRepo(root: string): boolean {
  const r = git(root, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout === 'true';
}

export function hasRemote(root: string): boolean {
  const r = git(root, ['remote']);
  return r.ok && r.stdout.length > 0;
}

/** Pull (rebase + autostash). No remote → no-op success. Conflict → abort + non-fatal. */
export function gitPull(root: string): GitResult {
  if (!isGitRepo(root) || !hasRemote(root)) return { ok: true, stdout: 'no remote' };
  const r = git(root, ['pull', '--rebase', '--autostash'], 30000);
  if (!r.ok) git(root, ['rebase', '--abort']); // best-effort cleanup; ignore result
  return r;
}

export interface CommitResult extends GitResult { committed: boolean; }

/** Stage `paths`, commit if anything is staged. Clean tree → ok with committed:false. */
export function gitCommitPaths(root: string, paths: string[], message: string): CommitResult {
  if (!isGitRepo(root)) return { ok: false, stdout: '', error: 'not a git repo', committed: false };
  const add = git(root, ['add', ...paths]);
  if (!add.ok) return { ...add, committed: false };
  // `git diff --cached --quiet` exits 0 when nothing is staged.
  if (git(root, ['diff', '--cached', '--quiet']).ok) {
    return { ok: true, stdout: 'nothing to commit', committed: false };
  }
  const commit = git(root, ['commit', '-m', message]);
  return { ...commit, committed: commit.ok };
}

/** Push the current branch to origin. No remote → no-op success. */
export function gitPush(root: string): GitResult {
  if (!isGitRepo(root) || !hasRemote(root)) return { ok: true, stdout: 'no remote' };
  return git(root, ['push', 'origin', 'HEAD'], 30000);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx bun test tests/engram/git-sync.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engram/git-sync.ts tests/engram/git-sync.test.ts
git commit -m "feat(engram): add resilient git wrapper (never throws; non-fatal pull/push)"
```

---

## Task 2: `sync.ts` — syncOut / syncIn orchestration

**Files:**
- Create: `src/engram/sync.ts`
- Test: `tests/engram/smoke.test.ts` (a local-only orchestration test first)

- [ ] **Step 1: Write the failing local-orchestration tests**

Create `tests/engram/smoke.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { syncOut, syncIn } from '../../src/engram/sync.js';
import { readProjectRows } from '../../src/engram/mem-sql.js';
import { memFile, statePath } from '../../src/engram/mem-format.js';

const PROJECT = 'smoke-proj';

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@engram.local'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Engram Test'], { cwd: dir, windowsHide: true });
}
function seed(db: any): void {
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES ('cs-1','ms-1',?, 'claude','2026-06-05T00:00:00Z',1000,'completed')`).run(PROJECT);
  db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, content_hash, created_at, created_at_epoch)
    VALUES ('ms-1',?, 'decision','Approach B','per-project runtime','h-1','2026-06-05T00:01:00Z',1060)`).run(PROJECT);
  db.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, learned, completed, created_at, created_at_epoch)
    VALUES ('ms-1',?, 'build it','injection works','B2 done','2026-06-05T00:02:00Z',1120)`).run(PROJECT);
}
const cleanup = (db: any, ...dirs: string[]) => { db?.db?.close?.(); (globalThis as any).Bun?.gc?.(true); for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };

describe('syncOut/syncIn local orchestration', () => {
  it('syncOut exports + commits locally (no remote) and ensures CLAUDE.md import', () => {
    const repo = mkdtempSync(join(tmpdir(), 'engram-syncout-'));
    const db = new ClaudeMemDatabase(join(repo, 'db.sqlite'));
    try {
      initRepo(repo);
      seed(db.db);
      const r = syncOut(db.db, PROJECT, repo, { push: false });
      expect(r.committed).toBe(true);
      expect(existsSync(memFile(repo, 'observations'))).toBe(true);
      expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toContain('@.mem/state.md');
      // committed to git
      const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8', windowsHide: true });
      expect(log).toContain('engram:');
      // second syncOut with no DB change → nothing to commit
      expect(syncOut(db.db, PROJECT, repo, { push: false }).committed).toBe(false);
    } finally { cleanup(db, repo); }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx bun test tests/engram/smoke.test.ts`
Expected: FAIL — `src/engram/sync.ts` does not exist.

- [ ] **Step 3: Implement `sync.ts`**

Create `src/engram/sync.ts`:

```ts
import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportProject } from './exporter.js';
import { importProject } from './importer.js';
import { isGitRepo, gitPull, gitCommitPaths, gitPush } from './git-sync.js';

const CLAUDE_MD_IMPORT = '@.mem/state.md';

/** Ensure the project's CLAUDE.md imports the memory state (idempotent, best-effort). */
export function ensureClaudeMdImport(root: string): void {
  try {
    const p = join(root, 'CLAUDE.md');
    if (!existsSync(p)) { writeFileSync(p, `${CLAUDE_MD_IMPORT}\n`); return; }
    if (!readFileSync(p, 'utf8').includes(CLAUDE_MD_IMPORT)) appendFileSync(p, `\n${CLAUDE_MD_IMPORT}\n`);
  } catch { /* best-effort: never block a session on CLAUDE.md */ }
}

export interface SyncOutResult { committed: boolean; pushed: boolean; }

/** Export this project's memory to .mem, commit it, optionally push. Resilient. */
export function syncOut(db: Database, project: string, root: string, opts: { push?: boolean } = {}): SyncOutResult {
  exportProject(db, project, root);
  ensureClaudeMdImport(root);
  if (!isGitRepo(root)) return { committed: false, pushed: false };
  const commit = gitCommitPaths(root, ['.mem', 'CLAUDE.md'], `engram: memory update ${new Date().toISOString()}`);
  let pushed = false;
  if (opts.push && commit.committed) pushed = gitPush(root).ok;
  return { committed: commit.committed, pushed };
}

export interface SyncInResult { pulled: boolean; imported: number; }

/** Optionally pull, then import .mem into the DB. Always imports what is on disk. */
export function syncIn(db: Database, root: string, opts: { pull?: boolean } = {}): SyncInResult {
  let pulled = false;
  if (opts.pull) pulled = gitPull(root).ok;
  const counts = importProject(db, root);
  return { pulled, imported: counts.sessions + counts.observations + counts.summaries + counts.prompts };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx bun test tests/engram/smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/engram/sync.ts tests/engram/smoke.test.ts
git commit -m "feat(engram): add syncOut/syncIn orchestration + CLAUDE.md @import"
```

---

## Task 3: The two-machine smoke test (success criterion)

**Files:**
- Modify: `tests/engram/smoke.test.ts` (append the bare-remote propagation test)

- [ ] **Step 1: Write the failing smoke test**

Append to `tests/engram/smoke.test.ts`:

```ts
import { decisionsDir } from '../../src/engram/mem-format.js';
import { readdirSync } from 'node:fs';

describe('two-machine smoke test (the success criterion)', () => {
  it('machine A push → machine B pull → memory is present in B', () => {
    const remote = mkdtempSync(join(tmpdir(), 'engram-remote-'));
    const repoA = mkdtempSync(join(tmpdir(), 'engram-A-'));
    const repoB = mkdtempSync(join(tmpdir(), 'engram-B-'));
    const dbDir = mkdtempSync(join(tmpdir(), 'engram-dbs-'));
    const dbA = new ClaudeMemDatabase(join(dbDir, 'a.db'));
    const dbB = new ClaudeMemDatabase(join(dbDir, 'b.db'));
    try {
      // Bare remote + clone A; configure user; establish a main branch.
      execFileSync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
      execFileSync('git', ['clone', '-q', remote, repoA], { windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'a@engram.local'], { cwd: repoA, windowsHide: true });
      execFileSync('git', ['config', 'user.name', 'Machine A'], { cwd: repoA, windowsHide: true });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repoA, windowsHide: true });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: repoA, windowsHide: true });

      // === Machine A: work, then sync out (push) ===
      seed(dbA.db);
      const out = syncOut(dbA.db, PROJECT, repoA, { push: true });
      expect(out.committed).toBe(true);
      expect(out.pushed).toBe(true);

      // === Machine B: clone fresh, then sync in (no pull needed — clone has it) ===
      execFileSync('git', ['clone', '-q', remote, repoB], { windowsHide: true });
      expect(existsSync(memFile(repoB, 'observations'))).toBe(true); // propagated via git
      const inRes = syncIn(dbB.db, repoB, { pull: false });
      expect(inRes.imported).toBeGreaterThanOrEqual(3); // session + observation + summary

      // === Assert: the memory is present in B's DB and files ===
      const bRows = readProjectRows(dbB.db, PROJECT);
      expect(bRows.observations.length).toBe(1);
      expect(bRows.observations[0].title).toBe('Approach B');
      expect(bRows.observations[0].content_hash).toBe('h-1'); // verbatim across machines
      expect(bRows.summaries[0].learned).toBe('injection works');
      // state.md + decisions/ propagated
      expect(readFileSync(statePath(repoB), 'utf8')).toContain('injection works');
      expect(readdirSync(decisionsDir(repoB)).some((f) => f.endsWith('.md'))).toBe(true);

      // === Idempotent: a second syncIn on B imports nothing new ===
      expect(syncIn(dbB.db, repoB, { pull: true }).imported).toBe(0);
    } finally {
      dbA.db.close(); dbB.db.close(); (globalThis as any).Bun?.gc?.(true);
      for (const d of [remote, repoA, repoB, dbDir]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx bun test tests/engram/smoke.test.ts`
Expected: PASS (2 tests — the local orchestration + the two-machine propagation). This is the brief's success criterion: B has A's observations, decisions, and state after a git round-trip, keyed by the same verbatim `content_hash`.

- [ ] **Step 3: Commit**

```bash
git add tests/engram/smoke.test.ts
git commit -m "test(engram): two-machine smoke test — A push -> B pull -> memory present"
```

---

## Task 4: Full verification + go-live wiring doc

**Files:**
- Modify: `docs/superpowers/plans/engram-carry-forward-notes.md` (go-live hook wiring)

- [ ] **Step 1: Typecheck + full engram suite**

Run: `npm run typecheck:root && npx bun test tests/engram/`
Expected: typecheck clean; engram suite PASS — prior 38 + git-sync (3) + smoke (2) = **43 tests**.

- [ ] **Step 2: Purity invariant**

Run: `grep -rn "shared/paths" src/engram/ || echo "OK"`
Expected: `OK` (sync/git-sync take `db` + `root` arguments; no frozen-path import).

- [ ] **Step 3: Document the go-live hook wiring**

Append to `docs/superpowers/plans/engram-carry-forward-notes.md`, under a new `## Go-live hook wiring (Plan D → production)` heading:

```markdown
## Go-live hook wiring (Plan D → production)

syncOut/syncIn are proven by the smoke test but NOT yet called by the worker
(activating them is the go-live step, alongside B2+B3+B4 + build-and-sync):
- **SessionStart** (`src/cli/handlers/context.ts`, or the worker on boot): before
  context injection, `syncIn(db, resolveProjectRuntime(cwd).root, { pull: true })`
  then let the existing ChromaSync backfill reindex.
- **Stop** (`src/cli/handlers/summarize.ts`, after the summarize job is queued):
  `syncOut(db, project, resolveProjectRuntime(cwd).root, { push: <debounced> })`.
  Debounce push (carry-forward decision): export every Stop, push on a quiet
  threshold to avoid commit-per-turn spam. The worker holds the DB handle; pass it
  (it owns `SessionStore`/`DatabaseManager`). Wrap in the worker's try/catch so a
  sync failure never blocks the turn (git-sync is already non-throwing).
- Both calls run inside the worker process where `DATA_DIR`/the DB handle and the
  project root are available; the resilient git wrapper handles offline/no-remote.
```

- [ ] **Step 4: No live-install side effects**

Run: `git status --short`
Expected: clean. No build-and-sync, no worker restart, no worker-handler edits.

---

## Definition of done (Plan D)

- `git-sync.ts` runs git resiliently (never throws; offline/no-remote/conflict non-fatal).
- `syncOut` exports + commits `.mem` (+ optional push) + ensures `CLAUDE.md` `@.mem/state.md`; `syncIn` pulls + imports.
- **The two-machine smoke test passes**: machine A push → machine B pull → B's DB + `.mem` contain A's observations (verbatim `content_hash`), summary/state, and decisions; second syncIn is idempotent.
- `npx bun test tests/engram/` green (43 tests); typecheck clean; purity intact; working tree clean; go-live wiring documented.

## Self-review notes (author)

- **Spec coverage:** §4.4 (EngramSync: pull→reconcile / export→commit→push), §5 (data flow), §10 (the smoke test = success criterion). Hook wiring is the documented go-live step (touching the worker handlers + build-and-sync is out of scope for an isolated, no-live-impact plan, per the user's standing constraint).
- **No placeholders:** complete modules + tests; the smoke test is a real bare-remote git round-trip.
- **Resilience proven:** git-sync tests cover non-repo (ok:false, no throw) and nothing-to-commit; syncIn always imports on-disk `.mem` regardless of pull outcome.
- **Success criterion met in isolation:** the smoke test reproduces "two machines" with a temp bare remote + two clones + two DBs — real git, no worker, no network — and asserts cross-machine `content_hash` stability + idempotent re-import (the properties Plan C guarantees).
- **Purity:** `sync.ts`/`git-sync.ts` take `db`/`root` args; no frozen-path import. The worker (go-live) supplies the handle + `resolveProjectRuntime().root`.
- **Deferred to go-live:** worker-handler calls to syncOut/syncIn (documented), debounced-push policy tuning, and the actual `build-and-sync` activation (needs B2+B3+B4 live too).
