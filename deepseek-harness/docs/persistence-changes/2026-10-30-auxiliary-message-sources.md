---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-30-auxiliary-message-sources

English | [中文](2026-10-30-auxiliary-message-sources.zh.md)

## Summary

Adds the dsh-memory-reflect and dsh-vision-bridge message source kinds, used by auxiliary model requests of the memory and vision-bridge plugins.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Both kinds mark user messages built only for auxiliary requests (the memory reflect pass and ask_image); neither plugin appends them to a Session, so no persisted record carries them and existing readers never meet them. Current readers continue to accept every existing record because no existing variant changed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/memory packages/multimodal: 3 test files passed (memory 11, vision-bridge 2, read_document and media-core 25 tests).

<a id="dev-note"></a>
## Dev Note

None.
