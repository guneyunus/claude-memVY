import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveProjectRuntime, PORT_BASE, PORT_RANGE } from '../../src/engram/project-root.js';

const REPO = process.cwd();
const BUN_RUNNER = join(REPO, 'plugin', 'scripts', 'bun-runner.js');
const STUB = join(REPO, 'tests', 'engram', 'fixtures', 'stub-worker.cjs');

describe('bun-runner per-project injection (isolated)', () => {
  it('injects DATA_DIR + PORT from the hook cwd into the spawned child', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'engram-inject-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
      const expected = resolveProjectRuntime(repo);

      // Run the REAL launcher pointed at the stub "worker", with cwd = the temp
      // repo. bun-runner spawns `bun stub-worker.cjs hook claude-code context`
      // with env: process.env, so the stub prints the injected values.
      // Non-empty stdin avoids bun-runner's empty-payload diagnostic branch.
      const res = spawnSync('node', [BUN_RUNNER, STUB, 'hook', 'claude-code', 'context'], {
        cwd: repo,
        input: '{}',
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      });

      if (res.status !== 0 || !res.stdout.trim()) {
        throw new Error(
          `bun-runner did not run the stub cleanly (status=${res.status}). ` +
          `stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}. ` +
          `If stderr mentions "Bun not found", install bun on PATH for this test.`,
        );
      }

      const printed = JSON.parse(res.stdout.trim());
      expect(printed.dataDir).toBe(expected.dataDir);
      // Port is CLAIMED now: in range, and >= the candidate (claimPort probes
      // from the candidate upward). The chosen port is persisted to worker.port.
      const claimed = Number(printed.port);
      expect(claimed).toBeGreaterThanOrEqual(PORT_BASE);
      expect(claimed).toBeLessThan(PORT_BASE + PORT_RANGE);
      expect(existsSync(join(expected.dataDir, 'worker.port'))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT override explicit CLAUDE_MEM_DATA_DIR / CLAUDE_MEM_WORKER_PORT already in the env', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'engram-inject2-')));
    const overrideDir = resolve(repo, 'custom-data');
    const overridePort = '39123';
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
      const res = spawnSync('node', [BUN_RUNNER, STUB, 'hook', 'claude-code', 'context'], {
        cwd: repo,
        input: '{}',
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: overrideDir, CLAUDE_MEM_WORKER_PORT: overridePort },
      });
      if (res.status !== 0 || !res.stdout.trim()) {
        throw new Error(`stub did not run cleanly: status=${res.status} stderr=${res.stderr}`);
      }
      const printed = JSON.parse(res.stdout.trim());
      expect(printed.dataDir).toBe(overrideDir); // explicit env wins (fail-open guard)
      expect(printed.port).toBe(overridePort);   // explicit port preserved too
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
