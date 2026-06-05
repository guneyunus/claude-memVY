import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  memDir, memFile, serializeRow, parseLine, ensureScaffold, readOrCreateManifest, MEM_FILES,
} from '../../src/engram/mem-format.js';

describe('mem-format serialization', () => {
  it('serializeRow sorts keys and is newline-free, stable, roundtrips via parseLine', () => {
    const row = { b: 2, a: 'x', c: null };
    const line = serializeRow(row);
    expect(line).toBe('{"a":"x","b":2,"c":null}'); // keys sorted
    expect(line.includes('\n')).toBe(false);
    expect(parseLine(line)).toEqual({ a: 'x', b: 2, c: null });
  });

  it('serializeRow is byte-identical regardless of input key order', () => {
    expect(serializeRow({ a: 1, b: 2 })).toBe(serializeRow({ b: 2, a: 1 }));
  });
});

describe('mem-format layout', () => {
  it('memDir/memFile compute the .mem paths', () => {
    const root = join('/repo', 'x');
    expect(memDir(root)).toBe(join(root, '.mem'));
    expect(memFile(root, 'observations')).toBe(join(root, '.mem', MEM_FILES.observations));
  });

  it('ensureScaffold writes .gitignore + .gitattributes and creates the dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'engram-scaffold-'));
    try {
      ensureScaffold(root);
      expect(existsSync(memDir(root))).toBe(true);
      expect(readFileSync(join(memDir(root), '.gitignore'), 'utf8')).toContain('.runtime/');
      expect(readFileSync(join(memDir(root), '.gitattributes'), 'utf8')).toContain('*.ndjson merge=union');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('readOrCreateManifest creates a stable UUID once and reuses it', () => {
    const root = mkdtempSync(join(tmpdir(), 'engram-manifest-'));
    try {
      const m1 = readOrCreateManifest(root, 'my-project');
      expect(m1.engramProjectId).toMatch(/^[0-9a-f-]{36}$/);
      expect(m1.project).toBe('my-project');
      expect(typeof m1.schemaVersion).toBe('number');
      const m2 = readOrCreateManifest(root, 'my-project');
      expect(m2.engramProjectId).toBe(m1.engramProjectId); // stable across calls
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
