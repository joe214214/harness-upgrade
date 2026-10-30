---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-30-co-canvas-message-source

[English](2026-10-30-co-canvas-message-source.md) | 中文

## 概述

新增仅用于标注来源的 dsh-co-canvas 消息来源类型，标记附在工具结果上、携带协同画布标注与控制权交还的用户消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-30-co-canvas-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-30-auxiliary-message-sources"
    after: "cf1fd2e53f5bf8fc5641d109d252fbecf43f241abf5d88f71be2d5f3828231b6"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-30-auxiliary-message-sources"
    after: "48c8055f631d58f8935e4cca52d45827f48d9b8959964dbd9492f74db0b47b76"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-30-auxiliary-message-sources"
    after: "ea8eef916aa8891c776d8f6cf0fc9674a980785f4a1b18c7fd8c3d9c51b58550"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-30-auxiliary-message-sources"
    after: "50c2e7a07cadfd1dc834e8cf0dc42eced0a9e90699ff3c5067cddb112b1c83a8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该类型以 @persistenceAttribution 声明：消息是带文字与图片块的普通用户消息，没有协同画布插件的读取方原样保留它，任何读取方（包括写入方）都不会为回放、校验或权限读取这个类型。已有记录不受影响，因为没有修改任何已有变体。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/co-canvas：7 个测试通过，包括经真实工具执行器在下一个工具结果中送达已定位的标注与控制权交还。

<a id="dev-note"></a>
## 开发备注

无。
