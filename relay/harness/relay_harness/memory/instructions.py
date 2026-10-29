"""过程记忆：AGENTS.md 层级发现。

从 cwd 向上走到文件系统根，再加用户级 ~/.relay/AGENTS.md。
越靠近 cwd 的越具体，放在后面，模型看到时"后者覆盖前者"。
和 Codex 的 AGENTS.md / Claude Code 的 CLAUDE.md 是同一套约定，所以两边写的文件这里都认。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

CANDIDATES = ("AGENTS.md", "CLAUDE.md", ".relay/AGENTS.md")


@dataclass
class InstructionFile:
    path: Path
    scope: str      # user | ancestor | project
    text: str


def discover(cwd: Path, home: Path | None = None, max_bytes: int = 32_000) -> list[InstructionFile]:
    cwd = cwd.resolve()
    home = (home or Path.home()).resolve()
    found: list[InstructionFile] = []

    user_file = home / ".relay" / "AGENTS.md"
    if user_file.is_file():
        found.append(InstructionFile(user_file, "user", _read(user_file, max_bytes)))

    chain = [cwd, *cwd.parents]
    for d in reversed(chain):                 # 从根往下，越具体的越后
        for name in CANDIDATES:
            p = d / name
            if p.is_file() and p != user_file:
                scope = "project" if d == cwd else "ancestor"
                found.append(InstructionFile(p, scope, _read(p, max_bytes)))
                break
    return found


def render(files: list[InstructionFile]) -> str:
    if not files:
        return ""
    parts = []
    for f in files:
        parts.append(f"<instructions scope=\"{f.scope}\" path=\"{f.path}\">\n{f.text.strip()}\n</instructions>")
    return "\n\n".join(parts)


def _read(p: Path, max_bytes: int) -> str:
    data = p.read_bytes()[:max_bytes]
    return data.decode("utf-8", errors="replace")
