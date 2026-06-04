# Engram Plan A — Rebrand Skeleton + Fork Hygiene (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the minimum user-facing surface of the `claude-mem` fork to **Engram** (package, plugin, data dir, MCP server name) via a re-runnable script, add the `upstream` remote, and verify the build + worker still start.

**Architecture:** A single declarative, idempotent script (`scripts/rebrand.mjs`) applies a fixed list of exact `{file, from, to}` string edits to the **source-of-truth files only**. The 4 generated plugin manifests (`.claude-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, and the two `.codex-plugin/plugin.json`) are NOT edited directly — `scripts/sync-plugin-manifests.js` regenerates them from root `package.json` on `npm run build`. Internal `CLAUDE_MEM_*` env var names and the load-bearing `thedotmack` marketplace slug / install-path strings are deliberately retained.

**Tech Stack:** Node ESM scripts, Bun test runner, TypeScript, npm scripts.

**Reference spec:** `docs/superpowers/specs/2026-06-04-engram-project-local-memory-design.md` (§8 Rebrand surface, §9 Upstream-merge strategy).

**Deliberately OUT of scope for Plan A (do NOT touch):**
- Internal `CLAUDE_MEM_*` env var names (retained; renaming is 100+ merge-conflict points).
- `thedotmack` marketplace name (`.claude-plugin/marketplace.json` `"name": "thedotmack"`) and the install-path resolution strings in `plugin/.mcp.json` (`thedotmack/claude-mem`, `claude-mem-local/claude-mem`) — these match physical install directories on disk.
- Stale `~/.claude-mem/...` references that are only **comments or log strings** (e.g. in `EnvManager.ts`, `install.ts`). They are cosmetic; the real paths follow `DATA_DIR` once the two authoritative files change.
- One-time `~/.claude-mem` → `~/.engram` data migration (deferred; a fresh empty data dir is acceptable for development).
- `~/.engram` data lives at the new path after this plan; existing `~/.claude-mem` data is intentionally left orphaned.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `scripts/rebrand.mjs` | The re-runnable rebrand engine (declarative edit list + idempotent apply) | Create |
| `package.json` (root) | Source of truth for plugin name/description (propagates to manifests) + CLI bin name | Modify (via script) |
| `plugin/package.json` | Runtime-deps package name | Modify (via script) |
| `.claude-plugin/marketplace.json` | Marketplace plugin entry (NOT auto-synced) | Modify (via script) |
| `plugin/.mcp.json` | MCP server registration key + not-found message | Modify (via script) |
| `scripts/build-hooks.js` | Validators that reference the MCP server key | Modify (via script) |
| `src/servers/mcp-server.ts` | Internal MCP server self-reported name | Modify (via script) |
| `src/shared/paths.ts` | Authoritative data-dir + db filename | Modify (via script) |
| `src/shared/SettingsDefaultsManager.ts` | Authoritative data-dir defaults + OpenRouter app name | Modify (via script) |
| `src/cli/claude-md-commands.ts` | Directory denylist for CLAUDE.md scanning | Modify (via script) |
| `tests/servers/mcp-server-name-safety.test.ts` | Pins MCP-safe server/tool names; carries the qualified-prefix constant | Modify (via script) |

---

## Task 0: Fork hygiene — add the `upstream` remote

**Files:** none (git remote config).

- [ ] **Step 1: Add the upstream remote (idempotent)**

Run:
```bash
git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/thedotmack/claude-mem.git
git remote -v
```
Expected: output lists both `origin` and `upstream`, with `upstream` pointing at `https://github.com/thedotmack/claude-mem.git` (fetch + push).

- [ ] **Step 2: Verify we are on the feature branch**

Run:
```bash
git branch --show-current
```
Expected: `engram/project-local-memory`. If not, run `git checkout engram/project-local-memory`.

(No commit — remote config is local-only.)

---

## Task 1: Create the rebrand script `scripts/rebrand.mjs`

**Files:**
- Create: `scripts/rebrand.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/rebrand.mjs` with this exact content:

```js
#!/usr/bin/env node
// Engram rebrand engine — re-runnable after every upstream merge.
// Applies a FIXED list of exact string edits to source-of-truth files only.
// Idempotent: if a `from` string is already replaced by its `to`, the edit is
// skipped. If neither `from` nor `to` is present, the edit is reported MISSING
// and the script exits non-zero (so upstream drift fails loudly).
//
// Deliberately retained (NOT rebranded): internal CLAUDE_MEM_* env names, the
// `thedotmack` marketplace slug, and plugin/.mcp.json install-path resolution.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{file: string, edits: {from: string, to: string, all?: boolean}[]}[]} */
const PLAN = [
  {
    file: 'package.json',
    edits: [
      { from: '"name": "claude-mem",', to: '"name": "engram",' },
      { from: '"claude-mem": "./dist/npx-cli/index.js"', to: '"engram": "./dist/npx-cli/index.js"' },
      {
        from: '"description": "Memory compression system for Claude Code - persist context across sessions",',
        to: '"description": "Engram: project-local, git-native memory for Claude Code",',
      },
    ],
  },
  {
    file: 'plugin/package.json',
    edits: [
      { from: '"name": "claude-mem-plugin",', to: '"name": "engram-plugin",' },
      {
        from: '"Runtime dependencies for claude-mem bundled hooks"',
        to: '"Runtime dependencies for engram bundled hooks"',
      },
    ],
  },
  {
    file: '.claude-plugin/marketplace.json',
    edits: [
      // plugins[0].name only — the marketplace "name": "thedotmack" is load-bearing and left alone.
      { from: '"name": "claude-mem",', to: '"name": "engram",' },
      {
        from: '"Persistent memory system for Claude Code - context compression across sessions"',
        to: '"Engram: project-local, git-native memory for Claude Code"',
      },
    ],
  },
  {
    file: 'plugin/.mcp.json',
    edits: [
      { from: '"mcp-search": {', to: '"engram": {' },
      { from: 'claude-mem: mcp server not found', to: 'engram: mcp server not found' },
    ],
  },
  {
    // NOTE: build-hooks.js is ALSO a canonical generator — it emits plugin/.mcp.json's
    // shell string (incl. the not-found message) AND hard-codes plugin/package.json's
    // name+description. Those generator strings must be rebranded too, or `npm run build`
    // regenerates the old names back over the file edits.
    file: 'scripts/build-hooks.js',
    edits: [
      { from: "['mcp-search']", to: "['engram']", all: true },
      { from: '(mcp-search). It no longer matches', to: '(engram). It no longer matches' },
      { from: '.mcp.json mcp-search launcher must include Codex', to: '.mcp.json engram launcher must include Codex' },
      { from: '.mcp.json mcp-search launcher must include Claude', to: '.mcp.json engram launcher must include Claude' },
      { from: "notFoundMessage: 'claude-mem: mcp server not found',", to: "notFoundMessage: 'engram: mcp server not found'," },
      { from: "      name: 'claude-mem-plugin',", to: "      name: 'engram-plugin'," },
      { from: "      description: 'Runtime dependencies for claude-mem bundled hooks',", to: "      description: 'Runtime dependencies for engram bundled hooks'," },
    ],
  },
  {
    file: 'src/servers/mcp-server.ts',
    edits: [
      { from: "name: 'claude-mem',", to: "name: 'engram'," },
    ],
  },
  {
    file: 'src/shared/paths.ts',
    edits: [
      { from: "join(homedir(), '.claude-mem')", to: "join(homedir(), '.engram')" },
      { from: "'claude-mem.db'", to: "'engram.db'", all: true },
    ],
  },
  {
    file: 'src/shared/SettingsDefaultsManager.ts',
    edits: [
      { from: "CLAUDE_MEM_OPENROUTER_APP_NAME: 'claude-mem',", to: "CLAUDE_MEM_OPENROUTER_APP_NAME: 'engram'," },
      { from: "join(homedir(), '.claude-mem'", to: "join(homedir(), '.engram'", all: true },
    ],
  },
  {
    file: 'src/cli/claude-md-commands.ts',
    edits: [
      { from: "'.claude-mem', '.open-next', '.turbo'", to: "'.engram', '.mem', '.open-next', '.turbo'", all: true },
    ],
  },
  {
    file: 'tests/servers/mcp-server-name-safety.test.ts',
    edits: [
      { from: "'mcp__plugin_claude-mem_mcp-search__'", to: "'mcp__plugin_engram_engram__'" },
    ],
  },
];

let applied = 0;
let skipped = 0;
const missing = [];

for (const { file, edits } of PLAN) {
  const abs = path.join(rootDir, file);
  if (!fs.existsSync(abs)) {
    missing.push(`${file} (file not found)`);
    continue;
  }
  let text = fs.readFileSync(abs, 'utf8');
  let changed = false;
  for (const { from, to, all } of edits) {
    if (text.includes(from)) {
      text = all ? text.split(from).join(to) : text.replace(from, to);
      changed = true;
      applied++;
    } else if (text.includes(to)) {
      skipped++; // already rebranded — idempotent no-op
    } else {
      missing.push(`${file}: "${from}"`);
    }
  }
  if (changed) fs.writeFileSync(abs, text);
}

console.log(`rebrand: ${applied} applied, ${skipped} already-applied, ${missing.length} missing`);
if (missing.length) {
  console.error('rebrand: MISSING edits (upstream drift — update scripts/rebrand.mjs):');
  for (const m of missing) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ rebrand complete');
```

- [ ] **Step 2: Commit the script (before running it)**

```bash
git add scripts/rebrand.mjs
git commit -m "build(engram): add re-runnable rebrand script (scripts/rebrand.mjs)"
```

---

## Task 2: Run the rebrand and confirm every edit applied

**Files:** modifies the 8 source-of-truth files listed in the script (not the 4 generated manifests).

- [ ] **Step 1: Run the script**

Run:
```bash
node scripts/rebrand.mjs
```
Expected: `rebrand: 23 applied, 0 already-applied, 0 missing` then `✓ rebrand complete`. Exit code 0. (23 edits — `build-hooks.js` carries 7 of them because it is also a generator.)

(If it prints any `MISSING` lines and exits 1, an upstream change altered a `from` string — update that entry in `scripts/rebrand.mjs` to the new exact text and re-run. Do NOT proceed until it is clean.)

- [ ] **Step 2: Run it a second time to prove idempotency**

Run:
```bash
node scripts/rebrand.mjs
```
Expected: `rebrand: 0 applied, 23 already-applied, 0 missing` and exit 0. (No file should change on the second run.)

- [ ] **Step 3: Spot-check the authoritative edits**

Run:
```bash
git diff --stat
```
Expected: changes in `package.json`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.mcp.json`, `scripts/build-hooks.js`, `src/servers/mcp-server.ts`, `src/shared/paths.ts`, `src/shared/SettingsDefaultsManager.ts`, `src/cli/claude-md-commands.ts`, `tests/servers/mcp-server-name-safety.test.ts` (10 files).

---

## Task 3: Rebuild so generated manifests pick up the new name, then verify

**Files:** regenerates `.claude-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json` from `package.json`.

- [ ] **Step 1: Build (runs manifest sync + hook generation)**

Run:
```bash
npm run build
```
Expected: `✓ Synced plugin manifests from package.json` and the hook build completes with no error. Critically, **`build-hooks.js` must NOT throw** — its `['engram']` validators now match the renamed `plugin/.mcp.json` key. A thrown "Hand-edited shell string" or "launcher must include … fallback" error means an edit in Task 1 was wrong; fix and re-run.

- [ ] **Step 2: Verify the generated Claude plugin manifest is now `engram`**

Run:
```bash
node -e "console.log(require('./plugin/.claude-plugin/plugin.json').name, '|', require('./.claude-plugin/plugin.json').name)"
```
Expected: `engram | engram`.

- [ ] **Step 3: Verify the MCP server key renamed and install-path strings preserved**

Run:
```bash
node -e "const m=require('./plugin/.mcp.json'); console.log('keys:', Object.keys(m.mcpServers)); console.log('thedotmack-preserved:', JSON.stringify(m).includes('thedotmack/claude-mem'))"
```
Expected: `keys: [ 'engram' ]` and `thedotmack-preserved: true` (the load-bearing install-path fallback must still be present).

- [ ] **Step 4: Verify the authoritative data dir is now `~/.engram`**

Run:
```bash
node -e "const o=process.env.CLAUDE_MEM_DATA_DIR; delete process.env.CLAUDE_MEM_DATA_DIR; import('./dist/shared/paths.js').then(p=>{console.log('DATA_DIR endsWith .engram:', p.DATA_DIR.endsWith('.engram')); console.log('DB basename:', require('path').basename(p.DB_PATH));}).finally(()=>{if(o)process.env.CLAUDE_MEM_DATA_DIR=o;})"
```
Expected: `DATA_DIR endsWith .engram: true` and `DB basename: engram.db`.
(If `dist/shared/paths.js` does not exist because the build only emits hooks, instead grep the source: `grep -n "'.engram'" src/shared/paths.ts` must show the `defaultDataDir` line and `grep -n "engram.db" src/shared/paths.ts` must show two matches.)

---

## Task 4: Typecheck + name-safety test stay green

**Files:** `tests/servers/mcp-server-name-safety.test.ts` (already edited by the script).

- [ ] **Step 1: Typecheck the root project**

Run:
```bash
npm run typecheck:root
```
Expected: `tsc --noEmit` completes with no errors. (Renaming string literals must not introduce type errors.)

- [ ] **Step 2: Run the MCP name-safety test**

Run:
```bash
bun test tests/servers/mcp-server-name-safety.test.ts
```
Expected: both tests PASS. The server key `engram` is colon/dot-free and MCP-safe; tool names + the updated `QUALIFIED_PREFIX` (`mcp__plugin_engram_engram__`, now shorter) remain within the 64-char budget.

- [ ] **Step 3: Run the broader unit suites that touch naming/paths (sanity)**

Run:
```bash
bun test tests/servers/
```
Expected: PASS (no test still asserts the old `mcp-search`/`claude-mem` server name). If a test hard-codes `mcp-search` or `claude-mem` as the server name, update that assertion to `engram` and re-run — note it in the commit.

---

## Task 5: Worker still starts (using the new data dir)

**Files:** none (runtime check).

- [ ] **Step 1: Restart the worker**

Run:
```bash
npm run worker:restart
```
Expected: the worker stops any prior instance and starts a fresh daemon. (It now reads/writes under `~/.engram`.)

- [ ] **Step 2: Confirm worker status is healthy**

Run:
```bash
npm run worker:status
```
Expected: status reports the worker running and reachable on its port. If it reports not-running, run `npm run worker:logs` and resolve before committing (a healthy worker is the Plan A success bar).

---

## Task 6: Commit the rebrand

**Files:** the 10 edited source files + 4 regenerated manifests.

- [ ] **Step 1: Stage and commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(engram): minimum rebrand — package, plugin, MCP server, data dir

Rename the user-facing surface from claude-mem to engram via the
re-runnable scripts/rebrand.mjs: package + bin name, plugin name (propagated
to manifests by sync-plugin-manifests.js), marketplace entry, MCP server key
(mcp-search -> engram) with its build-hooks.js validators, internal MCP
self-name, and the authoritative data dir (~/.claude-mem -> ~/.engram,
claude-mem.db -> engram.db). Internal CLAUDE_MEM_* env names and the
thedotmack install-path strings are retained.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Confirm the tree is clean**

Run:
```bash
git status
```
Expected: `nothing to commit, working tree clean`.

---

## Definition of done (Plan A)

- `node scripts/rebrand.mjs` is idempotent (second run = `0 applied`).
- `npm run build` regenerates manifests showing `name: engram`; `build-hooks.js` validators pass against the `engram` MCP key.
- `npm run typecheck:root` clean; `bun test tests/servers/` green.
- `npm run worker:status` reports healthy (worker runs against `~/.engram`).
- The `thedotmack` marketplace slug and `plugin/.mcp.json` install-path fallbacks are preserved.
- `upstream` remote is configured.

## Self-review notes (author)

- **Spec coverage:** Implements spec §8 (minimum rebrand surface: package, plugin, data dir, MCP name) and §9 (upstream remote + re-runnable rebrand script). Config split (§4.5), exporter/importer/sync (§4.2–4.4), and project-local runtime (§4.1) are Plans B–D — intentionally not here.
- **No placeholders:** every edit is an exact string; every step has a runnable command + expected output.
- **Consistency:** the edit count (23 edits across 11 files) matches the PLAN array; `QUALIFIED_PREFIX` updated to `mcp__plugin_engram_engram__` consistent with plugin name `engram` + server key `engram`.
- **Key correctness guard:** plugin manifests are NOT hand-edited because `sync-plugin-manifests.js` regenerates them from `package.json` on build — so only `package.json` is the source for those names.
