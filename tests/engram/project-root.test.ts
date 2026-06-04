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
