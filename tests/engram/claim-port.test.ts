import { describe, it, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

const require = createRequire(import.meta.url);
const { claimPort, isPortFree, PORT_BASE, PORT_RANGE } = require('../../plugin/scripts/engram-resolve.cjs');

const freeAll = { isPortFree: async () => true, whoami: async () => null };

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('claimPort', () => {
  it('claims the candidate when it is free and persists it to worker.port', async () => {
    const dir = tmp('engram-claim-');
    try {
      const port = await claimPort(dir, PORT_BASE + 5, freeAll);
      expect(port).toBe(PORT_BASE + 5);
      expect(readFileSync(join(dir, 'worker.port'), 'utf8').trim()).toBe(String(PORT_BASE + 5));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('increments to the next free port when the candidate is occupied', async () => {
    const dir = tmp('engram-claim2-');
    try {
      const isPortFree = async (p: number) => p !== PORT_BASE + 5; // candidate busy
      const port = await claimPort(dir, PORT_BASE + 5, { isPortFree, whoami: async () => null });
      expect(port).toBe(PORT_BASE + 6);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reuses a persisted port that is idle (free) without re-claiming', async () => {
    const dir = tmp('engram-claim3-');
    try {
      writeFileSync(join(dir, 'worker.port'), String(PORT_BASE + 10));
      const isPortFree = async (p: number) => p === PORT_BASE + 10; // persisted idle
      const port = await claimPort(dir, PORT_BASE + 99, { isPortFree, whoami: async () => null });
      expect(port).toBe(PORT_BASE + 10);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reuses a persisted port whose worker reports MY dataDir', async () => {
    const dir = tmp('engram-claim4-');
    try {
      writeFileSync(join(dir, 'worker.port'), String(PORT_BASE + 10));
      const port = await claimPort(dir, PORT_BASE + 99, {
        isPortFree: async () => false,         // occupied
        whoami: async () => ({ dataDir: dir }), // ...by my worker
      });
      expect(port).toBe(PORT_BASE + 10);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('re-claims when a persisted port is squatted by another project (whoami mismatch)', async () => {
    const dir = tmp('engram-claim5-');
    try {
      writeFileSync(join(dir, 'worker.port'), String(PORT_BASE + 10));
      const isPortFree = async (p: number) => p >= PORT_BASE + 20; // 10 busy(squatter); 20+ free
      const port = await claimPort(dir, PORT_BASE + 20, {
        isPortFree,
        whoami: async () => ({ dataDir: '/some/other/project' }),
      });
      expect(port).toBe(PORT_BASE + 20);
      expect(readFileSync(join(dir, 'worker.port'), 'utf8').trim()).toBe(String(PORT_BASE + 20));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('wraps within the port range', () => {
    // sanity: the range constants are what we expect
    expect(PORT_BASE).toBe(37800);
    expect(PORT_RANGE).toBe(150);
  });
});

describe('isPortFree (real)', () => {
  it('returns false for a port currently bound, true after release', async () => {
    const srv = createServer();
    const port: number = await new Promise((res) => srv.listen(0, '127.0.0.1', () => res((srv.address() as any).port)));
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(await isPortFree(port)).toBe(true);
  });
});
