import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isGitRepo, hasRemote, gitCommitPaths } from '../../src/engram/git-sync.js';

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@engram.local'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Engram Test'], { cwd: dir, windowsHide: true });
}

describe('git-sync wrapper', () => {
  it('isGitRepo is false for a plain dir, true after git init', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-git-'));
    try {
      expect(isGitRepo(dir)).toBe(false);
      initRepo(dir);
      expect(isGitRepo(dir)).toBe(true);
      expect(hasRemote(dir)).toBe(false); // no remote configured
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('gitCommitPaths commits new files and reports nothing-to-commit on a clean tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-commit-'));
    try {
      initRepo(dir);
      writeFileSync(join(dir, 'a.txt'), 'hello\n');
      const c1 = gitCommitPaths(dir, ['a.txt'], 'add a');
      expect(c1.ok).toBe(true);
      expect(c1.committed).toBe(true);
      const c2 = gitCommitPaths(dir, ['a.txt'], 'noop'); // nothing changed
      expect(c2.ok).toBe(true);
      expect(c2.committed).toBe(false); // nothing to commit
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never throws on a non-repo (returns ok:false)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-norepo-'));
    try {
      const c = gitCommitPaths(dir, ['x'], 'm'); // not a git repo
      expect(c.ok).toBe(false); // resilient: returns, does not throw
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
