import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { syncOut, syncIn } from '../../src/engram/sync.js';
import { readProjectRows } from '../../src/engram/mem-sql.js';
import { memFile, statePath, decisionsDir } from '../../src/engram/mem-format.js';

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

describe('two-machine smoke test (the success criterion)', () => {
  it('machine A push → machine B pull → memory is present in B', () => {
    const remote = mkdtempSync(join(tmpdir(), 'engram-remote-'));
    const repoA = mkdtempSync(join(tmpdir(), 'engram-A-'));
    const repoB = mkdtempSync(join(tmpdir(), 'engram-B-'));
    const dbDir = mkdtempSync(join(tmpdir(), 'engram-dbs-'));
    const dbA = new ClaudeMemDatabase(join(dbDir, 'a.db'));
    const dbB = new ClaudeMemDatabase(join(dbDir, 'b.db'));
    try {
      // Bare remote + clone A; configure user; establish a main branch.
      execFileSync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
      execFileSync('git', ['clone', '-q', remote, repoA], { windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'a@engram.local'], { cwd: repoA, windowsHide: true });
      execFileSync('git', ['config', 'user.name', 'Machine A'], { cwd: repoA, windowsHide: true });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repoA, windowsHide: true });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: repoA, windowsHide: true });

      // === Machine A: work, then sync out (push) ===
      seed(dbA.db);
      const out = syncOut(dbA.db, PROJECT, repoA, { push: true });
      expect(out.committed).toBe(true);
      expect(out.pushed).toBe(true);

      // === Machine B: clone fresh, then sync in (no pull needed — clone has it) ===
      execFileSync('git', ['clone', '-q', remote, repoB], { windowsHide: true });
      expect(existsSync(memFile(repoB, 'observations'))).toBe(true); // propagated via git
      const inRes = syncIn(dbB.db, repoB, { pull: false });
      expect(inRes.imported).toBeGreaterThanOrEqual(3); // session + observation + summary

      // === Assert: the memory is present in B's DB and files ===
      const bRows = readProjectRows(dbB.db, PROJECT);
      expect(bRows.observations.length).toBe(1);
      expect(bRows.observations[0].title).toBe('Approach B');
      expect(bRows.observations[0].content_hash).toBe('h-1'); // verbatim across machines
      expect(bRows.summaries[0].learned).toBe('injection works');
      // state.md + decisions/ propagated
      expect(readFileSync(statePath(repoB), 'utf8')).toContain('injection works');
      expect(readdirSync(decisionsDir(repoB)).some((f) => f.endsWith('.md'))).toBe(true);

      // === Idempotent: a second syncIn on B imports nothing new ===
      expect(syncIn(dbB.db, repoB, { pull: true }).imported).toBe(0);
    } finally {
      dbA.db.close(); dbB.db.close(); (globalThis as any).Bun?.gc?.(true);
      for (const d of [remote, repoA, repoB, dbDir]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
