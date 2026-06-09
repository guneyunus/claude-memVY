import { describe, it, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveProjectRuntime, projectWorkerPort } from '../../src/engram/project-root.js';

const require = createRequire(import.meta.url);
const resolveMod = require('../../plugin/scripts/engram-resolve.cjs');

describe('engram-resolve.cjs', () => {
  it('exports resolveRuntimeEnv', () => {
    expect(typeof resolveMod.resolveRuntimeEnv).toBe('function');
  });

  it('matches the TS resolver (parity) for a temp git repo', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engram-cjs-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      const sub = join(dir, 'a', 'b');
      mkdirSync(sub, { recursive: true });
      const ts = resolveProjectRuntime(sub);
      const cjs = resolveMod.resolveRuntimeEnv(sub);
      expect(cjs.root).toBe(ts.root);
      expect(cjs.dataDir).toBe(ts.dataDir);
      expect(cjs.port).toBe(ts.port);
      expect(cjs.slug).toBe(ts.slug);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('port is in range and matches projectWorkerPort', () => {
    const dir = resolve('/tmp/acme/widget');
    expect(resolveMod.resolveRuntimeEnv(dir).port).toBe(projectWorkerPort(dir));
  });

  it('PORT_BASE/PORT_RANGE constants match the TS module', () => {
    expect(resolveMod.PORT_BASE).toBe(37800);
    expect(resolveMod.PORT_RANGE).toBe(150);
  });
});
