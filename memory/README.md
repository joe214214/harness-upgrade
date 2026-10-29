# Relay Memory

Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), which ships without one: its docs only point to third-party memory MCP servers. Relay Memory adds three tiers and keeps them current without the model having to remember to save anything.

| tier | what | where |
|---|---|---|
| semantic | durable facts in sections (`user` / `project` / `decisions`), **8 KB hard cap** | `<root>/MEMORY.md` |
| episodic | every turn of every session, FTS5-indexed, searchable with `recall` | `<root>/episodic.db` |
| reflect | after each turn the model extracts durable facts from that turn; anything that is not a clean JSON array is discarded | — |

The cap is deliberate. When `memory_write` fails with *"Consolidate first"*, the agent must merge, prune and compress with `memory_rewrite`: an unbounded store never forces that curation.

## How it plugs into dsh

```
dsh process                                   python -m relay_memory serve
┌──────────────────────────────┐   JSON-RPC   ┌──────────────────────────────┐
│ plugin/relay-memory.mjs      │◀── stdio ───▶│ server.py (MCP + relay/*)    │
│  systemPrompt.context ◀──────┼─ relay/context│  longterm.py   MEMORY.md     │
│  tools.register ─────────────┼─ tools/call ─▶│  episodic.py   episodic.db   │
│  agent/turn-stopping ────────┼─ relay/ingest▶│  reflect.py ─▶ DeepSeek API  │
└──────────────────────────────┘              └──────────────────────────────┘
```

The plugin is a ~200-line bridge on three documented dsh extension points; all memory logic is Python. The server also speaks plain MCP (`initialize`, `tools/list`, `tools/call`), so any MCP client can use the tools.

Why a native plugin and not dsh's Claude Code hook bridge: the bridge is not in the published `dsh` package, and its `Stop` payload carries no transcript (`transcript_path` is always empty), so a hook could never see what to reflect on.

## Use

```yaml
# relay-memory.yml
- insert:
    - id: relay-memory
      name: '/absolute/path/to/memory/plugin/relay-memory.mjs'
      config:
        root: '/absolute/path/to/memory-store'   # default ~/.relay-memory
        # reflect: false        store turns, never call the model
        # capBytes: 8000
        # python: python3
```

```sh
export DEEPSEEK_API_KEY=sk-...          # used by the reflect pass
dsh headless --patch ./relay-memory.yml "remember: we use ruff, not flake8"
dsh headless --patch ./relay-memory.yml "which linter do we use?"   # answers from memory, no tool calls
python -m relay_memory show --root /absolute/path/to/memory-store
```

Reflect uses any OpenAI-compatible endpoint: `RELAY_MEMORY_BASE_URL` (default `https://api.deepseek.com`), `RELAY_MEMORY_MODEL` (default `deepseek-flash`), `RELAY_MEMORY_API_KEY` or `DEEPSEEK_API_KEY`. Pointing it at the Relay gateway runs reflect on your own GPU.

## Test

```sh
cd memory && python -m pytest -q                       # server, storage, reflect parsing
node --test memory/plugin/relay-memory.test.mjs        # plugin, including a round trip to the real server
```

## Layout

```
relay_memory/server.py     JSON-RPC/MCP stdio server
relay_memory/longterm.py   capped MEMORY.md with sections, dedupe, replace
relay_memory/episodic.py   SQLite + FTS5 session store
relay_memory/reflect.py    fact extraction prompt + strict parser
relay_memory/llm.py        OpenAI-compatible client with retries
plugin/relay-memory.mjs    dsh plugin
```
