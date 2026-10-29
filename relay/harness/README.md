# Relay Harness

An agent runtime on top of the Relay gateway (or any OpenAI-compatible endpoint): the loop that turns model text into tool calls, plus the three things that make an agent usable for more than one session — **hooks**, **tiered memory**, and **compaction**.

Borrowed deliberately: Claude Code's hook events and `settings.json` format, Hermes' idea that the agent maintains a *size-capped* memory file itself, Codex's `AGENTS.md` discovery and approval modes.

```
python -m relay_harness.cli --mode suggest --api-key rly_…      # REPL against Relay on :8000
```

## Hooks

Six events, same names as Claude Code so existing hook scripts work unchanged:

| event | fires | can |
|---|---|---|
| `SessionStart` | once per session | inject context (git status, env facts) |
| `UserPromptSubmit` | every prompt | deny (secret scanning), inject |
| `PreToolUse` | before each tool | **deny**, **modify input**, inject |
| `PostToolUse` | after each tool | inject (lint results, test output) |
| `PreCompact` | before context compaction | deny, inject |
| `Stop` | after the reply | inject into next turn |

Python hooks are decorated functions; shell hooks come from `.relay/settings.json` and speak JSON on stdin — exit 2 denies, stdout JSON with `tool_input` modifies, plain stdout injects. Hooks run in priority order; the permission policy is itself a `PreToolUse` hook at priority 0, so your hooks can run before or after it.

```python
@agent.hooks.hook(Event.PRE_TOOL_USE, matcher="bash", priority=10)
def soften(ctx):
    cmd = ctx.tool_input["command"]
    if cmd.startswith("rm -r "):
        return Modify({**ctx.tool_input, "command": cmd.replace("rm -r ", "rm -ri ")}, "interactive rm")
    return Continue()
```

See `examples/settings.json` and `examples/hooks/` for a bash guard, a post-write linter and a git-context injector.

## Memory — three tiers, three jobs

| tier | what | where | lifetime |
|---|---|---|---|
| **procedural** | how to work here: `AGENTS.md` / `CLAUDE.md`, discovered from cwd upward plus `~/.relay/AGENTS.md`, nearest last | files you write | forever |
| **semantic** | what's true: `MEMORY.md`, sectioned facts, **8 KB hard cap** | `.relay/MEMORY.md` | until consolidated |
| **episodic** | what happened: every turn of every session, FTS5-indexed | `.relay/episodic.db` | forever, searchable via `recall` |

The cap is the point. When `memory_write` fails with *"Consolidate first"*, the agent has to merge, prune and compress — which is exactly the curation an unbounded store never forces. Facts carry a source (session id) so you can trace where a belief came from.

Two things write to semantic memory without being asked:

- **Reflect pass** after each turn: the model reads the turn and returns a JSON array of durable facts (user preferences, project conventions, decisions). Anything that isn't clean JSON is discarded — a model saying "I cannot help with that" never ends up in `MEMORY.md`.
- **Compaction** (below) reflects the messages it is about to drop *before* summarising them, because a summary loses details and facts must not.

## Compaction

When context passes 75% of budget: `PreCompact` hook → reflect the old messages into memory → replace them with a model-written summary → keep the last N messages verbatim. The split never lands between an assistant tool call and its tool result. The summary is also stored on the session row so `/sessions` can show it.

## Permissions

`suggest` (read-only auto, everything else asks) · `auto-edit` (file writes auto, shell asks) · `full-auto`. Plus explicit `allow`/`deny` sets. Without an asker, "ask" resolves to deny — safe by default in non-interactive runs.

## Tools

`read_file` · `list_dir` · `write_file` · `edit_file` (exact-match, must be unique) · `bash` (timeout, truncated output) · `memory_read` / `memory_write` / `memory_replace` · `recall`. All file paths are resolved inside the working directory; traversal is rejected.

## Parallel tool calls

When the model returns several tool calls at once, read-only ones run concurrently (bounded by `parallel_limit`); anything that mutates state — file writes, shell, memory writes — runs serially and after the reads, because two concurrent `edit_file`s on one file overwrite each other. Results are appended in call order regardless. Permission prompts are serialised with a lock: the user is never asked two things at once.

## Sub-agents

`spawn_agent(task)` runs a child `Agent` with its own message context, sharing `MEMORY.md` and the episodic store. The parent only receives the child's final reply, so a 30-file search costs the parent one line of context instead of thirty files. Parent hooks are copied into the child (policy is re-installed for the child's mode), so a deny rule can't be bypassed by delegating. `max_depth` stops recursive spawning: a child at the limit simply doesn't have the `spawn_agent` tool. Several `spawn_agent` calls in one reply run in parallel.

## MCP

`await agent.connect_mcp("github", ["npx", "-y", "@modelcontextprotocol/server-github"])` launches an MCP server over stdio and registers its tools as `mcp__github__<tool>`, using the server's own `inputSchema`. The client is ~100 lines of JSON-RPC (`initialize` → `initialized` → `tools/list` → `tools/call`) with no dependency on the official SDK. MCP tools go through the same `PreToolUse`/`PostToolUse` hooks as built-ins, so `matcher: "mcp__github__create_issue"` works. `examples/mcp_kv_server.py` is a zero-dependency server used as the test fixture.

## Testing

`ScriptedModel` plays back a fixed sequence of replies and tool calls, so every harness behaviour — hook ordering, denial, injection, compaction, reflect, recall across sessions, resume — is a deterministic unit test with no model in the loop. 23 tests, under a second.

## Layout

```
relay_harness/
  core/events.py     HookBus, six events, Python + shell hooks, settings.json loader
  core/context.py    token budget, compaction split, summary prompt
  core/loop.py       Agent: start / run / compact / resume
  memory/instructions.py   AGENTS.md discovery and rendering
  memory/longterm.py       capped MEMORY.md with sections, dedupe, replace
  memory/episodic.py       SQLite + FTS5 session store, recall
  memory/reflect.py        fact extraction prompt + strict parser
  tools/base.py      registry, JSON schema from type hints
  tools/builtin.py   file / shell / memory / recall tools
  policy.py          suggest / auto-edit / full-auto as a priority-0 PreToolUse hook
  model.py           OpenAICompatibleModel, ScriptedModel
  subagent.py        spawn_agent tool, hook inheritance, depth limit
  mcp.py             MCP stdio client, tool registration
  cli.py             REPL with /memory /recall /compact /hooks /sessions /resume
```
