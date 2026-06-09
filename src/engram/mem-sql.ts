import type { Database } from 'bun:sqlite';

type Row = Record<string, unknown>;
export interface ProjectRows {
  sessions: Row[];
  observations: Row[];
  summaries: Row[];
  prompts: Row[];
}

const SESSION_COLS = ['content_session_id', 'memory_session_id', 'project', 'platform_source', 'user_prompt', 'started_at', 'started_at_epoch', 'completed_at', 'completed_at_epoch', 'status', 'custom_title'];
const OBS_COLS = ['memory_session_id', 'project', 'text', 'type', 'title', 'subtitle', 'facts', 'narrative', 'concepts', 'files_read', 'files_modified', 'prompt_number', 'discovery_tokens', 'content_hash', 'agent_type', 'agent_id', 'merged_into_project', 'generated_by_model', 'metadata', 'created_at', 'created_at_epoch'];
const SUMMARY_COLS = ['memory_session_id', 'project', 'request', 'investigated', 'learned', 'completed', 'next_steps', 'files_read', 'files_edited', 'notes', 'prompt_number', 'discovery_tokens', 'merged_into_project', 'created_at', 'created_at_epoch'];
const PROMPT_COLS = ['content_session_id', 'prompt_number', 'prompt_text', 'created_at', 'created_at_epoch'];

/** Columns that actually exist on a table in this DB (drift tolerance, both directions). */
function tableColumns(db: Database, table: string): Set<string> {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(info.map((c) => c.name));
}

/** Canonical columns that exist on this DB's table (so a DB missing e.g. generated_by_model still works). */
function existingCols(db: Database, table: string, canonical: string[]): string[] {
  const have = tableColumns(db, table);
  return canonical.filter((c) => have.has(c));
}

/** Read a project's canonical rows, FK-scoped. Returns raw snake_case rows. */
export function readProjectRows(db: Database, project: string): ProjectRows {
  const sCols = existingCols(db, 'sdk_sessions', SESSION_COLS).join(', ');
  const oCols = existingCols(db, 'observations', OBS_COLS).join(', ');
  const muCols = existingCols(db, 'session_summaries', SUMMARY_COLS).join(', ');
  const pCols = existingCols(db, 'user_prompts', PROMPT_COLS).join(', ');
  const sessions = db.prepare(
    `SELECT ${sCols} FROM sdk_sessions WHERE project = ? ORDER BY started_at_epoch, content_session_id`,
  ).all(project) as Row[];
  const observations = db.prepare(
    `SELECT ${oCols} FROM observations WHERE project = ? ORDER BY created_at_epoch, content_hash`,
  ).all(project) as Row[];
  const summaries = db.prepare(
    `SELECT ${muCols} FROM session_summaries WHERE project = ? ORDER BY created_at_epoch, memory_session_id`,
  ).all(project) as Row[];
  const prompts = db.prepare(
    `SELECT ${pCols} FROM user_prompts
     WHERE content_session_id IN (SELECT content_session_id FROM sdk_sessions WHERE project = ?)
     ORDER BY created_at_epoch, content_session_id, prompt_number`,
  ).all(project) as Row[];
  return { sessions, observations, summaries, prompts };
}

function insertFiltered(db: Database, table: string, row: Row, allow: Set<string>, conflict: string): boolean {
  const keys = Object.keys(row).filter((k) => allow.has(k) && k !== 'id');
  if (keys.length === 0) return false; // nothing to insert (no overlapping columns)
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ${conflict}`;
  const res = db.prepare(sql).run(...keys.map((k) => row[k] as any));
  return res.changes > 0;
}

export interface ImportCounts { sessions: number; observations: number; summaries: number; prompts: number; }

/** Import canonical rows FK-ordered, idempotently. Wrapped in one transaction. */
export function importRows(db: Database, data: ProjectRows): ImportCounts {
  const counts: ImportCounts = { sessions: 0, observations: 0, summaries: 0, prompts: 0 };
  const sessCols = tableColumns(db, 'sdk_sessions');
  const obsCols = tableColumns(db, 'observations');
  const sumCols = tableColumns(db, 'session_summaries');
  const prmCols = tableColumns(db, 'user_prompts');

  // Observations dedup on the real UNIQUE(memory_session_id, content_hash). When
  // content_hash is NULL (e.g. legacy rows written by the old bulk import, which
  // never set it), that UNIQUE can't dedup — NULLs are distinct in SQLite — so we
  // fall back to a natural key. Summaries/prompts have NO unique constraint, so they
  // pre-check a natural key; dedup resolution is created_at_epoch precision
  // (same-epoch duplicates coalesce — acceptable, documented limitation).
  const obsExists = db.prepare("SELECT 1 FROM observations WHERE memory_session_id = ? AND created_at_epoch = ? AND IFNULL(title,'') = IFNULL(?,'') LIMIT 1");
  const summaryExists = db.prepare('SELECT 1 FROM session_summaries WHERE memory_session_id = ? AND created_at_epoch = ? AND IFNULL(prompt_number,-1) = IFNULL(?,-1) LIMIT 1');
  const promptExists = db.prepare('SELECT 1 FROM user_prompts WHERE content_session_id = ? AND prompt_number = ? LIMIT 1');

  const run = db.transaction((d: ProjectRows) => {
    for (const s of d.sessions) {
      if (insertFiltered(db, 'sdk_sessions', s, sessCols, 'ON CONFLICT DO NOTHING')) counts.sessions++;
    }
    for (const o of d.observations) {
      if (o.content_hash == null) {
        if (obsExists.get(o.memory_session_id as any, o.created_at_epoch as any, (o.title ?? null) as any)) continue;
        if (insertFiltered(db, 'observations', o, obsCols, '')) counts.observations++;
      } else if (insertFiltered(db, 'observations', o, obsCols, 'ON CONFLICT(memory_session_id, content_hash) DO NOTHING')) {
        counts.observations++;
      }
    }
    for (const su of d.summaries) {
      if (summaryExists.get(su.memory_session_id as any, su.created_at_epoch as any, (su.prompt_number ?? null) as any)) continue;
      if (insertFiltered(db, 'session_summaries', su, sumCols, '')) counts.summaries++;
    }
    for (const p of d.prompts) {
      if (promptExists.get(p.content_session_id as any, p.prompt_number as any)) continue;
      if (insertFiltered(db, 'user_prompts', p, prmCols, '')) counts.prompts++;
    }
  });
  run(data);
  return counts;
}
