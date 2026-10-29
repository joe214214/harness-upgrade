"""情景记忆：所有会话的所有轮次落 SQLite，FTS5 全文索引，跨会话检索。

长期记忆存"结论"，情景记忆存"经过"。
"上次那个 CORS 问题是怎么解决的"——结论可能没进 MEMORY.md，但经过一定在这里。
`recall` 工具就是查这张表。
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, cwd TEXT, started_at REAL, title TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, idx INTEGER, role TEXT,
  content TEXT, tool_name TEXT, ts REAL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS ix_turns_session ON turns(session_id, idx);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(content, content='turns', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
END;
"""


@dataclass
class Hit:
    session_id: str
    session_title: str | None
    role: str
    content: str
    ts: float
    rank: float


class EpisodicMemory:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.executescript(SCHEMA)

    def start_session(self, session_id: str, cwd: str, title: str | None = None) -> None:
        self._db.execute("INSERT OR IGNORE INTO sessions(id, cwd, started_at, title) VALUES (?,?,?,?)",
                         (session_id, cwd, time.time(), title))
        self._db.commit()

    def append(self, session_id: str, idx: int, role: str, content: str, tool_name: str | None = None) -> None:
        self._db.execute("INSERT INTO turns(session_id, idx, role, content, tool_name, ts) VALUES (?,?,?,?,?,?)",
                         (session_id, idx, role, content, tool_name, time.time()))
        self._db.commit()

    def set_summary(self, session_id: str, summary: str, title: str | None = None) -> None:
        self._db.execute("UPDATE sessions SET summary=?, title=COALESCE(?, title) WHERE id=?", (summary, title, session_id))
        self._db.commit()

    def load(self, session_id: str) -> list[dict]:
        rows = self._db.execute("SELECT role, content, tool_name FROM turns WHERE session_id=? ORDER BY idx", (session_id,)).fetchall()
        return [{"role": r, "content": c, **({"tool_name": t} if t else {})} for r, c, t in rows]

    def recent_sessions(self, n: int = 10) -> list[dict]:
        rows = self._db.execute("SELECT id, cwd, started_at, title, summary FROM sessions ORDER BY started_at DESC LIMIT ?", (n,)).fetchall()
        return [{"id": i, "cwd": c, "started_at": s, "title": t, "summary": m} for i, c, s, t, m in rows]

    def search(self, query: str, limit: int = 8, exclude_session: str | None = None) -> list[Hit]:
        q = _fts_query(query)
        if not q:
            return []
        sql = """SELECT t.session_id, s.title, t.role, t.content, t.ts, bm25(turns_fts) AS rank
                 FROM turns_fts f JOIN turns t ON t.id = f.rowid JOIN sessions s ON s.id = t.session_id
                 WHERE turns_fts MATCH ? {excl} ORDER BY rank LIMIT ?"""
        args: list = [q]
        excl = ""
        if exclude_session:
            excl = "AND t.session_id != ?"
            args.append(exclude_session)
        args.append(limit)
        rows = self._db.execute(sql.format(excl=excl), args).fetchall()
        return [Hit(*r) for r in rows]

    def close(self) -> None:
        self._db.close()


def _fts_query(q: str) -> str:
    # FTS5 对标点敏感，把用户输入拆成词再 OR 起来；引号包裹防止被当语法
    words = [w for w in "".join(ch if ch.isalnum() or ch in "_-" else " " for ch in q).split() if len(w) > 1]
    return " OR ".join(f'"{w}"' for w in words[:12])


def turn_to_text(msg: dict) -> str:
    """把一条消息压成可索引的文本（tool_calls 也要能被搜到）。"""
    parts = []
    c = msg.get("content")
    if isinstance(c, str):
        parts.append(c)
    elif isinstance(c, list):
        parts += [p["text"] if p.get("type") == "text" else "[image]" for p in c]
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function", {})
        parts.append(f"[tool {fn.get('name')}] {fn.get('arguments', '')}")
    return "\n".join(p for p in parts if p)


def dump_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)
