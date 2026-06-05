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
