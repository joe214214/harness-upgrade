"""子 agent：把一个子任务交给一个**独立上下文**的 agent 跑，只把结论带回来。

为什么需要：主 agent 的上下文是稀缺资源。让它自己去翻 30 个文件找一个函数，
这 30 个文件的内容全进了主上下文，很快就要 compaction。
交给子 agent 去翻，主上下文只收到一句"在 foo.py:42"。这是 Claude Code subagent 的核心价值。

设计：
- 子 agent 与父共享 MEMORY.md 和情景库（同一个 .relay/），但 messages 完全独立；
- 子 agent 不做 reflect（父的 reflect 会看到子的结论）；
- 深度限制 max_depth，防止无限递归 spawn；
- 权限继承父的 mode；
- 多个 spawn_agent 出现在同一条回复里时，走并行工具调用 —— 子 agent 天然并行。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from relay_harness.core.loop import Agent

SUBAGENT_SYSTEM = """You are a sub-agent spawned for one focused task. Do it with tools, then reply with ONLY the result
the parent needs (findings, file paths, a diff summary). No preamble, no questions back — if blocked, say what blocked you."""


def install(parent: Agent) -> None:
    from relay_harness.core.loop import Agent

    @parent.tools.tool()
    async def spawn_agent(task: str, max_steps: int = 12) -> str:
        """Delegate a self-contained task to a sub-agent with its own context. Returns its final reply. Use for searches or investigations whose intermediate output you don't need."""
        child = Agent(parent.model, parent.workdir, state_dir=parent.state_dir,
                      session_id=f"{parent.session_id}.sub{len(parent.children)}",
                      mode=parent.policy.mode, asker=parent.policy.asker, reflect_on_stop=False,
                      max_steps=max_steps, home=parent.home, parallel_limit=parent.parallel_limit,
                      depth=parent.depth + 1, max_depth=parent.max_depth)
        # 父的 hook 也约束子：安全策略不能被 spawn 绕过
        for ev, regs in parent.hooks._hooks.items():
            for r in regs:
                if not r.name.startswith("policy:"):
                    child.hooks.on(ev, r.fn, priority=r.priority, name=r.name, matcher=r.matcher)
        parent.children.append(child)
        await child.start()
        child.messages[0]["content"] += "\n\n" + SUBAGENT_SYSTEM
        r = await child.run(task)
        await child.close()
        head = f"[sub-agent {child.session_id} · {r.steps} steps · {len(r.tool_calls)} tool calls"
        if r.denied:
            head += f" · {len(r.denied)} denied"
        return f"{head}]\n{r.text}"
