#!/usr/bin/env bun
// Engram live demo: real production code (Database + syncOut/syncIn) + real git,
// two "machines" (clones) against a local bare remote. Isolated temp dirs — does
// NOT touch the global claude-mem install. Run: npx bun scripts/engram-live-demo.ts
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ClaudeMemDatabase } from '../src/services/sqlite/Database.js';
import { syncOut, syncIn } from '../src/engram/sync.js';
import { readProjectRows } from '../src/engram/mem-sql.js';
import { memDir, statePath } from '../src/engram/mem-format.js';

const PROJECT = 'engram-live-demo';
const log = (s = '') => process.stdout.write(s + '\n');
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const remote = mkdtempSync(join(tmpdir(), 'engram-remote-'));
const A = mkdtempSync(join(tmpdir(), 'engram-machineA-'));
const B = mkdtempSync(join(tmpdir(), 'engram-machineB-'));
const dbs = mkdtempSync(join(tmpdir(), 'engram-dbs-'));
const dbA = new ClaudeMemDatabase(join(dbs, 'a.db'));
let dbB: ClaudeMemDatabase | undefined;

try {
  // ---- Machine A: a real git project ----
  execFileSync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
  execFileSync('git', ['clone', '-q', remote, A], { windowsHide: true });
  git(['config', 'user.email', 'a@machine'], A); git(['config', 'user.name', 'Machine A'], A);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], A); git(['push', '-q', 'origin', 'HEAD'], A);

  // Simulate a work session that captured memory (rows in the real worker DB).
  dbA.db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES ('sess-1','mem-1',?, 'claude','2026-06-05T10:00:00Z',1717581600,'completed')`).run(PROJECT);
  dbA.db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, files_modified, content_hash, created_at, created_at_epoch)
    VALUES ('mem-1',?, 'decision','Use per-project .mem','Memory lives in the repo and syncs via git, not a global db.','["src/engram/sync.ts"]','live-hash-1','2026-06-05T10:05:00Z',1717581900)`).run(PROJECT);
  dbA.db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, content_hash, created_at, created_at_epoch)
    VALUES ('mem-1',?, 'note','Null-hash idempotency','Importer falls back to a natural key when content_hash is null.','live-hash-2','2026-06-05T10:10:00Z',1717582200)`).run(PROJECT);
  dbA.db.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, learned, completed, next_steps, created_at, created_at_epoch)
    VALUES ('mem-1',?, 'Build Engram','git-native memory works end to end','export/import + smoke test','wire hooks for go-live','2026-06-05T10:15:00Z',1717582500)`).run(PROJECT);

  log('=== MACHINE A — syncOut (export -> commit -> push) ===');
  const out = syncOut(dbA.db, PROJECT, A, { push: true });
  log(`committed=${out.committed}  pushed=${out.pushed}`);
  log('\n  git log (A):\n    ' + git(['log', '--oneline'], A).split('\n').join('\n    '));
  log('\n  .mem/ contents (A): ' + readdirSync(memDir(A)).join(', '));
  log('\n  .mem/observations.ndjson:\n' + readFileSync(join(memDir(A), 'observations.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => '    ' + l).join('\n'));
  log('\n  .mem/decisions/: ' + readdirSync(join(memDir(A), 'decisions')).join(', '));
  log('\n  .mem/state.md:\n' + readFileSync(statePath(A), 'utf8').split('\n').map(l => '    ' + l).join('\n'));

  // ---- Machine B: a different machine pulls the memory ----
  log('\n=== MACHINE B — git clone (pull) + syncIn (import) ===');
  execFileSync('git', ['clone', '-q', remote, B], { windowsHide: true });
  log(`  .mem propagated to B via git: ${existsSync(join(memDir(B), 'observations.ndjson'))}`);
  dbB = new ClaudeMemDatabase(join(dbs, 'b.db'));
  const inn = syncIn(dbB.db, B, { pull: false });
  log(`  rows imported into B's fresh DB: ${inn.imported}`);
  const rows = readProjectRows(dbB.db, PROJECT);
  log(`\n  B's DB now holds ${rows.observations.length} observations + ${rows.summaries.length} summary:`);
  for (const o of rows.observations) log(`    - [${o.type}] "${o.title}"  (content_hash=${o.content_hash})`);
  log(`  B's state.md carries A's summary: ${readFileSync(statePath(B), 'utf8').includes('git-native memory works end to end')}`);

  const again = syncIn(dbB.db, B, { pull: false });
  log(`\n  second syncIn imported: ${again.imported}  (idempotent)`);

  const pass = rows.observations.length === 2
    && rows.observations.some(o => o.content_hash === 'live-hash-1')
    && rows.summaries.length === 1
    && again.imported === 0;
  log(`\n========================================`);
  log(pass ? '  RESULT: PASS — memory propagated A -> git -> B' : '  RESULT: FAIL');
  log('========================================');
  if (!pass) process.exitCode = 1;
} finally {
  dbA.db.close(); dbB?.db?.close?.(); (globalThis as any).Bun?.gc?.(true);
  for (const d of [remote, A, B, dbs]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
