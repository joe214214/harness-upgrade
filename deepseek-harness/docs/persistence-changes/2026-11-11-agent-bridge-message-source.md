---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-agent-bridge-message-source

English | [中文](2026-11-11-agent-bridge-message-source.zh.md)

## Summary

Adds the attribution-only dsh-agent-bridge message source kind, which marks user messages that relay another coding agent's session into a Session.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records are unchanged. The kind is a new attribution alternative carrying the relay form and a sender label; readers that do not know it treat the message as an ordinary user-role context message, and the producer never reads the kind back.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-bridge: 14 tests passed, including relayed updates with this source.

<a id="dev-note"></a>
## Dev Note

None.
