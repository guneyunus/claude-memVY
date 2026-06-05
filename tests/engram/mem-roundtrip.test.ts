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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { exportProject } from '../../src/engram/exporter.js';
import { importProject } from '../../src/engram/importer.js';
import { memFile, decisionsDir, statePath, manifestPath } from '../../src/engram/mem-format.js';

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
