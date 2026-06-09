#!/usr/bin/env node
// Engram Phase-B display-copy rebrand sweep — re-runnable after every upstream merge.
// Replaces user-facing "claude-mem"/"Claude-Mem"/"~/.claude-mem"/"npx claude-mem"
// display strings with "engram"/"Engram"/"~/.engram"/"npx @guneyunus/engram".
//
// GUARDS (never replaced):
//   - Lines containing CLAUDE_MEM_ (env-var names stay unchanged)
//   - Lines containing claude_mem_ (redis prefix stays)
//   - The strings "upstream" or "forked" (attribution comments)
//   - LICENSE / NOTICE / CHANGELOG.md are never opened
//
// SCOPE: only the listed user-facing files.
// Idempotent: if both `from` and `to` are absent the edit is MISSING (exits non-zero).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Apply a line-by-line guarded replacement to a file.
// Lines containing any guard token are left untouched.
// Returns count of replacements made.
// This is a sweep: if `from` is not in the file, silently skip (not an error).
function applyGuardedReplacements(filePath, replacements) {
  const GUARDS = ['CLAUDE_MEM_', 'claude_mem_', 'upstream', 'forked', 'thedotmack/claude-mem'];
  let content = fs.readFileSync(filePath, 'utf-8');
  let totalApplied = 0;

  for (const { from, to, all } of replacements) {
    // If `from` is not present, skip silently (sweep-mode — not every file has every string).
    if (!content.includes(from)) {
      continue;
    }

    // Line-by-line guarded replacement
    const lines = content.split('\n');
    const newLines = lines.map((line) => {
      // Skip lines that contain any guard token
      if (GUARDS.some((g) => line.includes(g))) return line;
      if (!line.includes(from)) return line;
      if (all) {
        const replaced = line.split(from).join(to);
        if (replaced !== line) totalApplied++;
        return replaced;
      } else {
        const idx = line.indexOf(from);
        if (idx === -1) return line;
        totalApplied++;
        return line.slice(0, idx) + to + line.slice(idx + from.length);
      }
    });
    content = newLines.join('\n');
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return totalApplied;
}

// Apply MDX-wide replacements (for docs/public/*.mdx).
// Guards the same tokens.
function applyMdxReplacements(filePath, replacements) {
  return applyGuardedReplacements(filePath, replacements);
}

// ---- B1: CLI display strings ----
const cliReplacements = [
  // npx commands
  { from: 'npx claude-mem transcript watch', to: 'npx @guneyunus/engram transcript watch', all: true },
  { from: 'npx claude-mem server', to: 'npx @guneyunus/engram server', all: true },
  { from: 'npx claude-mem worker', to: 'npx @guneyunus/engram worker', all: true },
  { from: 'npx claude-mem install', to: 'npx @guneyunus/engram install', all: true },
  { from: 'npx claude-mem uninstall', to: 'npx @guneyunus/engram uninstall', all: true },
  { from: 'npx claude-mem repair', to: 'npx @guneyunus/engram repair', all: true },
  { from: 'npx claude-mem update', to: 'npx @guneyunus/engram update', all: true },
  { from: 'npx claude-mem version', to: 'npx @guneyunus/engram version', all: true },
  { from: 'npx claude-mem start', to: 'npx @guneyunus/engram start', all: true },
  { from: 'npx claude-mem stop', to: 'npx @guneyunus/engram stop', all: true },
  { from: 'npx claude-mem restart', to: 'npx @guneyunus/engram restart', all: true },
  { from: 'npx claude-mem status', to: 'npx @guneyunus/engram status', all: true },
  { from: 'npx claude-mem doctor', to: 'npx @guneyunus/engram doctor', all: true },
  { from: 'npx claude-mem search', to: 'npx @guneyunus/engram search', all: true },
  { from: 'npx claude-mem adopt', to: 'npx @guneyunus/engram adopt', all: true },
  { from: 'npx claude-mem cleanup', to: 'npx @guneyunus/engram cleanup', all: true },
  { from: "'npx claude-mem'", to: "'npx @guneyunus/engram'", all: true },
  // Standalone npx claude-mem (catch-all for remaining)
  { from: 'npx claude-mem`', to: 'npx @guneyunus/engram`', all: true },
  { from: '`npx claude-mem', to: '`npx @guneyunus/engram', all: true },
  // Display name Claude-Mem / claude-mem in console messages / user-visible strings
  { from: "'claude-mem install'", to: "'engram install'", all: true },
  { from: "'claude-mem uninstall'", to: "'engram uninstall'", all: true },
  { from: "'claude-mem repair'", to: "'engram repair'", all: true },
  { from: '`claude-mem install`', to: '`engram install`', all: true },
  { from: '`claude-mem uninstall`', to: '`engram uninstall`', all: true },
  { from: '`claude-mem repair`', to: '`engram repair`', all: true },
  { from: '`claude-mem start`', to: '`engram start`', all: true },
  { from: '`claude-mem status`', to: '`engram status`', all: true },
  { from: 'claude-mem --help`', to: 'engram --help`', all: true },
  // Unquoted references in console.log / error strings
  { from: "'claude-mem'", to: "'engram'", all: true },
  // Display name in bold/banner strings
  { from: "'claude-mem'", to: "'engram'", all: true },
  { from: "' claude-mem install '", to: "' engram install '", all: true },
  { from: "' claude-mem repair '", to: "' engram repair '", all: true },
  { from: "' claude-mem uninstall '", to: "' engram uninstall '", all: true },
  // Data dir mentions in user messages
  { from: '~/.claude-mem', to: '~/.engram', all: true },
  // Display name Claude-Mem
  { from: 'Claude-Mem', to: 'Engram', all: true },
  // Display in prompt strings (e.g. "claude-mem install")
  { from: "'claude-mem'", to: "'engram'", all: true },
];

// ---- B2: skills display replacements ----
const skillReplacements = [
  { from: 'claude-mem', to: 'engram', all: true },
  { from: 'Claude-Mem', to: 'Engram', all: true },
  { from: '~/.claude-mem', to: '~/.engram', all: true },
  { from: 'npx claude-mem', to: 'npx @guneyunus/engram', all: true },
];

// ---- B3/B4: README + docs replacements ----
const docsReplacements = [
  // Install commands
  { from: 'npx claude-mem install', to: 'npx @guneyunus/engram install', all: true },
  { from: 'npx claude-mem uninstall', to: 'npx @guneyunus/engram uninstall', all: true },
  { from: 'npx claude-mem repair', to: 'npx @guneyunus/engram repair', all: true },
  { from: 'npx claude-mem update', to: 'npx @guneyunus/engram update', all: true },
  { from: 'npx claude-mem start', to: 'npx @guneyunus/engram start', all: true },
  { from: 'npx claude-mem stop', to: 'npx @guneyunus/engram stop', all: true },
  { from: 'npx claude-mem restart', to: 'npx @guneyunus/engram restart', all: true },
  { from: 'npx claude-mem status', to: 'npx @guneyunus/engram status', all: true },
  { from: 'npx claude-mem doctor', to: 'npx @guneyunus/engram doctor', all: true },
  { from: 'npx claude-mem server', to: 'npx @guneyunus/engram server', all: true },
  { from: 'npx claude-mem search', to: 'npx @guneyunus/engram search', all: true },
  { from: 'npx claude-mem', to: 'npx @guneyunus/engram', all: true },
  // Data dir
  { from: '~/.claude-mem', to: '~/.engram', all: true },
  // Display names (markdown/prose)
  { from: 'Claude-Mem', to: 'Engram', all: true },
];

// ---- B5: version-bump skill replacements ----
const versionBumpReplacements = [
  { from: 'npx claude-mem@', to: 'npx @guneyunus/engram@', all: true },
  { from: 'npm view claude-mem', to: 'npm view @guneyunus/engram', all: true },
  { from: 'npm publish\n', to: 'npm publish --access public\n', all: false },
  { from: 'npx claude-mem', to: 'npx @guneyunus/engram', all: true },
  { from: 'claude-mem', to: 'engram', all: true },
  { from: 'Claude-Mem', to: 'Engram', all: true },
  { from: '~/.claude-mem', to: '~/.engram', all: true },
];

// Files to process
const CLI_FILES = [
  'src/npx-cli/index.ts',
  'src/npx-cli/commands/install.ts',
  'src/npx-cli/commands/uninstall.ts',
];

const USER_SKILL_FILES = [
  'plugin/skills/how-it-works/SKILL.md',
  'plugin/skills/mem-search/SKILL.md',
];

const MDX_FILES_TO_SWEEP = [
  'docs/public/installation.mdx',
  'docs/public/introduction.mdx',
  'docs/public/usage/getting-started.mdx',
  'docs/public/usage/search-tools.mdx',
  'docs/public/usage/knowledge-agents.mdx',
  'docs/public/usage/claude-desktop.mdx',
  'docs/public/usage/private-tags.mdx',
  'docs/public/usage/export-import.mdx',
  'docs/public/usage/manual-recovery.mdx',
  'docs/public/usage/folder-context.mdx',
  'docs/public/usage/openrouter-provider.mdx',
  'docs/public/usage/gemini-provider.mdx',
  'docs/public/architecture/overview.mdx',
  'docs/public/architecture/database.mdx',
  'docs/public/architecture/hooks.mdx',
  'docs/public/architecture/worker-service.mdx',
  'docs/public/architecture/search-architecture.mdx',
  'docs/public/architecture/pm2-to-bun-migration.mdx',
  'docs/public/architecture-evolution.mdx',
  'docs/public/beta-features.mdx',
  'docs/public/configuration.mdx',
  'docs/public/configuration/litellm-gateway.mdx',
  'docs/public/configuration/custom-anthropic-backends.mdx',
  'docs/public/context-engineering.mdx',
  'docs/public/cursor/index.mdx',
  'docs/public/cursor/gemini-setup.mdx',
  'docs/public/cursor/openrouter-setup.mdx',
  'docs/public/development.mdx',
  'docs/public/endless-mode.mdx',
  'docs/public/file-read-gate.mdx',
  'docs/public/gemini-cli/setup.mdx',
  'docs/public/hooks-architecture.mdx',
  'docs/public/modes.mdx',
  'docs/public/openclaw-integration.mdx',
  'docs/public/platform-integration.mdx',
  'docs/public/progressive-disclosure.mdx',
  'docs/public/smart-explore-benchmark.mdx',
  'docs/public/troubleshooting.mdx',
];

let totalChanged = 0;

// B1: CLI files
console.log('\n=== B1: CLI display strings ===');
for (const relFile of CLI_FILES) {
  const abs = path.join(rootDir, relFile);
  if (!fs.existsSync(abs)) { console.warn(`  MISSING FILE: ${relFile}`); continue; }
  const n = applyGuardedReplacements(abs, cliReplacements);
  console.log(`  ${relFile}: ${n} replacements`);
  totalChanged += n;
}

// B2: User-facing skill SKILL.md files
console.log('\n=== B2: User-facing skills ===');
for (const relFile of USER_SKILL_FILES) {
  const abs = path.join(rootDir, relFile);
  if (!fs.existsSync(abs)) { console.warn(`  MISSING FILE: ${relFile}`); continue; }
  const n = applyGuardedReplacements(abs, skillReplacements);
  console.log(`  ${relFile}: ${n} replacements`);
  totalChanged += n;
}

// B3: README.md
console.log('\n=== B3: README.md ===');
{
  const abs = path.join(rootDir, 'README.md');
  const n = applyGuardedReplacements(abs, docsReplacements);
  console.log(`  README.md: ${n} replacements`);
  totalChanged += n;
}

// B4: docs/public/**/*.mdx
console.log('\n=== B4: MDX docs ===');
for (const relFile of MDX_FILES_TO_SWEEP) {
  const abs = path.join(rootDir, relFile);
  if (!fs.existsSync(abs)) { console.warn(`  MISSING FILE: ${relFile}`); continue; }
  const n = applyMdxReplacements(abs, docsReplacements);
  console.log(`  ${relFile}: ${n} replacements`);
  totalChanged += n;
}

// B5: version-bump skill
console.log('\n=== B5: version-bump skill ===');
{
  const abs = path.join(rootDir, 'plugin/skills/version-bump/SKILL.md');
  const n = applyGuardedReplacements(abs, versionBumpReplacements);
  console.log(`  plugin/skills/version-bump/SKILL.md: ${n} replacements`);
  totalChanged += n;
}

console.log(`\nTotal replacements applied: ${totalChanged}`);
if (process.exitCode === 1) {
  console.error('\nSome MISSING edits — see above. Fix the strings and re-run.');
} else {
  console.log('All edits applied (or already in place). Re-run for idempotency check.');
}
