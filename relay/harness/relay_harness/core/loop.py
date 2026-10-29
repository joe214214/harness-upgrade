"""Agent loop —— 把所有零件接成一辆车。

一轮 `run(prompt)` 的完整生命周期：

  SessionStart(hook, 首次)  →  加载 AGENTS.md + MEMORY.md 进 system prompt
  UserPromptSubmit(hook)    →  可 deny / 注入
  ┌─ 模型 → 若有 tool_calls：
  │     PreToolUse(hook：policy + 用户 hook，可 deny/modify)
  │     执行工具
  │     PostToolUse(hook，可注入 lint 结果等)
  │     结果回填 → 继续循环（最多 max_steps）
  └─ 无 tool_calls → 结束
  Stop(hook)  →  reflect pass 抽事实进长期记忆（异步，可关）
  每条消息都落情景记忆；上下文超预算 → PreCompact(hook) → reflect 旧轮次 → 摘要替换
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from relay_harness.core.context import (
    SUMMARY_PROMPT,
    CompactionResult,
    ContextBudget,
    render_transcript,
)
from relay_harness.core.events import Event, HookBus, HookContext
from relay_harness.memory import instructions
from relay_harness.memory.episodic import EpisodicMemory, turn_to_text
from relay_harness.memory.longterm import LongTermMemory
from relay_harness.memory.reflect import reflect
from relay_harness.policy import Mode, Policy
from relay_harness.tools import builtin
from relay_harness.tools.base import ToolRegistry


def _content_text(c) -> str:
    if isinstance(c, str):
        return c
    out = []
    for p in c or []:
        if p.get("type") == "text":
            out.append(p["text"])
        elif p.get("type") == "image_url":
            u = p["image_url"]["url"]
            out.append(f"[image {len(u) * 3 // 4 // 1024}KB]")
    return " ".join(out)


BASE_SYSTEM = """You are a coding agent running inside the Relay harness in {cwd}.
Use tools to inspect and change the project; don't guess file contents. Keep replies short.
Long-term memory (<memory>) persists across sessions; write to it only durable facts, and consolidate when it is near its cap.
Use `recall` to check how similar problems were handled in past sessions before re-deriving them."""


@dataclass
class TurnResult:
    text: str
    steps: int
    tool_calls: list[dict] = field(default_factory=list)
    denied: list[dict] = field(default_factory=list)
    compactions: list[CompactionResult] = field(default_factory=list)
    facts_saved: int = 0
    hook_trace: list[str] = field(default_factory=list)


class Agent:
    def __init__(self, model: Any, workdir: Path, *, state_dir: Path | None = None, session_id: str | None = None,
                 mode: Mode = Mode.SUGGEST, asker=None, budget: ContextBudget | None = None,
                 reflect_on_stop: bool = True, max_steps: int = 25, home: Path | None = None,
                 parallel_limit: int = 4, depth: int = 0, max_depth: int = 2):
        self.model = model
        self.workdir = workdir.resolve()
        self.state_dir = (state_dir or self.workdir / ".relay").resolve()
        self.session_id = session_id or uuid.uuid4().hex[:12]
        self.budget = budget or ContextBudget()
        self.reflect_on_stop = reflect_on_stop
        self.max_steps = max_steps
        self.home = home
        self.parallel_limit = parallel_limit
        self.depth = depth
        self.max_depth = max_depth
        self._mcp: list = []
        self.children: list[Agent] = []

        self.hooks = HookBus()
        self.policy = Policy(mode, asker=asker)
        self.policy.install(self.hooks)
        self.longterm = LongTermMemory(self.state_dir / "MEMORY.md")
        self.episodic = EpisodicMemory(self.state_dir / "episodic.db")
        self.tools = ToolRegistry()
        builtin.install(self.tools, self.workdir, self.longterm, self.episodic, self.session_id)
        if depth < max_depth:
            from relay_harness.subagent import install as install_subagent
            install_subagent(self)

        self.messages: list[dict] = []
        self._started = False
        self._idx = 0
        self._pending_context: list[str] = []
        self._pending_images: list[dict] = []
        self._bg: set[asyncio.Task] = set()

    # ---------- 会话 ----------

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self.episodic.start_session(self.session_id, str(self.workdir))
        out = await self.hooks.emit(HookContext(Event.SESSION_START, self.session_id, str(self.workdir)))
        self.messages = [{"role": "system", "content": self._system_prompt(extra=out.injected)}]

    async def resume(self, session_id: str) -> int:
        """从情景记忆恢复一个旧会话的消息。返回恢复的条数。"""
        turns = self.episodic.load(session_id)
        self.session_id = session_id
        await self.start()
        for t in turns:
            m = {"role": t["role"], "content": t["content"]}
            if t.get("tool_name"):
                m["tool_call_id"] = t["tool_name"]
            self.messages.append(m)
        self._idx = len(turns)
        return len(turns)

    def _system_prompt(self, extra: list[str] | None = None) -> str:
        parts = [BASE_SYSTEM.format(cwd=self.workdir)]
        ins = instructions.render(instructions.discover(self.workdir, home=self.home))
        if ins:
            parts.append(ins)
        mem = self.longterm.render_for_prompt()
        if mem:
            parts.append(mem)
        parts.extend(extra or [])
        return "\n\n".join(parts)

    def _record(self, msg: dict, tool_name: str | None = None) -> None:
        self.messages.append(msg)
        # 情景记忆只存文本：图片本身进 blobs（按 hash 去重），库里只留一行描述
        self.episodic.append(self.session_id, self._idx, msg["role"], turn_to_text(msg) or _content_text(msg.get("content", "")), tool_name)
        self._idx += 1

    def _store_blob(self, mime: str, data: bytes) -> str:
        import hashlib
        h = hashlib.sha256(data).hexdigest()[:16]
        ext = mime.split("/")[-1].replace("jpeg", "jpg")
        d = self.state_dir / "blobs"
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"{h}.{ext}"
        if not f.exists():
            f.write_bytes(data)
        return str(f)

    # ---------- 主循环 ----------

    async def run(self, prompt: str, images: list[str] | None = None) -> TurnResult:
        await self.start()
        res = TurnResult(text="", steps=0)

        out = await self.hooks.emit(HookContext(Event.USER_PROMPT_SUBMIT, self.session_id, str(self.workdir), prompt=prompt))
        res.hook_trace += out.trace
        if not out.allowed:
            res.text = f"[blocked] {out.deny_reason}"
            return res
        content = prompt + ("\n\n" + "\n\n".join(out.injected) if out.injected else "")
        if self._pending_context:
            content += "\n\n" + "\n\n".join(self._pending_context)
            self._pending_context.clear()
        if images:
            import base64
            parts: list[dict] = [{"type": "text", "text": content}]
            for ip in images:
                data = Path(ip).read_bytes()
                mime = "image/png" if ip.lower().endswith(".png") else "image/jpeg"
                self._store_blob(mime, data)
                parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}})
            self._record({"role": "user", "content": parts})
        else:
            self._record({"role": "user", "content": content})

        for step in range(self.max_steps):
            res.steps = step + 1
            if self.budget.needs_compaction(self.messages):
                res.compactions.append(await self.compact())

            if self._pending_images:
                self._record({"role": "user", "content": [{"type": "text", "text": "(attached image(s) from the tool above)"}, *self._pending_images]})
                self._pending_images.clear()
            reply = await self.model.complete(self.messages, self.tools.to_openai())
            self._record(reply.to_message())

            if not reply.tool_calls:
                res.text = reply.content or ""
                break

            await self._execute_calls(reply.tool_calls, res)
        else:
            res.text = f"[stopped after {self.max_steps} steps]"

        stop = await self.hooks.emit(HookContext(Event.STOP, self.session_id, str(self.workdir), extra={"reply": res.text}))
        res.hook_trace += stop.trace
        self._pending_context += stop.injected
        if self.reflect_on_stop:
            res.facts_saved = await self._reflect_turn()
        return res

    # ---------- 工具执行（并行）----------

    async def _execute_calls(self, calls, res: TurnResult) -> None:
        """一次回复里的多个 tool_calls 并行执行，但结果按原顺序回填。

        规则：
        - 只读工具（policy.READ_ONLY）之间可以并行；
        - 会改状态的工具（写文件、shell、memory 写）**串行**，且排在只读之后 —— 两个 edit_file 同时改一个文件会互相覆盖；
        - 并发上限 `parallel_limit`；
        - asker（问用户）用锁串行化，不能同时弹两个问题。
        """
        from relay_harness.policy import READ_ONLY

        slots: list[dict | None] = [None] * len(calls)
        sem = asyncio.Semaphore(self.parallel_limit)

        async def one(i: int, tc) -> None:
            async with sem:
                slots[i] = await self._execute_one(tc, res)

        ro = [(i, tc) for i, tc in enumerate(calls) if tc.name in READ_ONLY]
        mut = [(i, tc) for i, tc in enumerate(calls) if tc.name not in READ_ONLY]
        if ro:
            await asyncio.gather(*(one(i, tc) for i, tc in ro))
        for i, tc in mut:
            await one(i, tc)
        for i, tc in enumerate(calls):
            m = slots[i] or {"content": "error: tool did not return", "tool_name": tc.name}
            self._record({"role": "tool", "tool_call_id": tc.id, "content": m["content"]}, tool_name=m["tool_name"])

    async def _execute_one(self, tc, res: TurnResult) -> dict:
        pre = await self.hooks.emit(HookContext(Event.PRE_TOOL_USE, self.session_id, str(self.workdir),
                                                tool_name=tc.name, tool_input=tc.arguments))
        res.hook_trace += pre.trace
        if not pre.allowed:
            res.denied.append({"tool": tc.name, "reason": pre.deny_reason})
            return {"content": f"error: tool call denied — {pre.deny_reason}", "tool_name": tc.name}
        args = pre.tool_input or tc.arguments
        output = await self.tools.call(tc.name, args)
        if output.startswith("__IMAGE__:"):
            # 工具返回了图片：tool 消息只放一句文字（tool 角色不能带图），图片作为多段 content 挂到下一条 user 消息
            import base64
            _, mime, name, b64 = output.split(":", 3)
            path = self._store_blob(mime, base64.b64decode(b64))
            self._pending_images.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
            output = f"[image `{name}` attached to your next message; stored at {path}]"
        res.tool_calls.append({"tool": tc.name, "args": args, "output": output[:200]})
        post = await self.hooks.emit(HookContext(Event.POST_TOOL_USE, self.session_id, str(self.workdir),
                                                 tool_name=tc.name, tool_input=args, tool_output=output))
        res.hook_trace += post.trace
        if post.injected:
            output += "\n\n" + "\n\n".join(post.injected)
        return {"content": output, "tool_name": tc.name}

    # ---------- 记忆维护 ----------

    async def _reflect_turn(self) -> int:
        # 只看本轮：从最后一条 user 消息开始
        last_user = max((i for i, m in enumerate(self.messages) if m["role"] == "user"), default=0)
        transcript = render_transcript(self.messages[last_user:])
        n, _ = await reflect(self.model, transcript, self.longterm, source=self.session_id)
        return n

    async def compact(self) -> CompactionResult:
        before = self.budget.usage(self.messages)
        old, recent = self.budget.split(self.messages)
        result = CompactionResult(summary="", dropped=len(old), before_tokens=before, after_tokens=before)
        if not old:
            return result

        pre = await self.hooks.emit(HookContext(Event.PRE_COMPACT, self.session_id, str(self.workdir),
                                                extra={"dropping": len(old), "tokens": before}))
        result.trace += pre.trace
        if not pre.allowed:
            result.trace.append(f"compaction vetoed: {pre.deny_reason}")
            return result

        transcript = render_transcript(old)
        # 先把事实救出来，再压缩 —— 摘要会丢细节，事实不能丢
        result.facts_saved, _ = await reflect(self.model, transcript, self.longterm, source=f"{self.session_id}:compact")
        resp = await self.model.complete(
            [{"role": "user", "content": SUMMARY_PROMPT.format(max_tokens=self.budget.summary_tokens, transcript=transcript)}], tools=None)
        result.summary = (resp.content or "").strip()

        system = [m for m in self.messages if m["role"] == "system"]
        self.messages = [*system, {"role": "user", "content": f"<compacted_history dropped_messages=\"{len(old)}\">\n{result.summary}\n</compacted_history>"},
                         {"role": "assistant", "content": "Understood, continuing from the summary."}, *recent]
        result.after_tokens = self.budget.usage(self.messages)
        self.episodic.set_summary(self.session_id, result.summary)
        return result

    async def connect_mcp(self, name: str, command: list[str], env: dict | None = None) -> int:
        """接一个 MCP server（stdio），它的工具以 mcp__<name>__<tool> 注册进 registry。返回工具数。"""
        from relay_harness.mcp import MCPClient
        client = MCPClient(name, command, env)
        n = await client.connect_and_register(self.tools)
        self._mcp.append(client)
        return n

    async def close(self) -> None:
        for c in self._mcp:
            await c.close()
        if self._bg:
            await asyncio.gather(*self._bg, return_exceptions=True)
        self.episodic.close()
