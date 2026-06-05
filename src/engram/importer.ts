import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { importRows, type ProjectRows, type ImportCounts } from './mem-sql.js';
import { memFile, parseNdjson, type MemTable } from './mem-format.js';

function load(root: string, table: MemTable): Record<string, unknown>[] {
  const p = memFile(root, table);
  return existsSync(p) ? parseNdjson(readFileSync(p, 'utf8')) : [];
}

/** Import a project's <root>/.mem/ ndjson into the DB, idempotently. */
export function importProject(db: Database, root: string): ImportCounts {
  const data: ProjectRows = {
    sessions: load(root, 'sessions'),
    observations: load(root, 'observations'),
    summaries: load(root, 'summaries'),
    prompts: load(root, 'prompts'),
  };
  return importRows(db, data);
}
