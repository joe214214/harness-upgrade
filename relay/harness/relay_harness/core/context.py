"""上下文预算与 compaction。

上下文窗口像一张桌子：东西越堆越多，最后没地方干活。
compaction 就是把桌上旧的东西拍张照（摘要）放桌角，实物收走。

顺序很重要（这是三家都强调的）：
  1. 先触发 PreCompact hook —— 让外部有机会把要丢的内容存去别处
  2. 把要丢的轮次先过一遍 reflect，抽出事实写进长期记忆 —— 摘要会丢细节，事实不能丢
  3. 用摘要替换旧轮次，保留最近 keep_recent 轮原文

token 计数用 tiktoken 有则用，没有就按 chars/3.5 估（中英混合的经验值）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

try:
    import tiktoken
    _enc = tiktoken.get_encoding("cl100k_base")
except Exception:  # pragma: no cover
    _enc = None


def count_tokens(text: str) -> int:
    if _enc is not None:
        return len(_enc.encode(text))
    return int(len(text) / 3.5) + 1


def message_tokens(msg: dict[str, Any]) -> int:
    n = 4
    c = msg.get("content")
    if isinstance(c, str):
        n += count_tokens(c)
    elif isinstance(c, list):
        for p in c:
            n += count_tokens(p.get("text", "")) if p.get("type") == "text" else 600   # 每图约 600 token
    for tc in msg.get("tool_calls") or []:
        n += count_tokens(tc.get("function", {}).get("arguments", "")) + 8
    return n


@dataclass
class ContextBudget:
    max_tokens: int = 32_000
    compact_at: float = 0.75       # 用到 75% 就压缩，留出回复空间
    keep_recent: int = 6           # 压缩时保留最近 N 条原文
    summary_tokens: int = 800

    def usage(self, messages: list[dict]) -> int:
        return sum(message_tokens(m) for m in messages)

    def needs_compaction(self, messages: list[dict]) -> bool:
        return self.usage(messages) > self.max_tokens * self.compact_at

    def split(self, messages: list[dict]) -> tuple[list[dict], list[dict]]:
        """返回 (要压缩的旧消息, 要保留的近期消息)。system 消息不算在内。"""
        body = [m for m in messages if m["role"] != "system"]
        if len(body) <= self.keep_recent:
            return [], body
        cut = len(body) - self.keep_recent
        # 不能在 assistant(tool_calls) 和它的 tool 结果之间切断，否则模型看到孤立的 tool 消息会困惑
        while cut < len(body) and body[cut]["role"] == "tool":
            cut += 1
        return body[:cut], body[cut:]


@dataclass
class CompactionResult:
    summary: str
    dropped: int
    before_tokens: int
    after_tokens: int
    facts_saved: int = 0
    trace: list[str] = field(default_factory=list)


SUMMARY_PROMPT = """You are compacting an agent's conversation to free context space.
Write a dense summary (max {max_tokens} tokens) of the conversation below, keeping:
- what the user asked for and any constraints they stated
- decisions made and why
- files touched, commands run, their outcomes
- unresolved problems and what was tried
Write it as terse bullet points. No preamble.

<conversation>
{transcript}
</conversation>"""


def render_transcript(messages: list[dict]) -> str:
    out = []
    for m in messages:
        role = m["role"]
        if role == "tool":
            out.append(f"[tool result] {str(m.get('content', ''))[:1500]}")
        elif m.get("tool_calls"):
            calls = "; ".join(f"{tc['function']['name']}({tc['function'].get('arguments', '')[:300]})" for tc in m["tool_calls"])
            out.append(f"[assistant → tools] {calls}")
        else:
            c = m.get("content", "")
            if isinstance(c, list):
                c = " ".join(p.get("text", "") if p.get("type") == "text" else "[image]" for p in c)
            out.append(f"[{role}] {str(c)[:2000]}")
    return "\n".join(out)
