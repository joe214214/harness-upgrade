---
description: "memory 组导览：带上限事实文件、情景检索与 reflect 的跨 Session 长期记忆，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/memory

[English](README.md) | 中文

## 概述

memory 组让 agent 跨 Session 保留知识。长期事实保存在一个由 agent 自己整理、有大小上限且每次请求都能看到的文件中；每一轮都会被索引以供关键词检索；每轮结束后的 reflect 会自行归档新事实，不依赖模型记得保存。它是一个基于已文档化扩展点的产品包，不改动任何 agent loop 代码。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`memory`](memory/README.zh.md) | 有字节上限的 MEMORY.md、FTS5 情景检索、轮次结束后的 reflect，以及记忆工具 | 注册到 `ctx.tools` 与 `ctx.systemPrompt` |

-----

<a id="related-documentation"></a>
## 相关文档

- [第三方记忆 MCP 服务](../../docs/user/guide/mcp-memory.zh.md) — 基于 MCP 的替代方案。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-memory) — 记忆工具的 schema。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
