"""Reflect pass：从一段对话里抽出"值得长期记住的事实"。

这是你和我之间那套记忆系统的同一个原理：对话结束后有一个后台过程重读对话，
只挑**用户明确说过、且一个月后还成立**的东西写进去。
标准刻意严：偏好、身份、项目结构、决策、约束 —— 进；本轮的临时状态、我的建议、搜到的东西 —— 不进。

输出是 JSON 数组，每条 {section, fact}。模型不听话输出了别的，就按空处理，绝不把垃圾写进 MEMORY.md。
"""

from __future__ import annotations

import json
import re
from typing import Any

from relay_harness.memory.longterm import LongTermMemory, MemoryFull

REFLECT_PROMPT = """Review the conversation and extract facts worth remembering across future sessions.

Include ONLY things that are durable (still true in a month) and stated by the user or established by a decision:
- user preferences and working style ("prefers X", "always do Y")
- project facts: architecture, conventions, key file locations, constraints
- decisions and their reasons
Exclude: transient task state, your own suggestions the user didn't adopt, anything already in <existing_memory>.

Return a JSON array, nothing else. Each item: {{"section": "user"|"project"|"decisions", "fact": "<one line>"}}.
Return [] if nothing qualifies.

<existing_memory>
{existing}
</existing_memory>

<conversation>
{transcript}
</conversation>"""


def parse_facts(text: str) -> list[dict[str, str]]:
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return []
    out = []
    for item in data if isinstance(data, list) else []:
        if isinstance(item, dict) and isinstance(item.get("fact"), str) and item["fact"].strip():
            sec = str(item.get("section") or "general").strip().lower()
            if sec not in ("user", "project", "decisions", "general"):
                sec = "general"
            out.append({"section": sec, "fact": item["fact"].strip()[:300]})
    return out[:20]


async def reflect(model: Any, transcript: str, memory: LongTermMemory, source: str) -> tuple[int, str | None]:
    """返回 (写入条数, 错误信息)。MemoryFull 不算失败 —— 那是留给 agent 下次整理的信号。"""
    prompt = REFLECT_PROMPT.format(existing=memory.read() or "(empty)", transcript=transcript)
    resp = await model.complete([{"role": "user", "content": prompt}], tools=None)
    facts = parse_facts(resp.content or "")
    written = 0
    for f in facts:
        try:
            before = memory.size()
            memory.append(f["section"], f["fact"], source)
            if memory.size() != before:
                written += 1
        except MemoryFull as e:
            return written, str(e)
    return written, None
