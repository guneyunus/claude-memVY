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
    file: 'scripts/build-hooks.js',
    edits: [
      { from: "['mcp-search']", to: "['engram']", all: true },
      { from: '(mcp-search). It no longer matches', to: '(engram). It no longer matches' },
      { from: '.mcp.json mcp-search launcher must include Codex', to: '.mcp.json engram launcher must include Codex' },
      { from: '.mcp.json mcp-search launcher must include Claude', to: '.mcp.json engram launcher must include Claude' },
      // The canonical shell-template generator must emit the same notFoundMessage as plugin/.mcp.json.
      { from: "notFoundMessage: 'claude-mem: mcp server not found',", to: "notFoundMessage: 'engram: mcp server not found'," },
      // build-hooks.js hard-codes plugin/package.json content; keep in sync with the renamed package.
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
