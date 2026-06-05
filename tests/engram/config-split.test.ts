import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const PROBE_PATHS = join(REPO, 'tests', 'engram', 'fixtures', 'probe-paths.ts');

function runProbe(probe: string, overrides: Record<string, string>): any {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  delete env.CLAUDE_MEM_WORKER_PORT; // never let the runner's env override the file under test
  const res = spawnSync('npx', ['bun', probe], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 30000, env,
  });
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(`probe failed: status=${res.status} stdout=${JSON.stringify(res.stdout)} stderr=${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

describe('config split — path redirection', () => {
  it('settings + .env resolve GLOBAL; db + chroma resolve PER-PROJECT', () => {
    const proj = resolve(mkdtempSync(join(tmpdir(), 'engram-proj-')));
    const glob = resolve(mkdtempSync(join(tmpdir(), 'engram-glob-')));
    try {
      const out = runProbe(PROBE_PATHS, { CLAUDE_MEM_DATA_DIR: proj, ENGRAM_GLOBAL_DIR: glob });
      expect(out.settingsConst).toBe(join(glob, 'settings.json'));
      expect(out.settingsFn).toBe(join(glob, 'settings.json'));
      expect(out.envFile).toBe(join(glob, '.env'));
      expect(out.db).toBe(join(proj, 'engram.db'));
      expect(out.chroma).toBe(join(proj, 'chroma'));
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('no-divergence: when DATA_DIR equals the global dir, settings and state coincide', () => {
    const dir = resolve(mkdtempSync(join(tmpdir(), 'engram-same-')));
    try {
      const out = runProbe(PROBE_PATHS, { CLAUDE_MEM_DATA_DIR: dir, ENGRAM_GLOBAL_DIR: dir });
      expect(out.settingsConst).toBe(join(dir, 'settings.json'));
      expect(out.db).toBe(join(dir, 'engram.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const PROBE_PORT = join(REPO, 'tests', 'engram', 'fixtures', 'probe-port.ts');

describe('config split — worker port source', () => {
  it('getWorkerPort reads the GLOBAL settings.json and does not create a per-project one', () => {
    const proj = resolve(mkdtempSync(join(tmpdir(), 'engram-proj2-')));
    const glob = resolve(mkdtempSync(join(tmpdir(), 'engram-glob2-')));
    try {
      // Distinctive port in the GLOBAL settings; per-project dir has no settings.
      writeFileSync(join(glob, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '38500' }));
      const out = runProbe(PROBE_PORT, { CLAUDE_MEM_DATA_DIR: proj, ENGRAM_GLOBAL_DIR: glob });
      expect(out.workerPort).toBe(38500);                // came from GLOBAL settings.json
      expect(out.perProjectSettingsCreated).toBe(false); // per-project dir untouched
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });
});
