---
description: "The memory group map: cross-Session long-term memory with a capped fact file, episodic recall, and a reflect pass, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/memory

English | [中文](README.zh.md)

## Summary

The memory group lets agents carry knowledge across Sessions. Durable facts live in a size-capped file the agent curates and that every request sees; every turn is indexed for keyword recall; and a reflect pass after each turn files new facts without the model having to remember to save them. It is one product package built on documented extension points and changes no agent-loop code.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`memory`](memory/README.md) | MEMORY.md with a byte cap, FTS5 episodic recall, post-turn reflect, and the memory tools | registers on `ctx.tools` and `ctx.systemPrompt` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Third-party memory MCP servers](../../docs/user/guide/mcp-memory.md) — the MCP-based alternatives.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-memory) — the memory tool schemas.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
