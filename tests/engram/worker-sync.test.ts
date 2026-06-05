import { describe, it, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  engramProjectRoot, engramSyncEnabled, engramSyncInOnBoot, engramSyncOutAfterStop,
} from '../../src/engram/worker-sync.js';
import { readProjectRows } from '../../src/engram/mem-sql.js';
import { memFile } from '../../src/engram/mem-format.js';

const PROJECT = 'ws-proj';
const perProject = (root: string) => join(root, '.mem', '.runtime');

describe('worker-sync helpers', () => {
  it('engramProjectRoot: root for a per-project data dir, null in global mode', () => {
    const root = resolve('/repo/widget');
    expect(engramProjectRoot(perProject(root))).toBe(root);
    expect(engramProjectRoot(join(homedir(), '.engram'))).toBeNull();
  });

  it('engramSyncEnabled: on for per-project unless killed; off in global mode', () => {
    const prev = process.env.CLAUDE_MEM_ENGRAM_SYNC;
    try {
      delete process.env.CLAUDE_MEM_ENGRAM_SYNC;
      expect(engramSyncEnabled(perProject(resolve('/r/x')))).toBe(true);
      expect(engramSyncEnabled(join(homedir(), '.engram'))).toBe(false);
      process.env.CLAUDE_MEM_ENGRAM_SYNC = 'false';
      expect(engramSyncEnabled(perProject(resolve('/r/x')))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_MEM_ENGRAM_SYNC;
      else process.env.CLAUDE_MEM_ENGRAM_SYNC = prev;
    }
  });

  it('the worker wiring (boot syncIn + stop syncOut) propagates memory via real git', () => {
    const remote = mkdtempSync(join(tmpdir(), 'ws-remote-'));
    const A = mkdtempSync(join(tmpdir(), 'ws-A-'));
    const B = mkdtempSync(join(tmpdir(), 'ws-B-'));
    const dbs = mkdtempSync(join(tmpdir(), 'ws-dbs-'));
    const dbA = new ClaudeMemDatabase(join(dbs, 'a.db'));
    let dbB: ClaudeMemDatabase | undefined;
    try {
      execFileSync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
      execFileSync('git', ['clone', '-q', remote, A], { windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'a@x'], { cwd: A, windowsHide: true });
      execFileSync('git', ['config', 'user.name', 'A'], { cwd: A, windowsHide: true });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: A, windowsHide: true });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: A, windowsHide: true });

      // Worker A boots (per-project DATA_DIR = A/.mem/.runtime): pull+import (empty).
      engramSyncInOnBoot(dbA.db, perProject(A));

      // A captures memory.
      dbA.db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
        VALUES ('s1','m1',?, 'claude','t',1,'completed')`).run(PROJECT);
      dbA.db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, content_hash, created_at, created_at_epoch)
        VALUES ('m1',?, 'note','wired observation','captured then synced via the worker wiring','wh-1','t',2)`).run(PROJECT);

      // Stop on A: export -> commit -> push.
      engramSyncOutAfterStop(dbA.db, perProject(A), PROJECT);
      expect(existsSync(memFile(A, 'observations'))).toBe(true);

      // Worker B boots after a clone: pull+import → memory lands in B.
      execFileSync('git', ['clone', '-q', remote, B], { windowsHide: true });
      dbB = new ClaudeMemDatabase(join(dbs, 'b.db'));
      engramSyncInOnBoot(dbB.db, perProject(B));
      const rows = readProjectRows(dbB.db, PROJECT);
      expect(rows.observations.length).toBe(1);
      expect(rows.observations[0].content_hash).toBe('wh-1');
      expect(rows.observations[0].title).toBe('wired observation');
    } finally {
      dbA.db.close(); dbB?.db?.close?.(); (globalThis as any).Bun?.gc?.(true);
      for (const d of [remote, A, B, dbs]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
