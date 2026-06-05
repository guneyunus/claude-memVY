import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const MEM_SCHEMA_VERSION = 1;

/** Logical table name → committed ndjson filename. */
export const MEM_FILES = {
  sessions: 'sessions.ndjson',
  observations: 'observations.ndjson',
  summaries: 'summaries.ndjson',
  prompts: 'prompts.ndjson',
} as const;
export type MemTable = keyof typeof MEM_FILES;

export function memDir(root: string): string {
  return join(root, '.mem');
}
export function memFile(root: string, table: MemTable): string {
  return join(memDir(root), MEM_FILES[table]);
}
export function decisionsDir(root: string): string {
  return join(memDir(root), 'decisions');
}
export function statePath(root: string): string {
  return join(memDir(root), 'state.md');
}
export function manifestPath(root: string): string {
  return join(memDir(root), 'manifest.json');
}

/** Canonical one-line JSON: keys sorted, no whitespace, LF-free. */
export function serializeRow(row: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) sorted[k] = row[k] === undefined ? null : row[k];
  return JSON.stringify(sorted);
}

export function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line);
}

/** Serialize rows to a canonical ndjson body (sorted by created_at_epoch, then a stable tiebreaker). */
export function serializeRows(rows: Record<string, unknown>[]): string {
  const lines = rows.map(serializeRow).sort();
  return lines.length ? lines.join('\n') + '\n' : '';
}

export function parseNdjson(text: string): Record<string, unknown>[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map(parseLine);
}

export interface MemManifest {
  engramProjectId: string;
  project: string;
  schemaVersion: number;
  createdAt: string;
}

/** Read .mem/manifest.json, creating it (stable UUID) on first call. */
export function readOrCreateManifest(root: string, project: string): MemManifest {
  const p = manifestPath(root);
  if (existsSync(p)) {
    try {
      const m = JSON.parse(readFileSync(p, 'utf8')) as MemManifest;
      if (m.engramProjectId) return m;
    } catch { /* fall through and recreate */ }
  }
  mkdirSync(memDir(root), { recursive: true });
  const manifest: MemManifest = {
    engramProjectId: randomUUID(),
    project,
    schemaVersion: MEM_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Create .mem/ + .gitignore (.runtime/) + .gitattributes (union-merge ndjson). Idempotent. */
export function ensureScaffold(root: string): void {
  const dir = memDir(root);
  mkdirSync(dir, { recursive: true });
  const gitignore = join(dir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '.runtime/\n');
  const gitattributes = join(dir, '.gitattributes');
  if (!existsSync(gitattributes)) writeFileSync(gitattributes, '*.ndjson merge=union\n');
}
