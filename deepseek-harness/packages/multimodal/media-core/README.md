---
description: "Shared library for the multimodal read tools: media commands over the subprocess seam, a content-addressed result cache, page and time-window arguments, ffprobe facts, and durable image commits, for maintainers building or debugging media tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-media-core

English | [中文](README.zh.md)

## Summary

`dsh-media-core` holds what `read_document`, `read_audio`, and `read_video` share, so each tool only states what it reads. It runs poppler and ffmpeg through the subprocess seam with explicit limits and install hints, caches derived results by the source file's content, parses page selections and timestamps the same way for every tool, reads stream facts with `ffprobe`, and commits rendered pages or frames to the attachment store. It registers no tool and no service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Import the helpers from a tool plugin that injects `subprocess` (and reads `attachments` and `llm` when it returns images).

| Export | Contract |
|---|---|
| `runMediaCommand(ctx, request, installHint)` | Runs one command to completion with explicit cwd, deadline, and stdout/stderr caps; throws `MediaCommandError` with code `MEDIA_TOOL_MISSING`, `MEDIA_TOOL_FAILED`, or `MEDIA_TOOL_TIMEOUT` |
| `MediaCache`, `hashFile` | JSON entries keyed by SHA-256 of the source plus every result-changing parameter; atomic writes; a corrupt entry is a miss |
| `parsePageSelection` | `"3"`, `"2-5"`, `"1,4-6"` against a page count and per-call cap |
| `parseTimestamp`, `formatTimestamp`, `resolveWindow` | Seconds, `MM:SS`, or `HH:MM:SS`; windows clamp to the duration and reject empty or late windows |
| `probeMedia`, `parseProbe` | Duration and audio/video presence; attached cover art does not count as video |
| `routeAcceptsImages` | Whether the calling route's exact model declares image input; unresolvable routes answer false |
| `savePng`, `imageBlock`, `STORED_IMAGE_SCHEMA` | Commit a PNG to `ctx.attachments`, persist its fields in a tool value, and re-brand them into an image block on render |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### Design philosophy

- **No defaults inside helpers.** Every limit is a parameter, so each tool's validated `Config` decides it.
- **Degrade, do not refuse.** `routeAcceptsImages` answers false instead of throwing, so tools can return text with a note.
- **Content, not names.** Cache keys use the file's digest, so copies and renames hit and edits miss.

### Source map

| File | Responsibility |
|---|---|
| [`src/command.ts`](src/command.ts) | Executable lookup and collected batch runs |
| [`src/cache.ts`](src/cache.ts) | Digest and JSON cache |
| [`src/ranges.ts`](src/ranges.ts) | Page selections, timestamps, windows |
| [`src/probe.ts`](src/probe.ts) | ffprobe parsing |
| [`src/images.ts`](src/images.ts) | Route capability, PNG commits, image blocks |

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the read_document, read_audio, and read_video tools, which own every model-visible schema and result built with these helpers.

#### KV Cache effect

None of its own; the consuming tools' results are append-only.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Cache entries are never evicted** — the cache directory grows until removed; tools point it at a temporary directory by default.
- **Text output only** — commands write binary results to files; stdout and stderr are collected as text with caps.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
