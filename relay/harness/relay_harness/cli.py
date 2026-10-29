"""REPL。

  python -m relay_harness.cli [--mode suggest|auto-edit|full-auto] [--resume SESSION_ID] [--model-url URL --api-key KEY]
斜杠命令：/memory  /recall <q>  /compact  /hooks  /sessions  /resume <id>  /quit
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

from relay_harness.core.loop import Agent
from relay_harness.model import OpenAICompatibleModel
from relay_harness.policy import Mode


async def ask_in_terminal(tool: str, args: dict) -> bool:
    preview = json.dumps(args, ensure_ascii=False)[:200]
    ans = await asyncio.to_thread(input, f"  ⚠ allow {tool}({preview})? [y/N] ")
    return ans.strip().lower() in ("y", "yes")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="suggest", choices=[m.value for m in Mode])
    ap.add_argument("--resume")
    ap.add_argument("--model-url", default=os.getenv("RELAY_HARNESS_MODEL_URL", "http://localhost:8000/v1"))
    ap.add_argument("--api-key", default=os.getenv("RELAY_HARNESS_API_KEY", ""))
    ap.add_argument("--model", default=os.getenv("RELAY_HARNESS_MODEL", "default"))
    ap.add_argument("--no-reflect", action="store_true")
    a = ap.parse_args()

    model = OpenAICompatibleModel(a.model_url, a.api_key, a.model)
    agent = Agent(model, Path.cwd(), mode=Mode(a.mode), asker=ask_in_terminal, reflect_on_stop=not a.no_reflect)

    settings = agent.state_dir / "settings.json"
    if settings.is_file():
        n = agent.hooks.load_settings(json.loads(settings.read_text()))
        print(f"loaded {n} shell hook(s) from {settings}")
    if a.resume:
        n = await agent.resume(a.resume)
        print(f"resumed session {a.resume} ({n} messages)")
    else:
        await agent.start()
    print(f"relay harness · session {agent.session_id} · mode {a.mode} · memory {agent.longterm.size()}/{agent.longterm.cap_bytes} B")

    while True:
        try:
            line = await asyncio.to_thread(input, "\n› ")
        except (EOFError, KeyboardInterrupt):
            break
        line = line.strip()
        if not line:
            continue
        if line in ("/quit", "/exit"):
            break
        if line == "/memory":
            print(agent.longterm.read() or "(empty)")
            continue
        if line.startswith("/recall "):
            print(await agent.tools.call("recall", {"query": line[8:]}))
            continue
        if line == "/compact":
            c = await agent.compact()
            print(f"compacted {c.dropped} msgs, {c.before_tokens}→{c.after_tokens} tokens, {c.facts_saved} facts saved")
            continue
        if line == "/hooks":
            print(json.dumps(agent.hooks.registered(), indent=2))
            continue
        if line == "/sessions":
            for s in agent.episodic.recent_sessions():
                print(f"  {s['id']}  {s['title'] or ''}  {(s['summary'] or '')[:60]}")
            continue
        if line.startswith("/resume "):
            n = await agent.resume(line[8:].strip())
            print(f"resumed ({n} messages)")
            continue

        r = await agent.run(line)
        for tc in r.tool_calls:
            print(f"  ▸ {tc['tool']} {json.dumps(tc['args'], ensure_ascii=False)[:100]}")
        for d in r.denied:
            print(f"  ✗ {d['tool']}: {d['reason']}")
        for c in r.compactions:
            print(f"  ⇣ compacted {c.dropped} msgs ({c.before_tokens}→{c.after_tokens} tok)")
        print(f"\n{r.text}")
        if r.facts_saved:
            print(f"  ✎ {r.facts_saved} fact(s) saved to memory")

    await agent.close()
    await model.aclose()


if __name__ == "__main__":
    asyncio.run(main())
