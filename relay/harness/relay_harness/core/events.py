"""Hook 总线。

模型是发动机，hook 是接在线束上的传感器和继电器：
每个关键时刻（会话开始、用户输入、调工具前后、压缩前、停止）都能挂东西上去，
在不改 harness 代码的前提下改变它的行为。

设计要点（对齐 Claude Code 的 hook 语义，方便迁移）：
- 事件名固定六个；hook 按 priority 升序串行执行；
- 返回 Deny 就短路，后面的 hook 不跑，工具不执行；
- Modify 能改工具入参（比如把 `rm -rf` 改成 `rm -ri`）；
- Inject 往上下文里塞一段文本（SessionStart 注入项目说明、PostToolUse 注入 lint 结果）；
- Shell hook 通过 stdin 收 JSON，exit 2 = deny（stderr 作为理由），exit 0 + stdout JSON = 决策。
"""

from __future__ import annotations

import asyncio
import json
import shlex
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Event(str, Enum):
    SESSION_START = "SessionStart"
    USER_PROMPT_SUBMIT = "UserPromptSubmit"
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    PRE_COMPACT = "PreCompact"
    STOP = "Stop"


# ---- hook 的返回协议 ----

@dataclass
class Continue:
    pass


@dataclass
class Deny:
    reason: str


@dataclass
class Modify:
    tool_input: dict[str, Any]
    reason: str = ""


@dataclass
class Inject:
    context: str          # 追加到下一条给模型的消息里
    reason: str = ""


Decision = Continue | Deny | Modify | Inject


@dataclass
class HookContext:
    event: Event
    session_id: str
    cwd: str
    tool_name: str | None = None
    tool_input: dict[str, Any] | None = None
    tool_output: str | None = None
    prompt: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "hook_event_name": self.event.value, "session_id": self.session_id, "cwd": self.cwd,
            "tool_name": self.tool_name, "tool_input": self.tool_input, "tool_output": self.tool_output,
            "prompt": self.prompt, **self.extra,
        }


HookFn = Callable[[HookContext], Awaitable[Decision] | Decision]


@dataclass(order=True)
class _Registered:
    priority: int
    name: str
    fn: HookFn = field(compare=False)
    matcher: str | None = field(compare=False, default=None)   # 只对匹配的 tool_name 触发


@dataclass
class HookOutcome:
    allowed: bool = True
    deny_reason: str | None = None
    tool_input: dict[str, Any] | None = None
    injected: list[str] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)   # 哪些 hook 跑了、返回了什么 —— 调试用


class HookBus:
    def __init__(self) -> None:
        self._hooks: dict[Event, list[_Registered]] = {e: [] for e in Event}

    def on(self, event: Event, fn: HookFn, *, priority: int = 100, name: str | None = None,
           matcher: str | None = None) -> None:
        reg = _Registered(priority, name or getattr(fn, "__name__", "hook"), fn, matcher)
        self._hooks[event].append(reg)
        self._hooks[event].sort()

    def hook(self, event: Event, **kw):
        """装饰器形式：@bus.hook(Event.PRE_TOOL_USE, matcher="bash")"""
        def deco(fn: HookFn) -> HookFn:
            self.on(event, fn, **kw)
            return fn
        return deco

    def add_shell_hook(self, event: Event, command: str, *, matcher: str | None = None,
                       priority: int = 100, timeout: float = 30.0) -> None:
        async def run(ctx: HookContext) -> Decision:
            proc = await asyncio.create_subprocess_exec(
                *shlex.split(command), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=ctx.cwd)
            try:
                out, err = await asyncio.wait_for(
                    proc.communicate(json.dumps(ctx.to_json()).encode()), timeout=timeout)
            except TimeoutError:
                proc.kill()
                return Deny(f"hook `{command}` timed out after {timeout}s")
            if proc.returncode == 2:
                return Deny(err.decode().strip() or f"blocked by `{command}`")
            if proc.returncode != 0:
                return Continue()          # 非 0 非 2：hook 自己出错，不影响主流程
            text = out.decode().strip()
            if not text:
                return Continue()
            try:
                j = json.loads(text)
            except json.JSONDecodeError:
                return Inject(text)        # 纯文本输出 = 注入上下文
            if j.get("decision") == "deny":
                return Deny(j.get("reason", "denied"))
            if "tool_input" in j:
                return Modify(j["tool_input"], j.get("reason", ""))
            if "context" in j:
                return Inject(j["context"], j.get("reason", ""))
            return Continue()
        self.on(event, run, priority=priority, name=f"sh:{command}", matcher=matcher)

    def load_settings(self, settings: dict[str, Any]) -> int:
        """读 .relay/settings.json 里的 hooks 段，格式与 Claude Code 一致：
        {"hooks": {"PreToolUse": [{"matcher": "bash", "hooks": [{"type": "command", "command": "..."}]}]}}
        """
        n = 0
        for ev_name, groups in (settings.get("hooks") or {}).items():
            try:
                ev = Event(ev_name)
            except ValueError:
                continue
            for g in groups:
                for h in g.get("hooks", []):
                    if h.get("type", "command") == "command":
                        self.add_shell_hook(ev, h["command"], matcher=g.get("matcher"),
                                            timeout=float(h.get("timeout", 30)))
                        n += 1
        return n

    async def emit(self, ctx: HookContext) -> HookOutcome:
        out = HookOutcome(tool_input=dict(ctx.tool_input) if ctx.tool_input else None)
        for reg in self._hooks[ctx.event]:
            if reg.matcher and ctx.tool_name and not _match(reg.matcher, ctx.tool_name):
                continue
            if out.tool_input is not None:
                ctx.tool_input = out.tool_input      # 前一个 hook 的 Modify 对后面可见
            res = reg.fn(ctx)
            if asyncio.iscoroutine(res):
                res = await res
            match res:
                case Deny(reason=r):
                    out.allowed = False
                    out.deny_reason = r
                    out.trace.append(f"{reg.name}: deny ({r})")
                    return out
                case Modify(tool_input=ti, reason=r):
                    out.tool_input = ti
                    out.trace.append(f"{reg.name}: modify ({r})")
                case Inject(context=c, reason=r):
                    out.injected.append(c)
                    out.trace.append(f"{reg.name}: inject ({r or len(c)} chars)")
                case _:
                    out.trace.append(f"{reg.name}: continue")
        return out

    def registered(self) -> dict[str, list[str]]:
        return {e.value: [f"{r.name}@{r.priority}" + (f"[{r.matcher}]" if r.matcher else "")
                          for r in regs] for e, regs in self._hooks.items() if regs}


def _match(pattern: str, name: str) -> bool:
    if pattern == "*" or pattern == name:
        return True
    return any(p.strip() == name for p in pattern.split("|"))
