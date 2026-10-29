"""长期记忆：一个有硬上限的 MEMORY.md，agent 自己维护。

Hermes 的思路：不给无限存储。文件满了就写不进去，agent 必须先整理——
合并重复、删过时、把细节压成结论。上限本身就是一种"什么值得记"的筛选压力。

文件格式很简单，按 section 组织，每行一条事实：
    ## user
    - prefers pytest over unittest
    ## project
    - gateway uses Redis Streams, not lists
每条写入带来源（哪次会话），便于日后追溯"这条是怎么来的"。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


class MemoryFull(RuntimeError):
    def __init__(self, size: int, cap: int):
        self.size, self.cap = size, cap
        super().__init__(
            f"MEMORY.md is {size} bytes, cap is {cap}. Consolidate first: "
            f"merge duplicates, drop stale entries, compress details into conclusions."
        )


@dataclass
class LongTermMemory:
    path: Path
    cap_bytes: int = 8_000

    def read(self) -> str:
        return self.path.read_text("utf-8") if self.path.is_file() else ""

    def size(self) -> int:
        return len(self.read().encode("utf-8"))

    def sections(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        cur = "general"
        for line in self.read().splitlines():
            if line.startswith("## "):
                cur = line[3:].strip()
                out.setdefault(cur, [])
            elif line.strip().startswith("- "):
                out.setdefault(cur, []).append(re.sub(r"\s*<!--.*?-->\s*$", "", line.strip()[2:]))
        return out

    def append(self, section: str, fact: str, source: str = "") -> None:
        fact = fact.strip().replace("\n", " ")
        if not fact:
            return
        if fact in self.sections().get(section, []):
            return                                  # 去重：已有就不重复写
        text = self.read()
        entry = f"- {fact}" + (f"  <!-- {source} -->" if source else "")
        if f"## {section}" in text:
            text = re.sub(rf"(## {re.escape(section)}\n(?:- .*\n?)*)", lambda m: m.group(1).rstrip("\n") + "\n" + entry + "\n", text, count=1)
        else:
            text = text.rstrip("\n") + ("\n\n" if text.strip() else "") + f"## {section}\n{entry}\n"
        self._write(text)

    def replace(self, old: str, new: str) -> bool:
        text = self.read()
        if text.count(old) != 1:
            return False
        self._write(text.replace(old, new))
        return True

    def rewrite(self, text: str) -> None:
        """整理时整体重写。"""
        self._write(text)

    def _write(self, text: str) -> None:
        n = len(text.encode("utf-8"))
        if n > self.cap_bytes:
            raise MemoryFull(n, self.cap_bytes)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(text, "utf-8")

    def render_for_prompt(self) -> str:
        text = self.read().strip()
        if not text:
            return ""
        return (f"<memory size=\"{self.size()}/{self.cap_bytes} bytes\">\n"
                f"{re.sub(r'  <!--.*?-->', '', text)}\n</memory>")
