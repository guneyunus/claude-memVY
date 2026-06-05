import type { Database } from 'bun:sqlite';
import { resolve, basename, dirname } from 'node:path';
import { syncIn, syncOut } from './sync.js';

/**
 * The project root if `dataDir` is a per-project `<root>/.mem/.runtime` (set by
 * bun-runner's launcher injection). Returns null in global mode (`~/.engram`),
 * where there is no single project to sync.
 */
export function engramProjectRoot(dataDir: string): string | null {
  const d = resolve(dataDir);
  if (basename(d) === '.runtime' && basename(dirname(d)) === '.mem') {
    return dirname(dirname(d));
  }
  return null;
}

/** Sync is on when we're a per-project worker and the kill-switch isn't set. */
export function engramSyncEnabled(dataDir: string): boolean {
  return engramProjectRoot(dataDir) !== null && process.env.CLAUDE_MEM_ENGRAM_SYNC !== 'false';
}

/**
 * Worker-boot sync-in (git pull + import `.mem` into the project DB). Once per
 * boot — and the per-project worker boots when SessionStart fires. Best-effort:
 * never throws, so a sync failure never aborts worker init.
 */
export function engramSyncInOnBoot(db: Database, dataDir: string, log?: (m: string) => void): void {
  try {
    const root = engramProjectRoot(dataDir);
    if (!root || process.env.CLAUDE_MEM_ENGRAM_SYNC === 'false') return;
    const r = syncIn(db, root, { pull: true });
    log?.(`syncIn on boot: pulled=${r.pulled} imported=${r.imported} root=${root}`);
  } catch (e) {
    log?.(`syncIn on boot failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Stop-time sync-out (export project memory to `.mem` + commit + push). Eventual:
 * exports the current DB state (the just-finished turn's summary may still be
 * generating and propagate on the next Stop). Best-effort: never throws, so it
 * never 500s the Stop hook.
 */
export function engramSyncOutAfterStop(
  db: Database,
  dataDir: string,
  project: string | undefined,
  log?: (m: string) => void,
): void {
  try {
    const root = engramProjectRoot(dataDir);
    if (!root || !project || process.env.CLAUDE_MEM_ENGRAM_SYNC === 'false') return;
    const r = syncOut(db, project, root, { push: true });
    log?.(`syncOut after stop: committed=${r.committed} pushed=${r.pushed} project=${project}`);
  } catch (e) {
    log?.(`syncOut after stop failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}
