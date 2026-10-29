"""内置工具：文件、shell、记忆。全部限制在 workdir 内，路径穿越直接拒。"""

from __future__ import annotations

import asyncio
from pathlib import Path

from relay_harness.memory.episodic import EpisodicMemory
from relay_harness.memory.longterm import LongTermMemory, MemoryFull
from relay_harness.tools.base import ToolRegistry

MAX_OUT = 12_000


def _safe(workdir: Path, path: str) -> Path:
    p = (workdir / path).resolve()
    if workdir not in p.parents and p != workdir:
        raise PermissionError(f"path escapes workdir: {path}")
    return p


def _clip(s: str) -> str:
    return s if len(s) <= MAX_OUT else s[:MAX_OUT] + f"\n… [{len(s) - MAX_OUT} more chars truncated]"


def install(reg: ToolRegistry, workdir: Path, longterm: LongTermMemory, episodic: EpisodicMemory,
            session_id: str, shell_timeout: float = 60.0) -> None:
    workdir = workdir.resolve()

    @reg.tool()
    def read_file(path: str, start_line: int = 1, end_line: int = 0) -> str:
        """Read a text file (optionally a line range). Paths are relative to the working directory."""
        p = _safe(workdir, path)
        lines = p.read_text("utf-8", errors="replace").splitlines()
        end = end_line or len(lines)
        return _clip("\n".join(f"{i}\t{ln}" for i, ln in enumerate(lines[start_line - 1:end], start_line)))

    @reg.tool()
    def list_dir(path: str = ".") -> str:
        """List files and directories at a path."""
        p = _safe(workdir, path)
        return "\n".join(sorted(f"{c.name}{'/' if c.is_dir() else ''}" for c in p.iterdir()
                                if not c.name.startswith((".git", "node_modules", "__pycache__"))))

    @reg.tool()
    def write_file(path: str, content: str) -> str:
        """Create or overwrite a file with the given content."""
        p = _safe(workdir, path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, "utf-8")
        return f"wrote {len(content)} chars to {path}"

    @reg.tool()
    def edit_file(path: str, old: str, new: str) -> str:
        """Replace one exact occurrence of `old` with `new` in a file. Fails if `old` is missing or not unique."""
        p = _safe(workdir, path)
        text = p.read_text("utf-8")
        n = text.count(old)
        if n != 1:
            return f"error: `old` occurs {n} times, need exactly 1"
        p.write_text(text.replace(old, new), "utf-8")
        return f"edited {path}"

    @reg.tool()
    async def bash(command: str) -> str:
        """Run a shell command in the working directory. Output is truncated."""
        proc = await asyncio.create_subprocess_shell(command, cwd=workdir, stdout=asyncio.subprocess.PIPE,
                                                     stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=shell_timeout)
        except TimeoutError:
            proc.kill()
            return f"error: command timed out after {shell_timeout}s"
        return _clip(out.decode("utf-8", errors="replace")) + f"\n[exit {proc.returncode}]"

    @reg.tool()
    def view_image(path: str) -> str:
        """Look at an image file (png/jpg/webp). The image is attached to your next model call; the text result is a stub."""
        p = _safe(workdir, path)
        data = p.read_bytes()
        if len(data) > 5 * 1024 * 1024:
            return "error: image > 5MB"
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}.get(p.suffix.lower().lstrip("."), "image/png")
        return f"__IMAGE__:{mime}:{p.name}:{__import__('base64').b64encode(data).decode()}"

    @reg.tool()
    def memory_read() -> str:
        """Read your long-term memory file (MEMORY.md)."""
        return longterm.read() or "(memory is empty)"

    @reg.tool()
    def memory_write(section: str, fact: str) -> str:
        """Append one durable fact to long-term memory under a section (user | project | decisions)."""
        try:
            longterm.append(section, fact, source=session_id)
            return f"saved ({longterm.size()}/{longterm.cap_bytes} bytes used)"
        except MemoryFull as e:
            return f"error: {e}"

    @reg.tool()
    def memory_replace(old: str, new: str) -> str:
        """Edit long-term memory: replace one exact line. Use this to consolidate when memory is full."""
        try:
            return "replaced" if longterm.replace(old, new) else "error: `old` not found or not unique"
        except MemoryFull as e:
            return f"error: {e}"

    @reg.tool()
    def recall(query: str) -> str:
        """Search past sessions (full-text) for how something was handled before."""
        hits = episodic.search(query, limit=6, exclude_session=session_id)
        if not hits:
            return "no matching past sessions"
        return "\n\n".join(f"[{h.session_title or h.session_id[:8]} · {h.role}] {h.content[:500]}" for h in hits)
