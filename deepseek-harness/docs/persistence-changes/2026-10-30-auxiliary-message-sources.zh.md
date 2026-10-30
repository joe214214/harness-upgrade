---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-30-auxiliary-message-sources

[English](2026-10-30-auxiliary-message-sources.md) | 中文

## 概述

新增 dsh-memory-reflect 与 dsh-vision-bridge 两种消息来源类型，供 memory 与 vision-bridge 插件的辅助模型请求使用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-30-auxiliary-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "24a3b57f45370c07a606757e70fab3829d1d0074f43936bdd1621ccd9064d3ed"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e100ece4f57111b086934a18e9dc3acdcd423beca7e85ef6e7e2c0c853507ac0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "424ca79d08a0be424f46ec03e1d8d70593a12b735efe14c0efd8261e376dd598"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "803c4dc118ff6cc385d2dc861932ed044aa897cd6894554fd0c93c2131784314"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两种类型都只标记为辅助请求构造的用户消息（memory 的 reflect 与 ask_image）；两个插件都不会把它们追加到 Session，因此没有任何持久化记录携带它们，现有读取方不会遇到。现有变体均未改变，当前读取方仍接受所有已有记录。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/memory packages/multimodal：3 个测试文件通过（memory 11 个、vision-bridge 2 个、read_document 与 media-core 共 25 个测试）。

<a id="dev-note"></a>
## 开发备注

无。
