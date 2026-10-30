---
description: "The experimental read_video tool: scene-change keyframes and speech of a video merged into one timestamped timeline and read coarse to fine, for users and maintainers choosing, configuring, or debugging video reading."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-read-video

English | [中文](README.zh.md)

## Summary

`dsh-experimental-tool-read-video` lets the agent watch a video, such as a screen recording of a bug, a demo, or a recorded talk. It returns keyframes taken at the largest visual changes, together with what was said, in one timestamped timeline. The first call covers the whole video with a few frames; the agent then narrows `start` and `end` around a moment, and the same frame budget spread over a shorter span shows it in more detail.

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
| `sampling` | `scene` | `scene` keeps the first frame and the largest visual changes; `uniform` spaces frames evenly (the baseline) |
| `minSceneScore` | `0.001` | Scene scores below this are treated as encoder noise |
| `minFrameGapSeconds` | `1` | Minimum spacing between selected frames |
| `frameMaxWidth` | `1024` | Wider frames are scaled down |
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

A first ffmpeg pass scores every frame of the window with the scene detector on a 320-pixel-wide copy. The window's first frame is kept, then the highest-scoring changes above `minSceneScore`, each at least `minFrameGapSeconds` from those already kept, until `maxFramesPerCall`; each frame is taken 0.3 s after its change point so a transition has settled. Each selected time is then extracted with an input seek. Ranking replaces a fixed threshold because scores depend on content: film cuts score above 0.3, while an error banner appearing in a screen recording scored 0.13 and a one-line text change about 0.005. Uniform mode places frames in the middle of equal slices of the window.

### Timeline

Frames are committed with `ctx.attachments.saveImage`. Speech comes from the `read_audio` transcription of the whole file, cached by content, and is filtered to the window. Frames and speech are sorted by time, a frame first when both start at the same second.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, config, tool definition, timeline rendering |
| [`src/frames.ts`](src/frames.ts) | Scene scoring, change ranking, uniform times, frame extraction |

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
- **Gradual changes rank low** — a slow scroll spreads its change over many small scores, so the frame budget may go to sharper changes; narrowing the window or `uniform` sampling covers it.
- **Host execution only** — ffmpeg runs on the provider's process path and writes frames to the host temporary directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
