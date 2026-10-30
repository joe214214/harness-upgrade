---
description: "The experimental read_audio tool: timestamped transcripts of audio and video files through the speech seam, with silence-aware segmentation and a time index for long recordings, for users and maintainers choosing, configuring, or debugging audio reading."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-read-audio

English | [中文](README.zh.md)

## Summary

`dsh-experimental-tool-read-audio` lets the agent listen to recordings: meetings, interviews, voice notes, or the audio track of a video. It returns a transcript in which every line carries its time range, so the agent can quote exactly when something was said. A long recording first comes back as a time index, and the agent reads the part it needs with `start` and `end`. Transcription runs through the speech seam, so the local SenseVoice provider or any other registered recognizer can serve it.

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

Mount the plugin next to a filesystem backend, the subprocess service, and a speech-to-text service with a registered provider (the voice input bundle supplies SenseVoice). The host needs `ffmpeg` and `ffprobe`. Without a speech service the tool still registers, and each call explains what to enable.

### Minimal configuration

```yaml
- insert:
    - id: tool-read-audio
      name: '@deepseek-ai/dsh-experimental-tool-read-audio'
```

### What each call does

| Arguments | Result |
|---|---|
| `file_path` | The whole transcript as `[MM:SS–MM:SS] text` lines, or a time index when it exceeds `maxTranscriptChars` |
| `start`, `end` | The segments overlapping that window; timestamps accept seconds, `MM:SS`, or `HH:MM:SS` |

The first call on a file transcribes it once; later windows, and `read_video` calls on the same file, reuse the cached transcript.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxSegmentSeconds` | `30` | Longest segment sent to the recognizer |
| `minSegmentSeconds` | `8` | Shortest segment worth a cut at a pause; shorter tails join the previous segment |
| `silenceNoise` | `-30dB` | Noise floor for pause detection |
| `silenceSeconds` | `0.4` | Shortest pause counted as silence |
| `maxDurationSeconds` | `14400` | Longest file accepted |
| `maxTranscriptChars` | `12000` | Transcript size returned before switching to a time index |
| `indexBlockSeconds` | `300` | Length of one time-index entry |
| `commandTimeoutMs` | `300000` | Deadline for each ffmpeg command |
| `cacheDir` | `<tmpdir>/dsh-media-cache` | Transcript cache, shared with `read_video` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### Why segment-level timestamps

The speech seam returns text without timestamps. The tool therefore runs `ffmpeg silencedetect`, plans segments of at most `maxSegmentSeconds` that end in the middle of a pause, and transcribes each segment separately; each segment's bounds become its timestamps. Cutting inside pauses keeps sentences whole, and spans that lie entirely in silence are never sent to the recognizer.

### Audio format

Each segment is decoded to raw 16 kHz mono PCM16 and wrapped in a canonical 44-byte WAV header written by the tool. ffmpeg's WAV muxer may add `LIST` chunks, which speech providers reject. Segments with less than 0.1 s of samples are skipped.

### Caching

The whole-file transcript is cached under a key built from the file's SHA-256, the provider id, the language, and the segmentation parameters, so a changed provider or setting transcribes again while a renamed file does not.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, config, tool definition, windows, time index |
| [`src/segment.ts`](src/segment.ts) | Silence parsing and segment planning |
| [`src/transcribe.ts`](src/transcribe.ts) | Segment extraction, WAV headers, speech seam calls, cache |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [speech-to-text](../speech-to-text/README.md) — the speech seam this tool consumes.
- [tool-read-video](../tool-read-video/README.md) — reuses this transcription for the speech half of its timeline.
- [media-core](../../multimodal/media-core/README.md) — command runner, cache, and timestamp helpers.

-----

<a id="model-experience"></a>
## Model Experience

### System-prompt guidance

#### What the model sees

One sentence in the system prompt, present only while the tool is visible in the calling scope, steering the model to this tool instead of shell commands.

##### Verbatim guidance

```markdown
Use the read_audio tool — not shell tools like ffmpeg or whisper — to transcribe recordings, and cite the timestamps it returns.
```

#### Token effect

Fixed and small, on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool's visibility is unchanged; it sits in the cached system prompt.

### Tool schema

#### What the model sees

The model sees the generated [`read_audio` schema](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-read-audio): a required `file_path` and optional `start` and `end` timestamps.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged.

### Tool result

#### What the model sees

A `<path>`, `<duration>`, and `<window>` header followed by either a `<transcript>` of `[MM:SS–MM:SS] text` lines, a note that no speech was recognized, or an `<index>` of time blocks with a preview of each and the instruction to call again with `start` and `end`.

#### Token effect

Bounded by `maxTranscriptChars`; longer windows return the index instead. The result stays in history until compaction.

#### KV Cache effect

Append-only; the result follows the reusable request prefix and does not invalidate earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Segment-level timestamps only** — a line's time range is its segment's range, up to `maxSegmentSeconds` long; word-level timing needs a recognizer that reports it.
- **No speaker labels** — the transcript does not say who spoke.
- **Experimental dependency** — the speech seam is experimental, so this tool is too.
- **Host execution only** — ffmpeg runs on the provider's process path and writes segments to the host temporary directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
