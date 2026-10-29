"""权限策略。三档（对齐 Codex 的 approval modes）+ 按工具的显式 allow/deny/ask。

  suggest    只读工具自动放行，写文件和 shell 都要问
  auto-edit  写文件自动放行，shell 要问
  full-auto  全放行（沙箱里跑才敢开）

实现方式：注册为一个 priority=0 的 PreToolUse hook。
这意味着策略和其他 hook 走同一条路，用户自己的 hook 可以排在它前面（priority<0）先改入参。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from enum import Enum

from relay_harness.core.events import Continue, Deny, Event, HookBus, HookContext


class Mode(str, Enum):
    SUGGEST = "suggest"
    AUTO_EDIT = "auto-edit"
    FULL_AUTO = "full-auto"


READ_ONLY = {"read_file", "list_dir", "recall", "memory_read", "grep"}
WRITE = {"write_file", "edit_file", "memory_write", "memory_replace"}
SHELL = {"bash"}

Asker = Callable[[str, dict], Awaitable[bool]]     # (tool_name, tool_input) -> 用户是否同意


class Policy:
    def __init__(self, mode: Mode = Mode.SUGGEST, allow: set[str] | None = None, deny: set[str] | None = None,
                 asker: Asker | None = None):
        self.mode, self.allow, self.deny, self.asker = mode, allow or set(), deny or set(), asker
        self.decisions: list[tuple[str, str]] = []
        self._ask_lock = None   # 并行工具调用时，问用户必须串行

    def classify(self, tool: str) -> str:
        if tool in self.deny:
            return "deny"
        if tool in self.allow:
            return "allow"
        if tool in READ_ONLY:
            return "allow"
        if self.mode == Mode.FULL_AUTO:
            return "allow"
        if tool in WRITE:
            return "allow" if self.mode == Mode.AUTO_EDIT else "ask"
        if tool in SHELL:
            return "ask"
        return "ask"

    def install(self, bus: HookBus) -> None:
        async def gate(ctx: HookContext):
            verdict = self.classify(ctx.tool_name or "")
            if verdict == "ask":
                if self.asker is None:
                    verdict = "deny"
                else:
                    import asyncio
                    if self._ask_lock is None:
                        self._ask_lock = asyncio.Lock()
                    async with self._ask_lock:
                        verdict = "allow" if await self.asker(ctx.tool_name or "", ctx.tool_input or {}) else "deny"
            self.decisions.append((ctx.tool_name or "", verdict))
            if verdict == "deny":
                return Deny(f"policy ({self.mode.value}) does not allow `{ctx.tool_name}`")
            return Continue()
        bus.on(Event.PRE_TOOL_USE, gate, priority=0, name=f"policy:{self.mode.value}")
