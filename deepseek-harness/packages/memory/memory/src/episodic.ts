/**
 * Episodic memory: every turn of every Session in SQLite with an FTS5 index,
 * searchable across Sessions with `recall`. Semantic memory keeps
 * conclusions; this keeps what happened, including transcripts the media
 * tools produced.
 * @module @deepseek-ai/dsh-memory/episodic
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at REAL);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, idx INTEGER NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT, ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_turns_session ON turns(session_id, idx);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(content, content='turns', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
END;
`

/** One stored turn. */
export interface Turn {
  readonly role: string
  readonly text: string
  readonly toolName?: string
}

/** One search hit. */
export interface RecallHit {
  readonly sessionId: string
  readonly role: string
  readonly content: string
  readonly toolName: string | null
}

/**
 * Turn free text into an FTS5 query: words OR-ed and quoted, so punctuation
 * in the input is never parsed as query syntax.
 * @param query - model-supplied text.
 * @returns an FTS5 MATCH expression, or empty when no word remains.
 */
export function ftsQuery(query: string): string {
  const words = query.normalize('NFKC').split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length > 1)
  return words.slice(0, 12).map(w => `"${w}"`).join(' OR ')
}

/** The SQLite store. One instance per memory root. */
export class EpisodicMemory {
  private readonly db: DatabaseSync

  /** @param path - absolute path of the database file. */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)
  }

  /**
   * Append turns to a Session, continuing its index across restarts.
   * @param sessionId - Session id.
   * @param cwd - working directory recorded with a new Session.
   * @param turns - turns in order.
   */
  append(sessionId: string, cwd: string, turns: readonly Turn[]): void {
    this.db.prepare('INSERT OR IGNORE INTO sessions(id, cwd, started_at) VALUES (?, ?, ?)').run(sessionId, cwd, Date.now() / 1000)
    const row = this.db.prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM turns WHERE session_id = ?').get(sessionId) as { next: number }
    let idx = row.next
    const insert = this.db.prepare('INSERT INTO turns(session_id, idx, role, content, tool_name, ts) VALUES (?, ?, ?, ?, ?, ?)')
    for (const turn of turns) {
      insert.run(sessionId, idx, turn.role, turn.text, turn.toolName ?? null, Date.now() / 1000)
      idx += 1
    }
  }

  /**
   * Full-text search, best matches first.
   * @param query - free text.
   * @param limit - most hits.
   * @param excludeSession - Session to leave out (the caller's own).
   * @returns hits.
   */
  search(query: string, limit: number, excludeSession?: string): RecallHit[] {
    const match = ftsQuery(query)
    if (!match) return []
    const sql = `SELECT t.session_id AS sessionId, t.role AS role, t.content AS content, t.tool_name AS toolName
      FROM turns_fts f JOIN turns t ON t.id = f.rowid
      WHERE turns_fts MATCH ? ${excludeSession === undefined ? '' : 'AND t.session_id != ?'}
      ORDER BY bm25(turns_fts) LIMIT ?`
    const params = excludeSession === undefined ? [match, limit] : [match, excludeSession, limit]
    return this.db.prepare(sql).all(...params).map(row => ({
      sessionId: String(row.sessionId),
      role: String(row.role),
      content: String(row.content),
      toolName: row.toolName === null ? null : String(row.toolName),
    }))
  }

  /**
   * Count the Sessions that have stored turns.
   * @returns the number of stored Sessions.
   */
  sessionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
  }

  /** Close the database. */
  close(): void {
    this.db.close()
  }
}
