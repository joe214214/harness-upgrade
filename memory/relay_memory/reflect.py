"""Reflect pass: extract facts worth keeping from one turn of conversation.

The bar is deliberately high: preferences, identity, project structure,
decisions and constraints go in; transient task state, the agent's own
unadopted suggestions and search results stay out.

The model returns a JSON array of {section, fact}. Anything else is treated
as empty, so a refusal or a chatty reply never lands in MEMORY.md.
"""

from __future__ import annotations

import json
import re
from typing import Protocol

from relay_memory.longterm import LongTermMemory, MemoryFull

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

SECTIONS = ("user", "project", "decisions", "general")


class Completer(Protocol):
    def complete(self, prompt: str, max_tokens: int = ...) -> str: ...


def parse_facts(text: str) -> list[dict[str, str]]:
    m = re.search(r"\[.*\]", text, re.DOTALL)
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
            out.append({"section": sec if sec in SECTIONS else "general", "fact": item["fact"].strip()[:300]})
    return out[:20]


def reflect(model: Completer, transcript: str, memory: LongTermMemory, source: str) -> tuple[int, str | None]:
    """Return (facts written, error). MemoryFull is not a failure: it tells the agent to consolidate."""
    prompt = REFLECT_PROMPT.format(existing=memory.read() or "(empty)", transcript=transcript)
    facts = parse_facts(model.complete(prompt))
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
