---
description: "The multimodal group map: document reading, shared media helpers, and the vision bridge for text-only routes, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/multimodal

English | [中文](README.zh.md)

## Summary

The multimodal group lets agents work from more than text files: PDF and Office documents, including scanned pages, and images on routes whose model cannot take them. Each tool reads coarse to fine, so a long document costs an outline first and only the pages the agent asks for. Audio and video reading builds on the experimental speech seam and therefore lives in the experimental group, sharing this group's helper library.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`media-core`](media-core/README.md) | Shared library: media commands over the subprocess seam, content-addressed cache, page and time windows, image commits | library — no ctx key |
| [`tool-read-document`](tool-read-document/README.md) | Lets the agent read PDF and Office documents, with pages lacking a text layer returned as images | registers on `ctx.tools` |
| [`vision-bridge`](vision-bridge/README.md) | Lets a text-only route ask an image-capable model about an image | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [tool-read-audio](../experimental/tool-read-audio/README.md) and [tool-read-video](../experimental/tool-read-video/README.md) — the experimental audio and video tools built on `media-core`.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-read-document) — the schemas the model receives.
- [attachment group](../attachment/README.md) — durable storage behind page images and frames.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
