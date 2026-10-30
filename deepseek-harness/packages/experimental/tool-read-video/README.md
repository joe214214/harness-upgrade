---
description: "The experimental read_video tool: scene-change keyframes and speech of a video merged into one timestamped timeline and read coarse to fine, for users and maintainers choosing, configuring, or debugging video reading."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-read-video

English | [中文](README.zh.md)

## Summary

`dsh-experimental-tool-read-video` lets the agent watch a video, such as a screen recording of a bug, a demo, or a recorded talk. It returns keyframes taken where the picture changes, together with what was said, in one timestamped timeline. The first call covers the whole video with a few frames; the agent then narrows `start` and `end` around a moment, and the same frame budget spread over a shorter span shows it in more detail.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin next to a filesystem backend, the subprocess service, an attachment store, and an image-capable model route. A speech-to-text service adds the spoken audio. The host needs `ffmpeg` and `ffprobe`. On a text-only route, or without a speech service, the timeline keeps what is available and notes what was left out.

### Minimal configuration

```yaml
- insert:
    - id: tool-read-video
      name: '@deepseek-ai/dsh-experimental-tool-read-video'
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxFramesPerCall` | `8` | Frames returned by one call |
| `sampling` | `scene` | `scene` keeps frames at visual changes; `uniform` spaces them evenly (the baseline) |
| `sceneThreshold` | `0.3` | Minimum scene-change score |
| `frameMaxWidth` | `1024` | Wider frames are scaled down |
| `maxCandidateFrames` | `300` | Frames written before selection, bounding disk use |
| `maxDurationSeconds` | `14400` | Longest file accepted |
| `maxTranscriptChars` | `8000` | Speech included in one timeline |
| `commandTimeoutMs` | `300000` | Deadline for each ffmpeg command |
| `cacheDir` | `<tmpdir>/dsh-media-cache` | Transcript cache, shared with `read_audio` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### Frame selection

One ffmpeg run seeks to the window, applies `select='eq(n,0)+gt(scene,θ)'` (or `fps=N/span` in uniform mode) with `showinfo`, and writes the candidate frames. `showinfo` reports each frame's time; the candidates are then thinned evenly to `maxFramesPerCall`, always keeping the window's first frame, so a static video still yields one frame. Screen recordings change rarely, which is why scene sampling covers them with far fewer frames than uniform sampling.

### Timeline

Frames are committed with `ctx.attachments.saveImage`. Speech comes from the `read_audio` transcription of the whole file, cached by content, and is filtered to the window. Frames and speech are sorted by time, a frame first when both start at the same second.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, config, tool definition, timeline rendering |
| [`src/frames.ts`](src/frames.ts) | ffmpeg filter, `showinfo` parsing, frame thinning |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [tool-read-audio](../tool-read-audio/README.md) — the transcription behind the speech half of the timeline.
- [media-core](../../multimodal/media-core/README.md) — probing, windows, and image commits.
- [compaction-image-offload](../../compaction/compaction-image-offload/README.md) — replaces old frames with text references when images exceed the route's budget.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`read_video` schema](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-read-video): a required `file_path`, optional `start` and `end` timestamps, and an optional `transcript` boolean.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged.

### Tool result

#### What the model sees

A `<path>`, `<duration>`, and `<window>` header with any `<note>` lines, then the timeline: `[MM:SS] frame N` followed by that frame as a native image block, and `[MM:SS–MM:SS] said: text` lines, ending with the instruction to narrow `start` and `end` for detail.

#### Token effect

At most `maxFramesPerCall` images plus at most `maxTranscriptChars` of speech per call. Frames stay in history until compaction, where `compaction-image-offload` can replace them with text references.

#### KV Cache effect

Append-only; the result follows the reusable request prefix and does not invalidate earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No frames for text-only routes** — the timeline carries speech and a note; frames are not described on the model's behalf.
- **Scene detection misses slow changes** — a gradual fade or slow scroll may score below `sceneThreshold`; narrowing the window or `uniform` sampling covers it.
- **Host execution only** — ffmpeg runs on the provider's process path and writes frames to the host temporary directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
