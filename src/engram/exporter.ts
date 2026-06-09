import type { Database } from 'bun:sqlite';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readProjectRows, type ProjectRows } from './mem-sql.js';
import {
  memFile, decisionsDir, statePath, serializeRows, ensureScaffold, readOrCreateManifest,
  type MemTable,
} from './mem-format.js';

/** Observation types that also get a human-readable decisions/<slug>.md. */
const DECISION_TYPES = new Set(['decision']);

function slugify(s: string): string {
  return (s || 'decision').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'decision';
}

function renderState(rows: ProjectRows): string {
  const latest = [...rows.summaries].sort((a, b) => Number(b.created_at_epoch) - Number(a.created_at_epoch))[0];
  if (!latest) return '# Project state\n\n_No summary yet._\n';
  const f = (label: string, v: unknown) => (v ? `## ${label}\n\n${String(v)}\n\n` : '');
  return `# Project state\n\n` +
    f('Request', latest.request) + f('Investigated', latest.investigated) +
    f('Learned', latest.learned) + f('Completed', latest.completed) + f('Next steps', latest.next_steps);
}

function renderDecision(o: Record<string, unknown>): string {
  const files = o.files_modified ? `\n\n**Files:** ${String(o.files_modified)}` : '';
  return `# ${o.title ?? 'Decision'}\n\n${o.narrative ?? o.text ?? ''}${files}\n\n` +
    `_observation: ${o.content_hash ?? ''} · ${o.created_at ?? ''}_\n`;
}

/** Full canonical export of a project's memory to <root>/.mem/. */
export function exportProject(db: Database, project: string, root: string): ProjectRows {
  const rows = readProjectRows(db, project);
  ensureScaffold(root);
  readOrCreateManifest(root, project);

  const tables: MemTable[] = ['sessions', 'observations', 'summaries', 'prompts'];
  const byTable: Record<MemTable, Record<string, unknown>[]> = {
    sessions: rows.sessions, observations: rows.observations, summaries: rows.summaries, prompts: rows.prompts,
  };
  for (const t of tables) writeFileSync(memFile(root, t), serializeRows(byTable[t]));

  writeFileSync(statePath(root), renderState(rows));

  // Decisions: one file per decision-type observation; rebuilt deterministically.
  const dDir = decisionsDir(root);
  if (existsSync(dDir)) for (const f of readdirSync(dDir)) if (f.endsWith('.md')) rmSync(join(dDir, f), { force: true });
  const decisions = rows.observations.filter((o) => DECISION_TYPES.has(String(o.type)));
  if (decisions.length) {
    mkdirSync(dDir, { recursive: true });
    for (const o of decisions) {
      writeFileSync(join(dDir, `${slugify(String(o.title))}-${String(o.content_hash).slice(0, 8)}.md`), renderDecision(o));
    }
  } else if (existsSync(dDir) && readdirSync(dDir).length === 0) {
    rmSync(dDir, { recursive: true, force: true }); // don't leave an empty decisions/ dir tracked
  }
  return rows;
}
