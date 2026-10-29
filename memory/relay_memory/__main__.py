"""`python -m relay_memory serve --root DIR` starts the stdio server.

`python -m relay_memory show --root DIR` prints MEMORY.md and store sizes.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from relay_memory.llm import ChatClient
from relay_memory.server import MemoryServer


def main() -> None:
    ap = argparse.ArgumentParser(prog="relay_memory")
    ap.add_argument("command", choices=["serve", "show"])
    ap.add_argument("--root", type=Path, default=Path(os.getenv("RELAY_MEMORY_ROOT", Path.home() / ".relay-memory")))
    ap.add_argument("--cap-bytes", type=int, default=8_000)
    ap.add_argument("--no-reflect", action="store_true", help="store turns but never call the model")
    a = ap.parse_args()

    if a.command == "show":
        srv = MemoryServer(a.root, cap_bytes=a.cap_bytes)
        print(srv.longterm.read() or "(memory is empty)")
        print(json.dumps(srv.handle({"id": 1, "method": "relay/status"})["result"]))
        return
    model = None if a.no_reflect else ChatClient()
    MemoryServer(a.root, model=model, cap_bytes=a.cap_bytes).serve()


if __name__ == "__main__":
    main()
