# Engram Plan E — Packaging & Full Rebrand (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps. Follow superpowers:test-driven-development where tests exist.

**Goal:** Finish the rebrand Plan A deliberately deferred and package Engram so it installs cleanly (replacing claude-mem, no slug collision) and is product-quality. Two phases: **A** (load-bearing distribution rename — slug/identifier/repo/hooks/install + version/npm-name) and **B** (user-facing polish — copy, skills, README, docs site).

**Packaging decisions (defaults — adjust in spec review):**
- Marketplace slug: `thedotmack` → **`engram`**
- Plugin identifier: `claude-mem@thedotmack` → **`engram@engram`**
- GitHub repo: `thedotmack/claude-mem` → **`guneyunus/claude-memVY`** (origin)
- npm package name: `engram` (taken) → **`@guneyunus/engram`** (scoped); bin stays `engram`
- Version: `13.4.0` → **`1.0.0`** (Engram's first release under its own identity)
- npm publish: **PREPARE only** — the actual `npm publish` is a separate, explicitly-confirmed step (outward-facing, needs the user's npm auth)
- Codex marketplace slug: `claude-mem-local` → **`engram-local`**

**Architecture:** Extend the idempotent `scripts/rebrand.mjs` with the load-bearing slug/identifier/repo edits (lifting the deliberate `thedotmack`/`.mcp.json` exclusions). Change the slug in the hook generator `src/build/hook-shell-template.ts` and regenerate the canonical `hooks.json`/`codex-hooks.json`/`.mcp.json` via `npm run build` (byte-verified). User-facing copy + docs are a separate guarded sweep that protects internal `CLAUDE_MEM_*` env names and history/license.

**Reference:** the packaging map (research) with file:line for every slug/identifier/repo/copy site; `scripts/rebrand.mjs`; Apache-2.0 `LICENSE`/`NOTICE` (keep intact).

## Hard guards (do NOT change)
- Internal `CLAUDE_MEM_*` env var NAMES (only display copy + `~/.claude-mem` user-paths change). The redis prefix `claude_mem_` stays.
- `LICENSE`, `NOTICE`, Apache attribution; `CHANGELOG.md` history; `upstream` remote.
- `bun:sqlite`/core internals.

---

## PHASE A — Clean installable package (load-bearing)

### Task A1: Extend `rebrand.mjs` with slug / identifier / repo edits

**Files:** Modify `scripts/rebrand.mjs` (add entries); the edits touch `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `src/shared/paths.ts`, `src/npx-cli/utils/paths.ts`, `src/shared/plugin-state.ts`, `plugin/scripts/bun-runner.js`, `src/npx-cli/commands/install.ts`, `src/services/integrations/CodexCliInstaller.ts`, `scripts/sync-marketplace.cjs`, `package.json`.

- [ ] **Step 1: Add these entries to the `PLAN` array in `scripts/rebrand.mjs`** (exact strings from the packaging map; each is idempotent):

```js
  // ---- Plan E (full distribution rebrand): marketplace slug + plugin identifier + repo ----
  {
    file: '.claude-plugin/marketplace.json',
    edits: [ { from: '"name": "thedotmack",', to: '"name": "engram",' } ], // marketplace SLUG (RHS of identifier)
  },
  {
    file: '.agents/plugins/marketplace.json',
    edits: [
      { from: '"name": "claude-mem-local"', to: '"name": "engram-local"' },
      { from: '"name": "claude-mem"', to: '"name": "engram"' },
      { from: '"displayName": "claude-mem (local)"', to: '"displayName": "engram (local)"' },
    ],
  },
  {
    file: 'src/shared/paths.ts',
    edits: [ { from: "'plugins', 'marketplaces', 'thedotmack'", to: "'plugins', 'marketplaces', 'engram'" } ],
  },
  {
    file: 'src/npx-cli/utils/paths.ts',
    edits: [
      { from: "'marketplaces', 'thedotmack'", to: "'marketplaces', 'engram'" },
      { from: "'cache', 'thedotmack', 'claude-mem'", to: "'cache', 'engram', 'engram'" },
    ],
  },
  {
    file: 'src/shared/plugin-state.ts',
    edits: [ { from: "'claude-mem@thedotmack'", to: "'engram@engram'" } ],
  },
  {
    file: 'plugin/scripts/bun-runner.js',
    edits: [ { from: "enabledPlugins?.['claude-mem@thedotmack']", to: "enabledPlugins?.['engram@engram']" } ],
  },
  {
    file: 'src/npx-cli/commands/install.ts',
    edits: [
      { from: "knownMarketplaces['thedotmack']", to: "knownMarketplaces['engram']", all: true },
      { from: "repo: 'thedotmack/claude-mem'", to: "repo: 'guneyunus/claude-memVY'" },
      { from: "'claude-mem@thedotmack'", to: "'engram@engram'", all: true },
    ],
  },
  {
    file: 'src/services/integrations/CodexCliInstaller.ts',
    edits: [
      { from: "'claude-mem-local'", to: "'engram-local'", all: true },
      { from: "'claude-mem@claude-mem-local'", to: "'engram@engram-local'" },
      { from: "'claude-mem@thedotmack'", to: "'engram@engram'" },
    ],
  },
  {
    file: 'scripts/sync-marketplace.cjs',
    edits: [
      { from: "'marketplaces', 'thedotmack'", to: "'marketplaces', 'engram'", all: true },
      { from: "'cache', 'thedotmack', 'claude-mem'", to: "'cache', 'engram', 'engram'", all: true },
    ],
  },
  {
    file: 'package.json',
    edits: [ { from: 'marketplaces/thedotmack', to: 'marketplaces/engram' } ], // build-and-sync cd path
  },
```

NOTE: the exact `from` strings above are best-guesses from the research line refs — the implementer MUST open each file, confirm the precise current text, and adjust the `from` to match byte-for-byte before running (the script fails loudly on a MISSING edit, which is the signal to fix the string). Some sites (e.g. `sync-marketplace.cjs`, `npx-cli/utils/paths.ts`) may build the path with `join(...)` and different quoting — match the actual code.

- [ ] **Step 2:** `node scripts/rebrand.mjs` — expect all edits `applied`, `0 missing`. If any `MISSING`, fix that entry's `from` to the file's exact text and re-run. Idempotent re-run = `0 applied`.

- [ ] **Step 3:** Commit `scripts/rebrand.mjs` + the edited files.

### Task A2: Rename the slug in the hook generator + regenerate canonical hooks

**Files:** `src/build/hook-shell-template.ts`, then regenerate `plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`, `plugin/.mcp.json`.

- [ ] **Step 1:** In `src/build/hook-shell-template.ts`, change the cache/marketplace globs (around lines 109/113): `'$_C/plugins/cache/thedotmack/claude-mem'` → `'$_C/plugins/cache/engram/engram'`; `'$_C/plugins/marketplaces/thedotmack/plugin'` → `'$_C/plugins/marketplaces/engram/plugin'`. Also in `scripts/build-hooks.js` the `.mcp.json` `mcpExtraCacheRoots` (`$HOME/.codex/plugins/cache/claude-mem-local/claude-mem`, `.../thedotmack/claude-mem`) → `engram-local/engram`, `engram/engram`.
- [ ] **Step 2:** `npm run build` — regenerates `hooks.json`/`codex-hooks.json`/`.mcp.json` from the template. The canonical verifier (`verifyShellTemplateCanonical`) passes because the committed JSON is regenerated to match. If it throws "hand-edited", the JSON wasn't regenerated — ensure the build wrote them (it compares; you may need to update the committed JSON to the new generated strings — run the build, then `git diff` shows the regenerated JSON; commit it).
- [ ] **Step 3:** Run `npx bun test tests/infrastructure/plugin-distribution.test.ts` (byte-equality) and `tests/servers/mcp-server-name-safety.test.ts`. Fix any expected-string in those tests to the new slug. Commit.

### Task A3: Align disable-check tests + version/npm-name

**Files:** `tests/**/plugin-disabled-check.test.ts`, `tests/**/codex-cli-installer.test.ts`, `package.json` (name + version), then `sync-plugin-manifests` propagation.

- [ ] **Step 1:** Update the identifier expectations in `plugin-disabled-check.test.ts` (`claude-mem@thedotmack` → `engram@engram`) and `codex-cli-installer.test.ts` (`claude-mem-local`/`claude-mem@*` → `engram-local`/`engram@*`). Add to `rebrand.mjs` if literal.
- [ ] **Step 2:** `package.json`: `"name": "engram"` → `"name": "@guneyunus/engram"`; `"version": "13.4.0"` → `"version": "1.0.0"`. (bin stays `engram`.) Keep `repository`/`homepage` → update to `guneyunus/claude-memVY` (these propagate to manifests via `sync-plugin-manifests.js`).
- [ ] **Step 3:** Bump `version` to `1.0.0` in the manifests not covered by `sync-plugin-manifests` (`.claude-plugin/marketplace.json` `plugins[0].version`, `plugin/package.json`, `openclaw/*`). `npm run build` propagates `package.json` → the 4 plugin manifests.
- [ ] **Step 4:** `npm run typecheck:root && npx bun test tests/` (the suites that pass on Windows: engram, sqlite, servers/name-safety, infrastructure/plugin-distribution). Commit (source) + commit (regenerated artifacts).

### Task A4: Phase-A verification (dry-run the install path)

- [ ] **Step 1:** `npm run build` clean; `node -e "const m=require('./.claude-plugin/marketplace.json'); console.log(m.name, m.plugins[0].name)"` → `engram engram`.
- [ ] **Step 2:** Confirm install-path consistency: `grep -rn "thedotmack" src/ plugin/.mcp.json plugin/hooks/ scripts/sync-marketplace.cjs` — only acceptable matches are `upstream` repo refs / CHANGELOG / docs (Phase B). No remaining `thedotmack` in the runtime install-path resolution.
- [ ] **Step 3:** Commit. **Phase A done = Engram installs as `engram@engram` from `guneyunus/claude-memVY`, no claude-mem slug collision.**

---

## PHASE B — User-facing polish (copy, skills, README, docs)

### Task B1: User-facing copy sweep (guarded)

**Files:** `src/npx-cli/index.ts` (printHelp), `src/npx-cli/commands/install.ts`, `uninstall.ts` — display strings only.

- [ ] **Step 1:** Create `scripts/rebrand-copy.mjs` — a guarded sweep that, for the listed user-facing files only, replaces DISPLAY strings while PROTECTING internals. Transform (apply in order, per-file):
  - `npx claude-mem` → `npx engram`
  - `claude-mem install` / `claude-mem uninstall` (CLI command examples) → `engram install` / `engram uninstall`
  - `~/.claude-mem` → `~/.engram` (user-facing path mentions)
  - Display name `Claude-Mem` → `Engram`; standalone display `claude-mem` (in user-facing sentences/log strings, NOT identifiers/paths already handled) → `Engram`/`engram` as fits.
  - **GUARD — never replace:** any `CLAUDE_MEM_` token (env names), the redis `claude_mem_` prefix, `claude-mem@`/`@thedotmack` identifier remnants (Phase A handled those), URLs to `thedotmack/claude-mem` (those are `upstream`/attribution — leave or handle as repo ref). Implement the guard by skipping lines containing `CLAUDE_MEM_` and by using word-boundary-aware replacements.
- [ ] **Step 2:** Run it; `npm run build`; `node dist/npx-cli/index.js --help` (or the help command) shows `engram`/`Engram`, not `claude-mem`. `npm run typecheck:root` clean. Commit.

### Task B2: Skills + modes user-facing rebrand

**Files:** `plugin/skills/how-it-works/SKILL.md`, `plugin/skills/*/SKILL.md` (user-facing: how-it-works, onboarding, mem-search), `plugin/modes/code.json`.

- [ ] **Step 1:** In the USER-FACING skills (how-it-works, onboarding-explainer, mem-search) + `modes/code.json`, replace display `claude-mem`/`Claude-Mem` → `engram`/`Engram` and `~/.claude-mem` → `~/.engram`. Leave the internal/dev `version-bump`/`timeline-report` skill mechanics that reference `npx claude-mem@X` until Task B4 (npm). Commit.

### Task B3: README rebrand

**Files:** `README.md` (+ `docs/i18n/` is auto-generated translations — leave or regenerate later).

- [ ] **Step 1:** Rebrand `README.md`: title/logo/name → Engram; install commands → `/plugin marketplace add guneyunus/claude-memVY` + `/plugin install engram` (marketplace flow) and `npx @guneyunus/engram install` (npm flow); repo links `thedotmack/claude-mem` → `guneyunus/claude-memVY`; data dir `~/.claude-mem` → `~/.engram`. Keep the Apache-2.0 + upstream-attribution note. Commit.

### Task B4: Mintlify docs site rebrand

**Files:** `docs/public/docs.json` + `docs/public/**/*.mdx`.

- [ ] **Step 1:** `docs.json`: `"name": "Claude-Mem"` → `"Engram"`; logo/favicon paths → engram assets (or keep placeholders + note assets needed); GitHub href `thedotmack/claude-mem` → `guneyunus/claude-memVY`.
- [ ] **Step 2:** Sweep `docs/public/**/*.mdx`: display `Claude-Mem`/`claude-mem` → `Engram`/`engram`, `npx claude-mem` → `npx @guneyunus/engram`, `~/.claude-mem` → `~/.engram`, repo links → fork. GUARD: keep `CLAUDE_MEM_*` env-var docs accurate (those names are unchanged). Commit. (Auto-deploy only happens if the user wires Mintlify to their fork — note this.)

### Task B5: version-bump skill npm references + final verify

**Files:** `plugin/skills/version-bump/SKILL.md`.

- [ ] **Step 1:** Update the release skill's `npx claude-mem@X.Y.Z` / `npm view claude-mem` → `npx @guneyunus/engram@X.Y.Z` / `npm view @guneyunus/engram`, and the 7-manifest list (already current). Note `npm publish` requires `@guneyunus` scope auth + `--access public`. Do NOT publish here.
- [ ] **Step 2:** Final: `npm run build` clean; full Windows-green suites pass; `grep -rn "claude-mem" src/ plugin/ --include=*.ts --include=*.js --include=*.cjs | grep -v CLAUDE_MEM | grep -v upstream` → only intentional retains. Commit.

---

## Definition of done (Plan E)
- **Phase A:** marketplace slug `engram`, identifier `engram@engram`, repo `guneyunus/claude-memVY`, regenerated canonical hooks/.mcp.json, install machinery consistent; `package.json` `@guneyunus/engram@1.0.0`; build + Windows-green tests pass; no `thedotmack` in runtime install-path resolution.
- **Phase B:** no user-facing `claude-mem`/`Claude-Mem`/`~/.claude-mem` in CLI help, install/uninstall messages, user skills, modes, README, docs.json + mdx (env-var names + license + history retained).
- npm publish PREPARED (scoped name + version + access note) but NOT executed.
- `rebrand.mjs` (+ `rebrand-copy.mjs`) extended so the whole rebrand re-applies idempotently after upstream merges.

## Self-review notes (author)
- **Scope:** completes the full rebrand Plan A deferred + packaging, in two phases (A load-bearing, B polish). The `from` strings in A1 are research-derived and MUST be byte-confirmed against each file before running (`rebrand.mjs` fails loudly on mismatch — that's the safety net).
- **Risk:** A is load-bearing (install path + byte-verified hooks). Mitigations: rebrand.mjs idempotency + MISSING-fails-loud; regenerate hooks via the generator (never hand-edit); Phase-A install dry-run; do A fully (incl. tests + build) before B.
- **Outward-facing:** the actual `npm publish` and any push of test installs are deferred to explicit confirmation. Marketplace-from-GitHub needs only the pushed fork.
- **Out of scope:** generating engram logo/favicon assets (placeholders + note); regenerating `docs/i18n/` translations; actually wiring Mintlify auto-deploy to the fork.
