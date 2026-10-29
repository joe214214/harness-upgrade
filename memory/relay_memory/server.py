"""Memory server: newline-delimited JSON-RPC 2.0 over stdio.

It speaks MCP (`initialize`, `tools/list`, `tools/call`) so any MCP client
can use the model-facing tools, plus private `relay/*` methods that only the
dsh plugin calls:

  relay/context  memory text to place in the model's context
  relay/ingest   store a turn in episodic memory, then run the reflect pass
  relay/status   sizes, for the CLI and tests

One request is handled at a time. The plugin awaits each call, so requests
never overlap within a session, and SQLite stays single-threaded.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

from relay_memory import __version__
from relay_memory.episodic import EpisodicMemory
from relay_memory.longterm import LongTermMemory, MemoryFull
from relay_memory.reflect import Completer, reflect

PROTOCOL_VERSION = "2025-06-18"

TOOLS = [
    {"name": "memory_read", "description": "Read the full long-term memory file (MEMORY.md).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "memory_write",
     "description": "Save one durable fact to long-term memory. Use for user preferences, project conventions "
                    "and decisions that should still hold in future sessions. Fails when memory is full: "
                    "then consolidate with memory_rewrite first.",
     "inputSchema": {"type": "object", "required": ["section", "fact"], "properties": {
         "section": {"type": "string", "enum": ["user", "project", "decisions", "general"]},
         "fact": {"type": "string", "description": "One line, self-contained."}}}},
    {"name": "memory_replace", "description": "Replace one exact, unique substring of MEMORY.md (fix or update a fact).",
     "inputSchema": {"type": "object", "required": ["old", "new"], "properties": {
         "old": {"type": "string"}, "new": {"type": "string", "description": "Empty string deletes."}}}},
    {"name": "memory_rewrite",
     "description": "Replace the whole MEMORY.md. Use to consolidate when memory is full: merge duplicates, "
                    "drop stale facts, compress details into conclusions. Keep the '## section' / '- fact' format.",
     "inputSchema": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}}},
    {"name": "recall",
     "description": "Full-text search over past conversations in earlier sessions (what was said or done before). "
                    "Use when the user refers to previous work that is not in long-term memory.",
     "inputSchema": {"type": "object", "required": ["query"], "properties": {"query": {"type": "string"}}}},
]


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class MemoryServer:
    root: Path
    model: Completer | None = None
    cap_bytes: int = 8_000
    longterm: LongTermMemory = field(init=False)
    episodic: EpisodicMemory = field(init=False)

    def __post_init__(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.longterm = LongTermMemory(self.root / "MEMORY.md", self.cap_bytes)
        self.episodic = EpisodicMemory(self.root / "episodic.db")
        self._idx: dict[str, int] = {}
        self._methods: dict[str, Callable[[dict], Any]] = {
            "initialize": self._initialize,
            "ping": lambda p: {},
            "tools/list": lambda p: {"tools": TOOLS},
            "tools/call": self._tools_call,
            "relay/context": lambda p: {"text": self.longterm.render_for_prompt()},
            "relay/ingest": self._ingest,
            "relay/status": self._status,
        }

    # ---- protocol ---------------------------------------------------------

    def handle(self, msg: dict) -> dict | None:
        """Handle one JSON-RPC message. Notifications (no id) get no response."""
        mid = msg.get("id")
        method = msg.get("method")
        if mid is None:
            return None
        try:
            fn = self._methods.get(method)
            if fn is None:
                raise RpcError(-32601, f"method not found: {method}")
            return {"jsonrpc": "2.0", "id": mid, "result": fn(msg.get("params") or {})}
        except RpcError as e:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": e.code, "message": str(e)}}
        except Exception as e:  # noqa: BLE001 - one bad request must not kill the server
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": f"{type(e).__name__}: {e}"}}

    def serve(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
        for line in stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                resp: dict | None = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
            else:
                resp = self.handle(msg)
            if resp is not None:
                stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                stdout.flush()

    def _initialize(self, p: dict) -> dict:
        return {"protocolVersion": p.get("protocolVersion") or PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "relay-memory", "version": __version__}}

    # ---- tools ------------------------------------------------------------

    def _tools_call(self, p: dict) -> dict:
        name, args = p.get("name"), p.get("arguments") or {}
        try:
            text = self.call_tool(name, args, source=str(p.get("_meta", {}).get("session_id", "")))
        except (MemoryFull, ValueError, KeyError) as e:
            return {"content": [{"type": "text", "text": str(e)}], "isError": True}
        return {"content": [{"type": "text", "text": text}], "isError": False}

    def call_tool(self, name: str, args: dict, source: str = "") -> str:
        if name == "memory_read":
            return self.longterm.read() or "(memory is empty)"
        if name == "memory_write":
            before = self.longterm.size()
            self.longterm.append(args["section"], args["fact"], source)
            if self.longterm.size() == before:
                return "already in memory"
            return f"saved ({self.longterm.size()}/{self.cap_bytes} bytes)"
        if name == "memory_replace":
            if not self.longterm.replace(args["old"], args["new"]):
                raise ValueError("'old' must occur exactly once in MEMORY.md")
            return f"replaced ({self.longterm.size()}/{self.cap_bytes} bytes)"
        if name == "memory_rewrite":
            self.longterm.rewrite(args["text"].rstrip("\n") + "\n")
            return f"rewritten ({self.longterm.size()}/{self.cap_bytes} bytes)"
        if name == "recall":
            hits = self.episodic.search(args["query"], exclude_session=source or None)
            if not hits:
                return "no matches in past sessions"
            return "\n\n".join(f"[{h.session_id[:20]} · {h.role}] {h.content[:600]}" for h in hits)
        raise ValueError(f"unknown tool: {name}")

    # ---- plugin-only ------------------------------------------------------

    def _ingest(self, p: dict) -> dict:
        sid = p["session_id"]
        msgs: list[dict] = p.get("messages") or []
        self.episodic.start_session(sid, p.get("cwd", ""), p.get("title"))
        if sid not in self._idx:
            self._idx[sid] = self.episodic.next_idx(sid)
        for m in msgs:
            self.episodic.append(sid, self._idx[sid], m["role"], m.get("text", ""), m.get("tool_name"))
            self._idx[sid] += 1
        out: dict[str, Any] = {"stored": len(msgs), "facts_saved": 0, "error": None}
        if p.get("reflect", True) and self.model is not None and msgs:
            transcript = "\n\n".join(f"{m['role'].upper()}: {m.get('text', '')}" for m in msgs)
            out["facts_saved"], out["error"] = reflect(self.model, transcript, self.longterm, source=sid)
        return out

    def _status(self, p: dict) -> dict:
        return {"root": str(self.root), "memory_bytes": self.longterm.size(), "cap_bytes": self.cap_bytes,
                "sessions": len(self.episodic.recent_sessions(10_000))}
