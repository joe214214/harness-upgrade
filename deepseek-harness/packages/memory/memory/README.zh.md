---
description: "跨 Session 长期记忆：agent 自己整理的有上限 MEMORY.md、对历史 Session 的 FTS5 情景检索，以及轮次结束后的 reflect，基于系统提示上下文、工具与 agent/turn-stopping 构建，供启用或调试记忆的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

[English](README.md) | 中文

## 概述

`dsh-memory` 让每个 Session 都记得之前的 Session。偏好、约定、决策等长期事实保存在一个有 8 KB 上限、由 agent 自己整理的 MEMORY.md 中，并出现在每次请求里。每一轮对话，包括 `read_audio` 与 `read_video` 生成的转写，都会被索引以供 `recall` 检索。每轮结束后，reflect 会自行归档新事实，即使模型忘了保存，记忆也会被填上。它不改动任何 agent loop 代码。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载插件即可；它需要工具注册表与系统提示，并在挂载了 LLM 运行时的情况下用它做 reflect。

### 最小配置

```yaml
- insert:
    - id: memory
      name: '@deepseek-ai/dsh-memory'
      config:
        root: /home/me/.dsh-memory/my-project
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `~/.dsh-memory` | 存放 `MEMORY.md` 与 `episodic.db` 的目录；每个项目一个 root 即可互相隔离 |
| `capBytes` | `8000` | MEMORY.md 字节上限 |
| `reflect` | `true` | 每轮结束后运行 reflect |
| `reflectMaxTokens` | `1024` | 一次 reflect 请求的输出上限 |
| `reflectTimeoutMs` | `60000` | 一次 reflect 请求的时限 |
| `recallLimit` | `8` | 一次 recall 返回的命中数 |
| `maxToolChars` | `1500` | 存入检索库的普通工具结果截断长度；媒体转写完整保存 |

### 三层记忆

| 层 | 保存什么 | 由谁写入 |
|---|---|---|
| MEMORY.md | `user`、`project`、`decisions` 分节的长期事实，每条标注来源 Session | `memory_write`、reflect、`memory_replace`、`memory_rewrite` |
| episodic.db | 每个 Session 的每一轮，FTS5 索引 | turn-stopping 监听器 |
| Reflect | 从刚结束的一轮中提取的事实 | 每轮一次、使用 agent 路由的辅助请求 |

上限是刻意设计的：写入会超限时直接失败并提示先整理，agent 只能合并、删旧、压缩，而不是一味堆积。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 扩展点

- `ctx.systemPrompt.context` 在每次请求中把去掉来源标注的 MEMORY.md 渲染为运行时上下文；提供函数每次都读取文件，所以写入在下一次请求即可见。
- `ctx.tools` 注册 `memory_read`、`memory_write`、`memory_replace`、`memory_rewrite` 与 `recall`。
- `agent/turn-stopping` 派生 Session 的消息，取出尚未保存的部分投影为轮次（丢弃系统提示与运行时上下文，截断普通工具结果），写入 SQLite，并运行 reflect。

### Reflect 解析

只接受 `{section, fact}` 组成的 JSON 数组作为 reflect 答案；容忍 markdown 代码围栏，其余任何内容都不产生事实。未知分节归入 `general`，最多取 20 条。记忆已满或请求失败都不会让用户这一轮失败。

### 存储

MEMORY.md 原子写入（先写临时文件再重命名）。情景库使用 `node:sqlite` 与外部内容 FTS5 表，由插入触发器保持同步；查询会给每个词加引号，用户输入的标点不会被当作 FTS 语法。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、配置、工具、上下文、turn-stopping 监听器、reflect 请求 |
| [`src/longterm.ts`](src/longterm.ts) | 有上限的 MEMORY.md |
| [`src/episodic.ts`](src/episodic.ts) | SQLite + FTS5 存储 |
| [`src/reflect.ts`](src/reflect.ts) | reflect 提示与严格解析 |
| [`src/turns.ts`](src/turns.ts) | 消息到轮次的投影 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [用户指南：第三方记忆 MCP 服务](../../../docs/user/guide/mcp-memory.zh.md) — 可与本包对比的 MCP 方案。
- [tool-read-audio](../../experimental/tool-read-audio/README.zh.md) — 本包存入检索库的转写来源。

-----

<a id="model-experience"></a>
## 模型体验

### 记忆上下文

#### 模型看到什么

一条运行时上下文：下面的固定指引，后接 `<memory size="N/CAP bytes">` 与 MEMORY.md 的各节，或 `<memory>(empty)</memory>`。

##### 指引原文

```markdown
You have a long-term memory that persists across sessions.
- Facts in <memory> were saved in earlier sessions; rely on them.
- When the user states a durable preference, convention or decision, save it with memory_write.
- If memory_write reports memory is full, consolidate with memory_rewrite, then retry.
- When the user refers to earlier work, recordings or documents that are not in <memory>, search past sessions with recall.
```

#### Token 影响

每次请求不超过 `capBytes` 加固定指引。

#### KV Cache 影响

这条上下文属于运行时上下文快照，记忆变化会在下一次请求时替换该快照，并使从该位置起的复用失效；记忆不变时保持稳定。

### 工具 schema

#### 模型看到什么

生成的[记忆工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-memory)：`memory_read`、`memory_write`（`section` 枚举与 `fact`）、`memory_replace`（`old`、`new`）、`memory_rewrite`（`text`）与 `recall`（`query`）。

#### Token 影响

工具可见的每次请求都有固定的 schema 成本。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

### Reflect 请求

#### 模型看到什么

一次在 agent 路由上、位于 Session 上下文之外的辅助请求：要求返回长期事实 JSON 数组的固定系统提示，以及一条包含当前 MEMORY.md 与刚结束一轮内容的用户消息。

#### Token 影响

每个产生新消息的轮次一次请求，输出受 `reflectMaxTokens` 限制；`reflect: false` 时关闭。

#### KV Cache 影响

与 Session 的请求相互独立。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每个 root 一份记忆** — 项目之间靠配置不同的 `root` 隔离；没有按工作区自动划分。
- **只有关键词检索** — FTS5 匹配词语而非语义；没有 embedding 检索。
- **reflect 请求不记入 Session 日志** — 只有它对 MEMORY.md 的影响可见，体现在下一次运行时上下文快照中。
- **尚未接入压缩** — 被压缩丢弃的轮次中的事实，只有在该轮之后已被 reflect 归档时才会保留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
