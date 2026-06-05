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
