# Engram — Project-Local, Git-Native Memory (Design Spec)

**Date:** 2026-06-04
**Status:** Approved approach, pre-implementation
**Fork of:** `thedotmack/claude-mem` (Apache-2.0, open-core)
**Scope of this spec:** Core git-native memory system (rebrand + project-local runtime + diffable export/import + sync hooks + smoke test). **The relationship graph is explicitly out of scope here** and will get its own spec, built on top of the versioned `.mem/` produced by this work.

---

## 1. Problem & Goals

The same project is developed from different machines at different times. Claude Code's memory does not travel between machines, so "where I left off / what I did / why" must be re-explained every time.

**Goal:** Make project memory behave like commits — it updates on `git pull` and is shared on `git commit/push`, living inside the **target project's own repo** under `.mem/`, synced through that project's own git remote.

**Success criterion (the real test):** Machine A works → memory is committed/pushed. Machine B runs `git pull` → the memory (state + observations + decisions) is present locally and injected into the new session's context.

### Non-goals (this spec)
- The relationship graph / visualization (separate later spec).
- Multi-project unified graph (decided: single project now, schema kept graph-ready).
- Full rebrand of every string (decided: minimum user-facing surface now).
- Committing binary databases or vectors to git (explicitly forbidden).

---

## 2. Key decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Product name | **Engram** |
| 2 | Runtime/language | **All TypeScript/Bun** (same toolchain as upstream) |
| 3 | Scope | **Single project now, node/edge schema kept graph-ready** |
| 4 | Storage approach | **Approach B**: project-local runtime (per-project worker + DB + chroma), made safe by never git-tracking the binary DB |
| 5 | Worker model | **One worker daemon per project** via env-override + deterministic port |
| 6 | Commit cadence | **Export on every Stop; debounced commit/push** (avoid commit spam) |
| 7 | Rebrand depth | **Minimum**: package, plugin, data dir, MCP server name; internal `CLAUDE_MEM_*` env names retained for now |

### Why Approach B is safe (the corruption risk, neutralized)

M1 discovery found the central risk: the worker holds **one long-lived SQLite handle** with **no `busy_timeout`** and **no live-reload**; if an external `git pull` replaced the live `.db` file, the result is corruption / stale reads / WAL `-wal`/`-shm` desync (`src/services/worker/DatabaseManager.ts:18`, `src/services/sqlite/SessionStore.ts:32-45`).

This risk only materializes **if the binary `.db` is git-tracked and swapped under the live worker**. Engram never does that:

- **Source of truth is text** (`.mem/*.ndjson` + markdown). `git pull` only ever changes text files.
- The binary `.db`, chroma, logs live under `<repo>/.mem/.runtime/` which is **git-ignored**. `git pull` never touches them.
- On `SessionStart`, after `git pull`, Engram **imports** the (possibly new) text records into the local DB through the worker's own idempotent write path. The live handle is never swapped; it only gains rows.

---

## 3. Architecture overview

```
┌────────────────────────── target project repo ──────────────────────────┐
│                                                                          │
│  CLAUDE.md ── @import ──▶ .mem/state.md                                   │
│                                                                          │
│  .mem/                         (GIT-TRACKED — diffable source of truth)   │
│    observations.ndjson         append-only, canonical JSON lines         │
│    summaries.ndjson                                                       │
│    prompts.ndjson                                                         │
│    sessions.ndjson                                                        │
│    decisions/<slug>.md         "decision → changed files → rationale"     │
│    state.md                    current "where we are"                     │
│    manifest.json               project identity (engramProjectId, version)│
│    .gitattributes              *.ndjson merge=union                       │
│                                                                          │
│  .mem/.runtime/                (GIT-IGNORED — rebuilt per machine)        │
│    engram.db   chroma/   logs/   worker.pid   worker.port   sync-state.json│
└──────────────────────────────────────────────────────────────────────────┘
        ▲ import (reconcile)                    │ export
        │                                       ▼
   ┌────────────────────────── per-project worker daemon ──────────────────┐
   │  HTTP API (deterministic per-project port) · SQLite · Chroma backfill  │
   └────────────────────────────────────────────────────────────────────────┘
        ▲ HTTP                                   ▲ HTTP
   ┌────┴───────────── Claude Code hooks (generated shell + env-override) ───┐
   │ SessionStart: set DATA_DIR/PORT → git pull → reconcile → inject context │
   │ PostToolUse:  capture observation                                       │
   │ Stop:         queue summarize → export .mem → debounced commit/push     │
   └─────────────────────────────────────────────────────────────────────────┘
```

The **upstream core (worker, SQLite layer, Chroma) is used unmodified** except for two small, additive seams: (a) the hook-shell generator gains a "resolve project root / data dir / port" prelude block, and (b) a layered config split so user secrets stay global while project state is local.

---

## 4. Components (boundaries & responsibilities)

All Engram-specific code lives under `src/engram/` so it is isolated for upstream merges.

