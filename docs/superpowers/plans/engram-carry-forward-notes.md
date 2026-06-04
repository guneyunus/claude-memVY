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
- **Port collision MUST be implemented in B2.** `projectWorkerPort` returns a *candidate*. With ~10 active projects on one machine the birthday-problem collision probability is ~26%. B2 must bind-or-increment within `[PORT_BASE, PORT_BASE+PORT_RANGE)` and persist the actual chosen port to `<dataDir>/worker.port`. Do not ship B2 without this.
- **Single-instance must key on the absolute `root`, not `slug`** — two different projects can share a directory basename. Use `ProjectRuntime.root`.
- **Config split ordering:** redirect the secret/settings reads to `globalSettingsPath()` / `globalEnvPath()` **before** `DATA_DIR` is changed to project-local, or the user's existing `~/.engram/settings.json` (+ `.env` secrets) silently become per-project. Touch-points: `EnvManager.envFilePath()`, every `loadFromFile(USER_SETTINGS_PATH)` / `loadFromFile(paths.settings())` reader, and the provider key reads (`GeminiProvider`, `OpenRouterProvider`, `ClaudeProvider`). The secret-bearing keys to keep global: `CLAUDE_MEM_*_API_KEY`, `CLAUDE_MEM_TELEGRAM_BOT_TOKEN`, `CLAUDE_MEM_SERVER_BETA_API_KEY`, and the `.env` Anthropic/Gemini/OpenRouter keys.
- `resolve-cli.ts` prints pretty JSON. If B2 consumes it from shell, `jq` is often absent on Windows — add a `--field <name>` bare-scalar flag instead of relying on `jq`.

## For Plan C — diffable `.mem/` export/import

- Stable cross-machine identity lives in `.mem/manifest.json` (`engramProjectId` UUID), NOT the slug or the port. Create it in C; the resolver intentionally does not provide it.
- Idempotent import relies on `observations.UNIQUE(memory_session_id, content_hash)` + `ON CONFLICT DO NOTHING` (verified in M1).
- Add `.mem/.runtime/` to the project `.gitignore`; add `*.ndjson merge=union` to `.mem/.gitattributes`.
- Chroma is rebuildable from SQLite (`ChromaSync.backfillAllProjects()` on worker start) — gitignore `.mem/.runtime/chroma`.

## For Plan D — git sync + smoke test

- No `SessionEnd` hook exists; end-of-turn is the **`Stop`** hook. Commit cadence: export every Stop, debounced commit/push.
- Smoke test = two clones against a temp bare remote; assert observations + decisions + `state.md` propagate and appear in `/api/context/inject`.
- All git ops: short timeouts, non-fatal, never block the session (match existing hook IO discipline).
