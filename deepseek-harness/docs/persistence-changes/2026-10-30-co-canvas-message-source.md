---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-30-co-canvas-message-source

English | [中文](2026-10-30-co-canvas-message-source.zh.md)

## Summary

Adds the attribution-only dsh-co-canvas message source kind, which marks user messages that carry co-canvas marks and control handbacks attached to a tool result.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The kind is declared with @persistenceAttribution: the message is an ordinary user message with text and image blocks, readers without the co-canvas plugin preserve it unchanged, and no reader, including the producer, reads the kind for replay, validation, or authority. Existing records are unaffected because no existing variant changed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/co-canvas: 7 tests passed, including delivery of a grounded mark and a handback with the next tool result through the real tool executor.

<a id="dev-note"></a>
## Dev Note

None.
