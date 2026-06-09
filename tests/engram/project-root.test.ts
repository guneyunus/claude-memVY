import { describe, it, expect } from 'bun:test';
import { resolve, join } from 'node:path';
import {
  projectDataDir,
  projectWorkerPort,
  projectSlug,
  PORT_BASE,
  PORT_RANGE,
} from '../../src/engram/project-root.js';

describe('project-root pure helpers', () => {
  it('projectDataDir is <root>/.mem/.runtime', () => {
    const root = resolve('/tmp/acme/widget');
    expect(projectDataDir(root)).toBe(join(root, '.mem', '.runtime'));
  });

  it('projectSlug is the basename of the root', () => {
    expect(projectSlug(resolve('/tmp/acme/widget'))).toBe('widget');
  });

  it('projectWorkerPort is deterministic and inside [PORT_BASE, PORT_BASE+PORT_RANGE)', () => {
    const root = resolve('/tmp/acme/widget');
    const a = projectWorkerPort(root);
    const b = projectWorkerPort(root);
    expect(a).toBe(b); // deterministic
    expect(a).toBeGreaterThanOrEqual(PORT_BASE);
    expect(a).toBeLessThan(PORT_BASE + PORT_RANGE);
  });

  it('projectWorkerPort differs for different roots (no trivial collision)', () => {
    const p1 = projectWorkerPort(resolve('/tmp/acme/widget'));
    const p2 = projectWorkerPort(resolve('/tmp/acme/gadget'));
    expect(p1).not.toBe(p2);
  });

  it('PORT range is disjoint from the upstream default 37700-37799', () => {
    expect(PORT_BASE).toBeGreaterThanOrEqual(37800);
    expect(PORT_BASE + PORT_RANGE).toBeLessThanOrEqual(37950);
  });
});

import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  resolveProjectRoot,
  resolveProjectRuntime,
} from '../../src/engram/project-root.js';

describe('resolveProjectRoot (git)', () => {
  it('returns the git toplevel from the repo root and from a subdir', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engram-git-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      const sub = join(dir, 'src', 'deep');
      mkdirSync(sub, { recursive: true });
      expect(resolveProjectRoot(dir)).toBe(resolve(dir));
      expect(resolveProjectRoot(sub)).toBe(resolve(dir)); // finds toplevel from deep
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the resolved cwd when git cannot resolve the path', () => {
    // A path that does not exist on disk: `git rev-parse` throws (bad cwd),
    // the resolver catches it and returns resolve(cwd). Deterministic
    // regardless of whether tmpdir happens to sit inside a git repo.
    const ghost = join(tmpdir(), 'engram-nogit-does-not-exist-zzz');
    expect(resolveProjectRoot(ghost)).toBe(resolve(ghost));
  });

  it('falls back for an existing dir that is not a git repo (git exit 128)', () => {
    // The realistic case: an existing directory with no repo above it. git
    // rev-parse exits 128 → execFileSync throws → fallback. GIT_CEILING_DIRECTORIES
    // stops git from discovering an ancestor repo, so this is deterministic even
    // if tmpdir sits inside one.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engram-bare-')));
    const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
    try {
      expect(resolveProjectRoot(dir)).toBe(resolve(dir));
    } finally {
      if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveProjectRuntime', () => {
  it('composes root, dataDir, port, slug', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engram-rt-')));
    try {
      const rt = resolveProjectRuntime(dir);
      expect(rt.root).toBe(resolve(dir));
      expect(rt.dataDir).toBe(join(resolve(dir), '.mem', '.runtime'));
      expect(rt.port).toBe(projectWorkerPort(resolve(dir)));
      expect(rt.slug).toBe(projectSlug(resolve(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
