---
description: "Cross-Session long-term memory: a size-capped MEMORY.md the agent curates, FTS5 episodic recall over past Sessions, and a post-turn reflect pass, built on system-prompt context, tools, and agent/turn-stopping, for users and maintainers enabling or debugging memory."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

`dsh-memory` gives every Session a memory of earlier ones. Durable facts, such as preferences, conventions, and decisions, live in a MEMORY.md with an 8 KB cap that the agent keeps curated, and that file is placed in every request. Every turn, including transcripts produced by `read_audio` and `read_video`, is indexed for `recall`. After each turn a reflect pass files new facts on its own, so memory fills even when the model forgets to save. It changes no agent-loop code.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin; it needs the tool registry and system prompt, and uses the LLM runtime for reflection when one is mounted.

### Minimal configuration

```yaml
- insert:
    - id: memory
      name: '@deepseek-ai/dsh-memory'
      config:
        root: /home/me/.dsh-memory/my-project
```

| Field | Default | Meaning |
|---|---|---|
| `root` | `~/.dsh-memory` | Directory holding `MEMORY.md` and `episodic.db`; one root per project keeps projects apart |
| `capBytes` | `8000` | MEMORY.md byte cap |
| `reflect` | `true` | Run the reflect pass after each turn |
| `reflectMaxTokens` | `1024` | Output cap of one reflect request |
| `reflectTimeoutMs` | `60000` | Deadline of one reflect request |
| `recallLimit` | `8` | Hits returned by one recall |
| `maxToolChars` | `1500` | Clip length for ordinary tool results stored for recall; media transcripts are stored whole |

### Three tiers

| Tier | Holds | Written by |
|---|---|---|
| MEMORY.md | Durable facts in `user`, `project`, `decisions` sections, each tagged with its Session | `memory_write`, the reflect pass, `memory_replace`, `memory_rewrite` |
| episodic.db | Every turn of every Session, FTS5-indexed | The turn-stopping listener |
| Reflect | Facts extracted from the finished turn | One auxiliary request per turn on the agent's route |

The cap is deliberate: when a write would exceed it, the write fails with an instruction to consolidate, so the agent merges, prunes, and compresses instead of accumulating.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### Extension points

- `ctx.systemPrompt.context` renders MEMORY.md, without source tags, as runtime context on every request; the provider reads the file each time, so a write is visible on the next request.
- `ctx.tools` registers `memory_read`, `memory_write`, `memory_replace`, `memory_rewrite`, and `recall`.
- `agent/turn-stopping` derives the Session's messages, keeps those not yet stored, projects them into turns (system prompts and runtime context dropped, ordinary tool results clipped), appends them to SQLite, and runs the reflect pass.

### Reflect parsing

The reflect answer is accepted only as a JSON array of `{section, fact}`; a markdown fence is tolerated, anything else yields no facts. Unknown sections become `general`, and at most 20 facts are taken. A full memory or a failed request never fails the user's turn.

### Storage

MEMORY.md is written atomically (temporary file, then rename). The episodic store uses `node:sqlite` with an external-content FTS5 table kept in sync by an insert trigger; queries quote every word so user punctuation is never parsed as FTS syntax.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, config, tools, context, turn-stopping listener, reflect request |
| [`src/longterm.ts`](src/longterm.ts) | Capped MEMORY.md |
| [`src/episodic.ts`](src/episodic.ts) | SQLite + FTS5 store |
| [`src/reflect.ts`](src/reflect.ts) | Reflect prompt and strict parser |
| [`src/turns.ts`](src/turns.ts) | Message-to-turn projection |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [User guide: third-party memory MCP servers](../../../docs/user/guide/mcp-memory.md) — the MCP alternatives this package can be compared with.
- [tool-read-audio](../../experimental/tool-read-audio/README.md) — transcripts this package stores for recall.

-----

<a id="model-experience"></a>
## Model Experience

### Memory context

#### What the model sees

A runtime-context entry made of the fixed guidance below followed by `<memory size="N/CAP bytes">` and the MEMORY.md sections, or `<memory>(empty)</memory>`.

##### Verbatim guidance

```markdown
You have a long-term memory that persists across sessions.
- Facts in <memory> were saved in earlier sessions; rely on them.
- When the user states a durable preference, convention or decision, save it with memory_write.
- If memory_write reports memory is full, consolidate with memory_rewrite, then retry.
- When the user refers to earlier work, recordings or documents that are not in <memory>, search past sessions with recall.
```

#### Token effect

Bounded by `capBytes` plus the fixed guidance, on every request.

#### KV Cache effect

The entry is part of the runtime-context snapshot, so a memory change replaces that snapshot on the next request and invalidates reuse from that point; unchanged memory keeps it stable.

### Tool schemas

#### What the model sees

The generated [memory tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-memory): `memory_read`, `memory_write` (`section` enum and `fact`), `memory_replace` (`old`, `new`), `memory_rewrite` (`text`), and `recall` (`query`).

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged.

### Reflect request

#### What the model sees

An auxiliary request on the agent's route, outside the Session's context: a fixed system prompt asking for a JSON array of durable facts, and one user message with the current MEMORY.md and the finished turn.

#### Token effect

One request per turn with new messages, capped by `reflectMaxTokens` output; disabled with `reflect: false`.

#### KV Cache effect

Independent of the Session's requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One memory per root** — projects are separated by configuring a different `root`; there is no automatic per-workspace scoping.
- **Keyword recall only** — FTS5 matches words, not meaning; there is no embedding search.
- **Reflect requests are not logged in the Session** — only their effect on MEMORY.md is visible, in the next runtime-context snapshot.
- **No compaction hook yet** — facts in turns dropped by compaction are kept only if the reflect pass already filed them after that turn.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