### 4.1 `ProjectRootResolver` (`src/engram/project-root.ts`)
- **Does:** Given a `cwd`, resolve the project root (`git rev-parse --show-toplevel`, fallback to `cwd`), the data dir (`<root>/.mem/.runtime`), and a deterministic worker port.
- **Use:** Called by the generated hook prelude (via a tiny CLI subcommand) and by Engram modules.
- **Depends on:** git CLI, Node path/os.
- **Port derivation:** stable hash of the absolute project root → base `37800 + (hash mod 150)` (range 37800–37949, disjoint from upstream's 37700–37799 default). On bind collision with a *different* project, increment within range; persist the chosen port to `.mem/.runtime/worker.port`. Single-instance is keyed on project root, not a global PID.

### 4.2 `EngramExporter` (`src/engram/exporter.ts`)
- **Does:** Project DB rows → `.mem/*.ndjson` + `decisions/*.md` + `state.md`. Incremental via a watermark in `sync-state.json` (mirrors the existing `ChromaSyncState` pattern, `src/services/sync/ChromaSyncState.ts`).
- **Canonical serialization:** stable key ordering, LF line endings, UTF-8, sorted by `(created_at_epoch, id)` so two machines emit **byte-identical** lines for the same row → clean diffs and conflict-free union merges.
- **Decisions:** observations whose `type`/concepts mark them as decisions also (re)write `decisions/<slug>.md` with the rationale + `files_modified` linkage.
- **Depends on:** the read side of the SQLite layer (`Observations/Summaries/Prompts/Sessions` getters), filtered by the current `project`.

### 4.3 `EngramImporter` (`src/engram/importer.ts`)
- **Does:** `.mem/*.ndjson` → local DB, idempotently. Reuses the existing idempotent write path (`ON CONFLICT DO NOTHING` on `observations.UNIQUE(memory_session_id, content_hash)`; `src/services/sqlite/Import.ts`, `import/bulk.ts`).
- **Idempotency:** re-importing identical lines is a no-op; safe to run on every SessionStart. After import, the worker's existing `ChromaSync.backfillAllProjects()` reindexes the new rows locally (no special path needed).
- **Depends on:** the worker import endpoint / SQLite import bulk helpers.

### 4.4 `EngramSync` (`src/engram/sync.ts`)
- **Does:** the git operations. `pullAndReconcile()` (SessionStart) and `exportAndMaybeCommit()` (Stop).
- **Resilience contract:** every git op has a short timeout, never blocks the session, and swallows errors to a clean exit (consistent with the existing hook IO discipline, `src/cli/hook-command.ts:100-119`). No remote / offline / detached-HEAD / conflict → log + continue in **local-only** mode.
- **Pull:** `git pull --rebase --autostash` scoped to the repo, then `EngramImporter`.
- **Debounced commit:** after `EngramExporter` writes `.mem`, commit/push only when a quiet threshold has passed (time since last commit recorded in `sync-state.json`, default e.g. 120s, or session-idle). Commit message `engram: memory update <iso-ts>`; `git add .mem`; push with timeout. (Cadence is configurable; squashing is a later refinement.)

### 4.5 `EngramConfig` (config split) (`src/engram/config.ts` + minimal `src/shared/paths.ts` seam)
- **Does:** Resolve **user/global** config (API keys, model, provider, feature flags) from `~/.engram/settings.json` regardless of `DATA_DIR`, while **project/runtime** artifacts follow `CLAUDE_MEM_DATA_DIR` (= `.mem/.runtime`).
- **Why:** Upstream conflates both under `DATA_DIR` (`USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json')`, `src/shared/paths.ts:50`). Without the split, per-project `DATA_DIR` would force re-entering API keys per project.
- **Seam:** add `GLOBAL_CONFIG_DIR = ~/.engram`; settings-defaults loader merges global first, then project overrides. Additive, behind the resolver.

### 4.6 Hook generator extension (`src/build/hook-shell-template.ts` + `scripts/build-hooks.js`)
- **Does:** Prepend an additive prelude block that resolves project root → exports `CLAUDE_MEM_DATA_DIR` and `CLAUDE_MEM_WORKER_PORT` (via the `ProjectRootResolver` CLI subcommand) before invoking the worker. Add the SessionStart `pull→reconcile` step and the Stop `export→debounced-commit` step as additive event slots.
- **Constraint:** hooks.json is canonical-verified byte-for-byte (`scripts/build-hooks.js:127`); changes MUST go through the generator + regenerate, never hand-edited.

---

## 5. Data flow

**Capture (unchanged upstream path):** `PostToolUse → /api/sessions/observations → worker → SQLite (+ async chroma sync)`.

**Export (Stop):** `Stop → summarize queue (unchanged) → EngramExporter (DB→.mem, incremental, canonical) → EngramSync.exportAndMaybeCommit (debounced git add/commit/push)`.

**Sync-out:** project's git remote receives `.mem/*` text changes only.

**Sync-in / reconcile (SessionStart):** `git pull --rebase --autostash → EngramImporter (.mem→DB, idempotent) → worker ChromaSync backfill (local reindex) → existing /api/context/inject`.

**Conflict handling:** `.mem/.gitattributes` sets `*.ndjson merge=union` → concurrent appends from two machines both survive the merge; `EngramImporter` then dedups on import via `content_hash`. Result: self-healing merges. `state.md` uses union or last-writer-wins with a visible marker; `decisions/*` are per-file so collisions are rare.

---

## 6. `.mem/` format

- **`observations.ndjson` / `summaries.ndjson` / `prompts.ndjson` / `sessions.ndjson`:** one canonical JSON object per line, fields in stable order, sorted by `(created_at_epoch, id)`. Each line is self-contained and content-addressed (carries `content_hash` where the schema has it).
- **`decisions/<slug>.md`:** human/agent-readable decision record — what was decided, which files changed (`files_modified`), and why. Linked back to the originating observation id.
- **`state.md`:** the latest "where we are" — derived from the most recent session summary; imported into `CLAUDE.md` via `@.mem/state.md`.
- **`manifest.json`:** `{ engramProjectId, schemaVersion, createdAt }`. `engramProjectId` is a stable UUID stored in-repo so identity does not depend on the directory basename (M1 found upstream derives `project` from `basename(git toplevel)`, which is fragile under rename).
- **`.gitignore` (project):** add `.mem/.runtime/`.
- **`.gitattributes` (project):** `*.ndjson merge=union` (scoped to `.mem/`).

---

## 7. Error handling & edge cases

- **No git remote / offline:** pull and push are skipped; commits stay local; session never blocks.
- **Merge conflict on pull:** `--autostash` + `--rebase`; on unresolved conflict, abort rebase, log, continue local-only (import still runs on whatever is on disk).
- **Worker down:** existing lazy-spawn (`ensureWorkerStarted`) applies; if unreachable, hooks degrade to no-op as today.
- **Port collision across projects:** resolver increments within range and persists the chosen port.
- **Privacy/PII:** observations may contain sensitive content; committing to a shared repo exposes it to everyone with repo access. Engram routes export through the existing `PrivacyCheckValidator` and supports an exclude/redact policy in `~/.engram/settings.json`. **Privacy gate is mandatory before commit.**
- **Large `.mem` over time:** ndjson is append-only; periodic compaction (snapshot + truncate) is a later refinement, not in v1.

---

## 8. Rebrand surface (minimum)

- Package names → `engram` (root), `engram-plugin`; `bin` → `engram`.
- Plugin identity (`plugin/.claude-plugin/plugin.json`, marketplace display) → `engram`.
- Global data dir `~/.claude-mem` → `~/.engram` (with a one-time migration shim: if `~/.claude-mem` exists and `~/.engram` does not, migrate/symlink — best-effort).
- MCP server key in `plugin/.mcp.json` (`mcp-search`) → `engram`; update `tests/servers/mcp-server-name-safety.test.ts` (qualified prefix becomes `mcp__plugin_engram_engram__*`).
- **Retained for now:** internal `CLAUDE_MEM_*` env var names (avoids 100+ merge-conflict points). `.mem/` folder name is generic (not branded) and stays.
- Implemented as a re-runnable script `scripts/rebrand.mjs` (deterministic find-replace over the minimum surface) so it can be re-applied mechanically after each upstream merge.

---

## 9. Upstream-merge strategy

- `git remote add upstream https://github.com/thedotmack/claude-mem.git`.
- All Engram logic isolated under `src/engram/`; hook generator extended additively; no edits to churny core internals (`worker-service.ts`, sqlite internals) beyond the two named seams (config split + generator prelude).
- Rebrand kept minimal and scripted (`scripts/rebrand.mjs`) for mechanical re-application.
- Cadence: regular `git merge upstream/main`; conflicts concentrate only in the two seams + the minimum rebrand surface.

---

## 10. Testing strategy

- **Unit:** exporter canonical/byte-stable serialization; importer idempotency (re-import = no-op); project-root + deterministic port derivation; config-split resolution (global secrets + project state); sync-state watermark advance.
- **Integration:** capture → export → assert `.mem/*` contents; `.mem/*` → import → assert DB rows match; offline/no-remote degradation path; `merge=union` + content_hash dedup convergence.
- **Smoke test (THE success criterion):** two clones against a temp bare remote. Machine A: capture work → export → commit → push. Machine B: `git pull` → SessionStart reconcile → assert observations + decisions + `state.md` are present AND appear in `/api/context/inject` output. This is the definition of done for the core system.

---

## 11. Milestone breakdown (for the implementation plan)

1. **Rebrand skeleton (minimum)** — package/plugin/data-dir/MCP name + `scripts/rebrand.mjs`; build & worker still start.
2. **Project-local runtime** — `ProjectRootResolver`, deterministic port, generator prelude exporting `DATA_DIR`/`PORT`, single-instance keyed on project, config split (global secrets).
3. **Diffable export + `.mem/` layout** — `EngramExporter`, canonical serialization, `.gitignore`/`.gitattributes`, `manifest.json`, `state.md`, `CLAUDE.md` `@import`.
4. **Import/reconcile** — `EngramImporter`, idempotent, chroma backfill verified.
5. **Sync hooks** — SessionStart pull→reconcile; Stop export→debounced commit/push; resilience contract.
6. **Smoke test** — two-clone propagation, the success criterion.

(Graph = separate later spec, built on the `.mem/` produced here.)
