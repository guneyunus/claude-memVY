import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const PROBE = join(REPO, 'tests', 'engram', 'fixtures', 'probe-whoami.ts');

describe('whoamiInfo', () => {
  it('reports the per-project dataDir + dbPath and a numeric port', () => {
    const proj = resolve(mkdtempSync(join(tmpdir(), 'engram-who-')));
    const glob = resolve(mkdtempSync(join(tmpdir(), 'engram-whoglob-')));
    try {
      // Pre-seed global settings so SettingsDefaultsManager doesn't log to stdout.
      writeFileSync(join(glob, 'settings.json'), JSON.stringify({}));
      const env: Record<string, string | undefined> = {
        ...process.env, CLAUDE_MEM_DATA_DIR: proj, ENGRAM_GLOBAL_DIR: glob,
      };
      delete env.CLAUDE_MEM_WORKER_PORT;
      const res = spawnSync('npx', ['bun', PROBE], { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 30000, env });
      if (res.status !== 0 || !res.stdout.trim()) {
        throw new Error(`probe failed: status=${res.status} stderr=${res.stderr}`);
      }
      const out = JSON.parse(res.stdout.trim());
      expect(out.dataDir).toBe(proj);
      expect(out.dbPath).toBe(join(proj, 'engram.db'));
      expect(typeof out.port).toBe('number');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });
});
