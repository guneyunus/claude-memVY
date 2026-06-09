#!/usr/bin/env bun
// Isolated REAL-WORKER boot test: starts the actual built worker (worker-service.cjs)
// for a per-project repo, and proves the boot-time engramSyncInOnBoot wiring pulls +
// imports .mem into the worker's DB. Fully isolated (temp dirs, free port, Chroma off);
// does NOT touch the global claude-mem install. Run: npx bun scripts/engram-worker-boot-test.ts
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../src/services/sqlite/Database.js';
import { exportProject } from '../src/engram/exporter.js';

const log = (s = '') => process.stdout.write(s + '\n');
const PROJECT = 'engram-worker-boot';
const WORKER_CJS = resolve('plugin/scripts/worker-service.cjs');

function freePort(): Promise<number> {
  return new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(url: string): Promise<{ status: number; body: string }> {
  try { const r = await fetch(url); return { status: r.status, body: await r.text() }; }
  catch { return { status: 0, body: '' }; }
}

const gdir = mkdtempSync(join(tmpdir(), 'ewb-global-'));
const remote = mkdtempSync(join(tmpdir(), 'ewb-remote-'));
const pub = mkdtempSync(join(tmpdir(), 'ewb-pub-'));      // publisher repo
const repoB = mkdtempSync(join(tmpdir(), 'ewb-B-'));      // the worker's repo
const seedDir = mkdtempSync(join(tmpdir(), 'ewb-seed-'));
const seed = new ClaudeMemDatabase(join(seedDir, 'seed.db'));
let child: ReturnType<typeof spawn> | undefined;

async function main() {
  // Publisher: seed memory, export to .mem, commit + push.
  execFileSync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
  execFileSync('git', ['clone', '-q', remote, pub], { windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'p@x'], { cwd: pub, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Pub'], { cwd: pub, windowsHide: true });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: pub, windowsHide: true });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: pub, windowsHide: true });
  seed.db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status) VALUES ('s','m',?, 'claude','t',1,'completed')`).run(PROJECT);
  seed.db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, content_hash, created_at, created_at_epoch) VALUES ('m',?, 'note','boot-import works','the real worker imported this on boot','boot-1','t',2)`).run(PROJECT);
  exportProject(seed.db, PROJECT, pub);
  execFileSync('git', ['add', '.mem'], { cwd: pub, windowsHide: true });
  execFileSync('git', ['commit', '-q', '-m', 'engram: seed'], { cwd: pub, windowsHide: true });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: pub, windowsHide: true });
  seed.db.close(); (globalThis as any).Bun?.gc?.(true);

  // The worker's repo: clone (now has .mem from the remote).
  execFileSync('git', ['clone', '-q', remote, repoB], { windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'b@x'], { cwd: repoB, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'B'], { cwd: repoB, windowsHide: true });
  log(`repoB cloned; .mem present: ${existsSync(join(repoB, '.mem', 'observations.ndjson'))}`);

  const dataDir = join(repoB, '.mem', '.runtime');
  const port = await freePort();
  const env = {
    ...process.env,
    CLAUDE_MEM_DATA_DIR: dataDir,
    CLAUDE_MEM_WORKER_PORT: String(port),
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_CHROMA_ENABLED: 'false',
    ENGRAM_GLOBAL_DIR: gdir,
    CLAUDE_MEM_ENGRAM_SYNC: 'true',
    CLAUDE_MEM_RUNTIME: 'worker',
    CLAUDE_MEM_LOG_LEVEL: 'INFO',
  };
  log(`\nStarting REAL worker: port=${port} dataDir=${dataDir}`);
  child = spawn(process.execPath, [WORKER_CJS, '--daemon'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let childOut = '';
  child.stdout?.on('data', (d) => (childOut += d));
  child.stderr?.on('data', (d) => (childOut += d));

  // Poll readiness.
  let ready = false;
  for (let i = 0; i < 90; i++) {
    const h = await get(`http://127.0.0.1:${port}/api/readiness`);
    if (h.status === 200) { ready = true; break; }
    await sleep(1000);
  }
  log(`worker readiness: ${ready ? 'READY' : 'NOT READY (timeout)'}`);

  // Give boot syncIn a moment.
  await sleep(1500);

  // Proof 1: the worker logged the boot syncIn.
  const logsDir = join(dataDir, 'logs');
  let logText = childOut;
  if (existsSync(logsDir)) for (const f of readdirSync(logsDir)) logText += '\n' + readFileSync(join(logsDir, f), 'utf8');
  const bootLine = logText.split('\n').find((l) => l.includes('engram: syncIn on boot')) || '';
  log(`\nProof 1 — boot syncIn log line: ${bootLine.trim() || '(not found)'}`);

  // Proof 2: the observation is now in the worker's DB.
  let imported = 0, title = '';
  try {
    const rdb = new Database(join(dataDir, 'engram.db'), { readonly: true });
    rdb.run('PRAGMA busy_timeout = 4000');
    const row = rdb.prepare(`SELECT title, content_hash FROM observations WHERE project = ? AND content_hash = 'boot-1'`).get(PROJECT) as any;
    if (row) { imported = 1; title = row.title; }
    rdb.close();
  } catch (e) { log(`(db read error: ${e})`); }
  log(`Proof 2 — observation imported into worker DB: ${imported === 1} ${title ? `("${title}")` : ''}`);

  // Shutdown the worker.
  await get(`http://127.0.0.1:${port}/api/admin/shutdown`).catch(() => {});
  try { await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, { method: 'POST' }); } catch {}
  await sleep(800);
  try { child.kill(); } catch {}

  // syncIn's `imported` counts rows across all tables (here: 1 session + 1 observation = 2).
  const importedCount = Number((bootLine.match(/imported=(\d+)/) || [])[1] ?? 0);
  const pass = ready && importedCount >= 1 && imported === 1;
  log(`\n========================================`);
  log(pass ? '  RESULT: PASS — real worker imported .mem on boot' : '  RESULT: INCONCLUSIVE (see proofs above)');
  log('========================================');
  if (!pass) process.exitCode = 1;
}

main().catch((e) => { log('ERROR: ' + (e?.stack || e)); process.exitCode = 1; }).finally(async () => {
  try { child?.kill(); } catch {}
  await sleep(300);
  (globalThis as any).Bun?.gc?.(true);
  for (const d of [gdir, remote, pub, repoB, seedDir]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 }); } catch {} }
});
