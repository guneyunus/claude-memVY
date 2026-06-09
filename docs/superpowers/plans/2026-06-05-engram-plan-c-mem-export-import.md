# Engram Plan C — Diffable `.mem/` Export / Import (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps. Follow superpowers:test-driven-development per task.

**Goal:** Make a project's memory diffable and git-syncable: export the 4 SQLite memory tables for a project to canonical `.mem/*.ndjson` (+ `decisions/`, `state.md`, `manifest.json`), and import those back into a (possibly different-machine) SQLite DB idempotently. This is the text source-of-truth that Plan D will `git pull`/`commit`.

**Architecture:** Pure-ish TypeScript modules under `src/engram/` operating on a `bun:sqlite` `Database` handle (the worker's DB) — no coupling to the churny store internals. Export reads a fixed canonical column set per table (FK-scoped to the project), writes one sorted-canonical JSON line per row. Import reads the ndjson and inserts FK-ordered with real dedup (`ON CONFLICT(memory_session_id, content_hash)` for observations; bare `ON CONFLICT DO NOTHING` for sessions; JS natural-key pre-check for summaries/prompts), filtering to the target DB's actual columns for drift-tolerance. Full canonical re-export each run (sorted, deterministic) gives clean diffs without watermark state.

**Tech Stack:** TypeScript, `bun:sqlite` (`ClaudeMemDatabase` opens+migrates a temp DB for tests), Bun test, Node `crypto` (UUID), `fs`. Read AND import are drift-tolerant (intersect canonical columns with `PRAGMA table_info`), so a DB missing `generated_by_model`/`relevance_count` works either way.

**Reference:** spec §4.2/§4.3/§6; carry-forward (Plan C section). Schema/insert facts verified — see "Schema facts" below.

## Schema facts (verified, drive the SQL)

- **FK order:** `sdk_sessions` first; then `observations`/`session_summaries` (FK → `sdk_sessions.memory_session_id` ON DELETE/UPDATE CASCADE) and `user_prompts` (FK → `sdk_sessions.content_session_id` ON DELETE CASCADE). Parent `memory_session_id` must be non-NULL before children insert.
- **Dedup keys:** observations `UNIQUE(memory_session_id, content_hash)`; sessions `content_session_id` + `memory_session_id` both UNIQUE; `session_summaries` and `user_prompts` have **NO** unique constraint.
- **`content_hash`** is exported/imported VERBATIM (never recomputed — old rows were backfilled with random hashes).
- **`relevance_count`** exists only on the live `SessionStore` DB, is dormant (never read/written) → excluded from the canonical set.
- Layer returns **raw snake_case rows**; JSON columns (`facts`, `concepts`, `files_*`, `metadata`) are stored as TEXT (JSON strings) — exported verbatim as strings.
- No `engramProjectId` exists; `project` is a basename string. `.mem/manifest.json` adds a stable UUID for identity/metadata (rows still key on `project`).

## Canonical column sets (export SELECT order = serialized key set)

```
sessions:    content_session_id, memory_session_id, project, platform_source, user_prompt,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status, custom_title
observations:memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
             files_read, files_modified, prompt_number, discovery_tokens, content_hash,
             agent_type, agent_id, merged_into_project, generated_by_model, metadata,
             created_at, created_at_epoch
summaries:   memory_session_id, project, request, investigated, learned, completed, next_steps,
             files_read, files_edited, notes, prompt_number, discovery_tokens, merged_into_project,
             created_at, created_at_epoch
prompts:     content_session_id, prompt_number, prompt_text, created_at, created_at_epoch
```

(`id` is excluded — autoincrement, machine-local. `relevance_count`, `worker_port`, `prompt_counter` excluded — runtime/dormant.)

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/engram/mem-format.ts` | `.mem/` layout paths, canonical line serialize/parse, manifest (engramProjectId), state.md + decisions rendering, `.gitignore`/`.gitattributes` scaffolding | Create |
| `src/engram/mem-sql.ts` | `readProjectRows(db, project)` (SELECT canonical, FK-scoped) + `importRows(db, data)` (FK-ordered, drift-tolerant, dedup) | Create |
| `src/engram/exporter.ts` | `exportProject(db, project, root)` — orchestrate read → write all `.mem/` artifacts | Create |
| `src/engram/importer.ts` | `importProject(db, root)` — read `.mem/` ndjson → `importRows` | Create |
| `tests/engram/mem-format.test.ts` | serialize/parse stability, manifest, paths | Create |
| `tests/engram/mem-roundtrip.test.ts` | DB-A → `.mem/` → DB-B equality + idempotency (temp `ClaudeMemDatabase` DBs) | Create |

---

## Task 1: `mem-format.ts` — layout, canonical serialization, manifest

**Files:**
- Create: `src/engram/mem-format.ts`
- Test: `tests/engram/mem-format.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/engram/mem-format.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx bun test tests/engram/mem-format.test.ts`
Expected: FAIL — `src/engram/mem-format.ts` does not exist.

- [ ] **Step 3: Implement `mem-format.ts`**

Create `src/engram/mem-format.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx bun test tests/engram/mem-format.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engram/mem-format.ts tests/engram/mem-format.test.ts
git commit -m "feat(engram): add .mem format — canonical serialization, layout, manifest"
```

---

## Task 2: `mem-sql.ts` — read + idempotent import against a `bun:sqlite` DB

**Files:**
- Create: `src/engram/mem-sql.ts`
- Test: `tests/engram/mem-roundtrip.test.ts`

- [ ] **Step 1: Write the failing roundtrip test**

Create `tests/engram/mem-roundtrip.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { readProjectRows, importRows } from '../../src/engram/mem-sql.js';

const PROJECT = 'demo-proj';

function seed(db: any): void {
  // A session with memory_session_id, then a child observation/summary/prompt.
  db.prepare(`INSERT INTO sdk_sessions
    (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, 'claude', ?, ?, 'completed')`).run('cs-1', 'ms-1', PROJECT, '2026-06-05T00:00:00Z', 1000);
  db.prepare(`INSERT INTO observations
    (memory_session_id, project, type, title, narrative, content_hash, created_at, created_at_epoch)
    VALUES (?, ?, 'decision', 'Chose Approach B', 'Per-project runtime is safer.', ?, ?, ?)`)
    .run('ms-1', PROJECT, 'hash-abc', '2026-06-05T00:01:00Z', 1060);
  db.prepare(`INSERT INTO session_summaries
    (memory_session_id, project, request, learned, completed, created_at, created_at_epoch)
    VALUES (?, ?, 'Build runtime', 'env injection works', 'B2 done', ?, ?)`)
    .run('ms-1', PROJECT, '2026-06-05T00:02:00Z', 1120);
  db.prepare(`INSERT INTO user_prompts
    (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, 1, 'do the thing', ?, ?)`).run('cs-1', '2026-06-05T00:00:30Z', 1030);
}

describe('mem-sql roundtrip', () => {
  it('exports a project and re-imports it into a fresh DB with matching rows; idempotent', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'engram-dbA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'engram-dbB-'));
    const a = new ClaudeMemDatabase(join(dirA, 'a.db'));
    const b = new ClaudeMemDatabase(join(dirB, 'b.db'));
    try {
      seed(a.db);
      const data = readProjectRows(a.db, PROJECT);
      expect(data.sessions.length).toBe(1);
      expect(data.observations.length).toBe(1);
      expect(data.summaries.length).toBe(1);
      expect(data.prompts.length).toBe(1);
      expect(data.observations[0].content_hash).toBe('hash-abc'); // verbatim

      const first = importRows(b.db, data);
      expect(first.sessions + first.observations + first.summaries + first.prompts).toBe(4);

      // Imported rows match the source (canonical column set).
      const bRows = readProjectRows(b.db, PROJECT);
      expect(bRows.observations[0].title).toBe('Chose Approach B');
      expect(bRows.observations[0].content_hash).toBe('hash-abc');
      expect(bRows.summaries[0].learned).toBe('env injection works');
      expect(bRows.prompts[0].prompt_text).toBe('do the thing');

      // Idempotent: a second import inserts nothing new.
      const second = importRows(b.db, data);
      expect(second.sessions + second.observations + second.summaries + second.prompts).toBe(0);
      expect(readProjectRows(b.db, PROJECT).observations.length).toBe(1);
    } finally {
      a.db.close(); b.db.close();
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx bun test tests/engram/mem-roundtrip.test.ts`
Expected: FAIL — `src/engram/mem-sql.ts` does not exist.

- [ ] **Step 3: Implement `mem-sql.ts`**

Create `src/engram/mem-sql.ts`:

```ts
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

  const summaryExists = db.prepare('SELECT 1 FROM session_summaries WHERE memory_session_id = ? AND created_at_epoch = ? AND IFNULL(prompt_number,-1) = IFNULL(?,-1) LIMIT 1');
  const promptExists = db.prepare('SELECT 1 FROM user_prompts WHERE content_session_id = ? AND prompt_number = ? LIMIT 1');

  const run = db.transaction((d: ProjectRows) => {
    for (const s of d.sessions) {
      if (insertFiltered(db, 'sdk_sessions', s, sessCols, 'ON CONFLICT DO NOTHING')) counts.sessions++;
    }
    for (const o of d.observations) {
      if (insertFiltered(db, 'observations', o, obsCols, 'ON CONFLICT(memory_session_id, content_hash) DO NOTHING')) counts.observations++;
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx bun test tests/engram/mem-roundtrip.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/engram/mem-sql.ts tests/engram/mem-roundtrip.test.ts
git commit -m "feat(engram): add mem-sql read + FK-ordered idempotent import"
```

---

## Task 3: `exporter.ts` + `importer.ts` — orchestrate files

**Files:**
- Create: `src/engram/exporter.ts`
- Create: `src/engram/importer.ts`
- Test: `tests/engram/mem-roundtrip.test.ts` (append a file-level roundtrip)

- [ ] **Step 1: Write the failing file-roundtrip test**

Append to `tests/engram/mem-roundtrip.test.ts`:

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { exportProject } from '../../src/engram/exporter.js';
import { importProject } from '../../src/engram/importer.js';
import { memFile, decisionsDir, statePath, manifestPath } from '../../src/engram/mem-format.js';

describe('exporter/importer file roundtrip', () => {
  it('exportProject writes .mem artifacts; importProject loads them into a fresh DB', () => {
    const repoA = mkdtempSync(join(tmpdir(), 'engram-repoA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'engram-repoB-'));
    const a = new ClaudeMemDatabase(join(dirB, 'a.db')); // db lives outside the repo dir
    const b = new ClaudeMemDatabase(join(dirB, 'b.db'));
    try {
      seed(a.db);
      exportProject(a.db, PROJECT, repoA);

      // Artifacts exist.
      expect(existsSync(memFile(repoA, 'observations'))).toBe(true);
      expect(existsSync(manifestPath(repoA))).toBe(true);
      expect(existsSync(statePath(repoA))).toBe(true);
      expect(readFileSync(statePath(repoA), 'utf8')).toContain('env injection works'); // from the summary
      // The decision-type observation produced a decisions/*.md.
      const decisions = existsSync(decisionsDir(repoA)) ? readdirSync(decisionsDir(repoA)) : [];
      expect(decisions.length).toBeGreaterThanOrEqual(1);

      // Import into a fresh DB and verify.
      const counts = importProject(b.db, repoA);
      expect(counts.observations).toBe(1);
      const bRows = readProjectRows(b.db, PROJECT);
      expect(bRows.observations[0].content_hash).toBe('hash-abc');

      // Re-export from B must be byte-identical to A's ndjson (canonical determinism).
      const repoB = mkdtempSync(join(tmpdir(), 'engram-repoB2-'));
      try {
        exportProject(b.db, PROJECT, repoB);
        expect(readFileSync(memFile(repoB, 'observations'), 'utf8'))
          .toBe(readFileSync(memFile(repoA, 'observations'), 'utf8'));
      } finally { rmSync(repoB, { recursive: true, force: true }); }
    } finally {
      a.db.close(); b.db.close();
      rmSync(repoA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx bun test tests/engram/mem-roundtrip.test.ts`
Expected: FAIL — `exporter.ts`/`importer.ts` do not exist.

- [ ] **Step 3: Implement `exporter.ts`**

Create `src/engram/exporter.ts`:

```ts
import type { Database } from 'bun:sqlite';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readProjectRows, type ProjectRows } from './mem-sql.js';
import {
  memDir, memFile, decisionsDir, statePath, serializeRows, ensureScaffold, readOrCreateManifest,
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
  }
  return rows;
}
```

- [ ] **Step 4: Implement `importer.ts`**

Create `src/engram/importer.ts`:

```ts
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx bun test tests/engram/mem-roundtrip.test.ts`
Expected: PASS (2 tests — the DB-level roundtrip + the file-level roundtrip incl. byte-identical re-export).

- [ ] **Step 6: Commit**

```bash
git add src/engram/exporter.ts src/engram/importer.ts tests/engram/mem-roundtrip.test.ts
git commit -m "feat(engram): add exporter/importer orchestration (.mem files + state + decisions)"
```

---

## Task 4: Full verification

**Files:** none.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck:root`
Expected: clean. (`mem-sql.ts`/`exporter.ts`/`importer.ts` import `type { Database } from 'bun:sqlite'` — type-only; the sqlite layer (`ClaudeMemDatabase`) is imported only in TESTS, never in `src/engram/` runtime modules, preserving the no-frozen-paths purity.)

- [ ] **Step 2: Full engram suite**

Run: `npx bun test tests/engram/`
Expected: PASS — prior 30 + mem-format (5) + mem-roundtrip (2) = **37 tests**.

- [ ] **Step 3: Purity invariant (engram still does not import shared/paths)**

Run: `grep -rn "shared/paths" src/engram/ || echo "OK"`
Expected: `OK`. (mem-sql/exporter/importer take a `Database` handle as an argument; they never import the frozen paths. The worker/Plan D will pass the handle + the project + the root.)

- [ ] **Step 4: No live-install side effects**

Run: `git status --short`
Expected: clean. No build-and-sync, no worker restart.

---

## Definition of done (Plan C)

- `exportProject(db, project, root)` writes canonical `.mem/{sessions,observations,summaries,prompts}.ndjson` + `state.md` + `decisions/*.md` + `manifest.json` + `.gitignore` + `.gitattributes`.
- `importProject(db, root)` loads them FK-ordered + idempotently (`content_hash` dedup for observations; natural-key for summaries/prompts; verbatim `content_hash`).
- Roundtrip DB-A → `.mem/` → DB-B yields matching rows; re-export is byte-identical (canonical determinism); re-import is a no-op.
- `npx bun test tests/engram/` green (37 tests); typecheck clean; purity intact; working tree clean.

## Self-review notes (author)

- **Spec coverage:** §4.2 exporter, §4.3 importer, §6 `.mem/` layout (ndjson + decisions + state.md + manifest + .gitignore + .gitattributes union-merge). Watermark/append-only is replaced by full canonical re-export (simpler, deterministic, equally clean diffs) — a deliberate v1 simplification noted here.
- **No placeholders:** complete modules + tests; exact SQL with the verified canonical column sets, FK order, and dedup keys.
- **Faithful + drift-tolerant:** import filters to the target DB's actual columns (`PRAGMA table_info`) so a target missing `generated_by_model`/`metadata` still imports; `content_hash` is carried verbatim so cross-machine dedup is stable.
- **Isolation/testability:** all tests use temp `ClaudeMemDatabase` DBs (opens + runs the migration runner) + temp repo dirs; no worker, no live data, no network. Read/import drift-tolerance means the exact migrated column set does not matter. The byte-identical re-export assertion guards canonical determinism (critical for clean git diffs in Plan D).
- **Purity:** `src/engram/` runtime modules take a `Database` handle + paths as arguments — they never import the frozen `shared/paths.ts`; the sqlite layer (`ClaudeMemDatabase`) appears only in tests. Plan D wires the worker's handle + `resolveProjectRuntime().root` into these.
- **Deferred:** decision detection keys on `type === 'decision'` (configurable `DECISION_TYPES`); a richer taxonomy is a later tweak. Wiring export/import into the worker + sync hooks is Plan D.
