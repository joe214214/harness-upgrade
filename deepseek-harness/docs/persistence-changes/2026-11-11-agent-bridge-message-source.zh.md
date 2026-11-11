---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-agent-bridge-message-source

[English](2026-11-11-agent-bridge-message-source.md) | 中文

## 概述

新增仅用于归属的 dsh-agent-bridge 消息来源类型，用来标记把其他编程 Agent 的会话转发进 Session 的用户消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-agent-bridge-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-30-co-canvas-message-source"
    after: "4ea67a4dd6aeb121a981f37e3d2b94ff06d5fa9a64d16b295c6b77637262221f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-30-co-canvas-message-source"
    after: "71515ba0574ccb67fe71d5d641f9176e885f6bdc0f5070e1cbe5fa37f88197ce"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-30-co-canvas-message-source"
    after: "5adec80112ebc283460eaa0ca6b96e539e77c2d4a373164dfff865e20cab5776"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-30-co-canvas-message-source"
    after: "7d7132c6faea9f07dc7b1a5c6dbb5b5a2b17c9083da5bd531647a0421bc528c2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录不变。该类型是新的归属选项，带转发形式和发送方标签；不认识它的读取方把消息当作普通的用户角色上下文消息，写入方也从不回读该类型。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-bridge：14 个测试通过，其中包括带此来源的转发更新。

<a id="dev-note"></a>
## 开发备注

无。
