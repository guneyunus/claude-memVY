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
