# Engram — Carry-Forward Notes for Plans B2 / C / D

Running list of constraints + review insights that later plans MUST honor. Captured so they aren't lost between plans. (Spec: `2026-06-04-engram-project-local-memory-design.md`.)

## For Plan B2 — wiring the project-local runtime

**Hard constraints (from M1 mechanics investigation):**
- `DATA_DIR`, `USER_SETTINGS_PATH`, `PID_FILE` are **module-load-time frozen consts** (`src/shared/paths.ts:40,50,131`). `CLAUDE_MEM_DATA_DIR` must be set in `process.env` **before** those modules first load. Preferred injection: the launcher (`bun-runner.js` / worker entry) sets it from `resolveProjectRuntime(process.cwd())` before requiring/importing anything that pulls in `paths.ts`. (Investigate `plugin/scripts/bun-runner.js` first — does it spawn or in-process require the worker?)
- Generated `plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`, `plugin/.mcp.json` are **byte-for-byte canonical-verified** by `scripts/build-hooks.js` `verifyShellTemplateCanonical()` AND `tests/infrastructure/plugin-distribution.test.ts`. If B2 changes `src/build/hook-shell-template.ts` or the manifest, it MUST regenerate + commit those three JSON files or the build fails. Prefer launcher-injection (no hook-string change) over shell-prelude injection (forces regen).
- `spawnDaemon` (`ProcessManager.ts:415-419`) builds child env as `sanitizeEnv({...process.env, CLAUDE_MEM_WORKER_PORT: String(port), ...extraEnv})`. `CLAUDE_MEM_*` keys are NOT stripped by `sanitizeEnv`, so a per-project `CLAUDE_MEM_DATA_DIR` on the hook process **is inherited** by the worker. `CLAUDE_MEM_WORKER_PORT` is set explicitly to the `port` arg.
- `getWorkerPort()`/`getWorkerHost()` (`worker-utils.ts:65-85`) module-cache their result; call `clearPortCache()` if env changes at runtime.

**Review insights (from Plan B code review):**
- `resolveProjectRoot` is a **synchronous** `execFileSync` (now with `timeout: 5000`). Acceptable on the once-per-session hook path; document this in the hook template so a maintainer doesn't "fix" it into async shell complexity.
- **Port collision — DEFERRED to Plan B4 (superseding the original "must be in B2").** `projectWorkerPort` returns a *candidate*. With ~10 active projects on one machine the birthday-problem collision probability is ~26%. B2 ships the deterministic candidate only (documented limitation in `bun-runner.js`); it is safe because B2 must not go live until B3 lands. **B4** must bind-or-increment within `[PORT_BASE, PORT_BASE+PORT_RANGE)`, verify ownership via `/api/whoami`, and persist the actual chosen port to `<dataDir>/worker.port`. Engram must not be shipped live without B4.
- **Single-instance must key on the absolute `root`, not `slug`** — two different projects can share a directory basename. Use `ProjectRuntime.root`.
- **Config split ordering — [DONE in Plan B3].** Secrets/settings (`settings.json` + `.env`) now resolve to `GLOBAL_CONFIG_DIR` (`~/.engram`) via `paths.ts` (`USER_SETTINGS_PATH`/`paths.settings()`/`paths.envFile()` → `globalSettingsPath()`/`globalEnvPath()`), plus `getWorkerPort/Host` and `server.ts` (server-beta key). DB/chroma/logs/pid stay per-project. No-op until per-project `DATA_DIR` (B2) is active. Provider key reads use `paths.settings()`/`.env` so they followed automatically.
- `resolve-cli.ts` prints pretty JSON. If B2 consumes it from shell, `jq` is often absent on Windows — add a `--field <name>` bare-scalar flag instead of relying on `jq`.

## For Plan B4 — whoami + port collision (required before go-live)

- Bind-or-increment within `[37800, 37950)`, verify ownership via a new `/api/whoami` (returns `{dataDir, dbPath, port}`; mirror `/api/version` in `Server.setupCoreRoutes`), persist the chosen port to `<dataDir>/worker.port`. Read the persisted port in `bun-runner.js` (before the `if (!process.env.CLAUDE_MEM_WORKER_PORT)` guard) so a project reclaims its port.
- **Port state must be per-project, NOT in `settings.json`.** `SettingsRoutes.handleUpdateSettings` writes `paths.settings()` (now GLOBAL, B3) and includes `CLAUDE_MEM_WORKER_PORT`. So if B4 tried to persist a per-project port via settings.json it would go global (wrong). Use a dedicated `<dataDir>/worker.port` file instead. (`clearPortCache()` is already called by SettingsRoutes on write.)
- B2 injects the candidate port and bun-runner respects an already-set `CLAUDE_MEM_WORKER_PORT`; B4's "read persisted port → set env → (bun-runner guard)" ordering fits cleanly.

## Go-live (build-and-sync) — DO NOT run until B2+B3+B4 all land

- B2 must not go live without B3 (config-split) and B4 (collision). The repo accumulates them safely; `build-and-sync` + worker restart is the only step that activates them on the user's machine.
- **No migration needed for existing users:** default `GLOBAL_CONFIG_DIR == ~/.engram`, identical to pre-B2 `DATA_DIR`, so `~/.engram/settings.json` is found unchanged. `resolveDataDir()` bootstrap reads `~/.engram/settings.json` (hardcoded) for a custom `CLAUDE_MEM_DATA_DIR` — still correct.
- Sweep remaining cosmetic `~/.claude-mem` strings in user-facing messages (`install.ts`, `EnvManager.ts` comments, `server-beta-bootstrap.ts:16`) before release — pre-existing from Plan A's minimum rebrand, out of scope of B-series.

## For Plan C — diffable `.mem/` export/import

- Stable cross-machine identity lives in `.mem/manifest.json` (`engramProjectId` UUID), NOT the slug or the port. Create it in C; the resolver intentionally does not provide it.
- Idempotent import relies on `observations.UNIQUE(memory_session_id, content_hash)` + `ON CONFLICT DO NOTHING` (verified in M1).
- Add `.mem/.runtime/` to the project `.gitignore`; add `*.ndjson merge=union` to `.mem/.gitattributes`.
- Chroma is rebuildable from SQLite (`ChromaSync.backfillAllProjects()` on worker start) — gitignore `.mem/.runtime/chroma`.
- **`<dataDir>/.mem/.runtime/worker.port` is ephemeral** (B4) — it lives under the gitignored `.mem/.runtime/`, so export/import must never sync it; if it ever lands on another machine, `claimPort` re-claims correctly anyway.
- **Subprocess probes/tests must pre-seed the global `settings.json`.** `SettingsDefaultsManager.loadFromFile` `console.log`s `[SETTINGS] Created…` to stdout on first creation, which corrupts stdout-as-protocol probes. Tests pre-write an empty `settings.json` in the temp global dir. A cleaner lib fix (log to stderr) is a possible C-prep cleanup. (B4 review-noted; `whoamiInfo().port` itself is correct — `applyEnvOverrides` applies the `CLAUDE_MEM_WORKER_PORT` env, so it returns the claimed port.)

## For Plan D — git sync + smoke test

- No `SessionEnd` hook exists; end-of-turn is the **`Stop`** hook. Commit cadence: export every Stop, debounced commit/push.
- Smoke test = two clones against a temp bare remote; assert observations + decisions + `state.md` propagate and appear in `/api/context/inject`.
- All git ops: short timeouts, non-fatal, never block the session (match existing hook IO discipline).
