# harness-upgrade — multimodal input and long-term memory for DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) is DeepSeek's open-source, all-plugin agent runtime. Out of the box its agents read text and single images; its own docs list PDF, audio and video as deferred and ship no built-in memory. This project adds them as **seven native dsh packages**, built only on dsh's documented extension points — no change to the agent loop — and held to dsh's own engineering gates.

| What an agent can now do | Package | Tool |
|---|---|---|
| Read PDF and Office files, including scanned pages | `dsh-tool-read-document` | `read_document` |
| Listen to recordings, with timestamps | `dsh-experimental-tool-read-audio` | `read_audio` |
| Watch videos as a timeline of keyframes and speech | `dsh-experimental-tool-read-video` | `read_video` |
| Use images on a text-only model (e.g. `deepseek-v4-pro`) | `dsh-vision-bridge` | `ask_image` |
| Remember facts and past sessions across sessions | `dsh-memory` | `memory_*`, `recall` |
| (shared) command runner, cache, windows, image commits | `dsh-media-core` | — |

[`deepseek-harness/`](deepseek-harness) is the complete upgraded harness: the official `0.2.2-alpha.2` release imported unmodified in one commit, with every change of this project as separate commits on top (139 files, +9,039 / −197 lines). `git log -- deepseek-harness` shows exactly what was added.

## Try it

The full harness source is in this repository. One script installs its dependencies, builds it (about 5 minutes), and adds a `dsh-mm` command. Only a [DeepSeek API key](https://platform.deepseek.com/api_keys) is needed; the script asks for it.

**Windows** (PowerShell; installs missing Node.js, FFmpeg and Poppler with winget):

```powershell
git clone https://github.com/joe214214/harness-upgrade; cd harness-upgrade
powershell -ExecutionPolicy Bypass -File install\setup.ps1          # add -WithOffice for .docx/.pptx/.xlsx
```

**macOS / Linux** (needs Node.js 24.9+; `brew install poppler ffmpeg` or `apt install poppler-utils ffmpeg`):

```bash
git clone https://github.com/joe214214/harness-upgrade && cd harness-upgrade && install/setup.sh
```

Then, in any project folder:

```
dsh-mm                                        # DSH Web UI with all new tools
dsh-mm headless "what error is in bug.webm?"  # one task, answer printed
```

![DSH Web UI reading a scanned PDF page with read_document](docs/web-ui-scanned-pdf.png)

## Demos (real runs on the DeepSeek API)

**1 · Fix a bug from a screen recording.** [`demos/1-video-bug`](demos/1-video-bug/shop) holds a tiny web shop and a 10-second Playwright recording in which Checkout throws. The agent watches the video, reads the error off the frame (`TypeError … reading 'price' (cart.js:11)`), finds the off-by-one loop, fixes it, and verifies the fix with Node. Change-ranked sampling picks 5 frames — one per UI change — and the last one is the error banner.

**3 · Implement a parser from a scanned spec.** [`demos/3-scanned-spec`](demos/3-scanned-spec) has a 2-page PDF whose field table is a scan with no text layer. `read_document` returns an outline flagging page 2 as "no text layer", the agent re-reads it as an image, writes `parse_header` (`>HBBIQ`) plus 14 pytest tests, and runs them; an independent hidden test also passes.

**Text-only model sees a screenshot.** On `deepseek-v4-pro`, `read_image` refuses; the agent switches to `ask_image`, `deepseek-flash` reads the screenshot, and only text returns.

**Memory across sessions.** Session 1: "our API base path is /v2/relay, never use print() for logging, Postgres 16 only." Session 2, fresh: "write a function that logs a startup message with our base path" → uses `structlog` and `/v2/relay` with no tool calls.

Reproduce after setup: `DEEPSEEK_API_KEY=… demos/run.sh 1` (or `3`).

## Evaluation: how should an agent look at a video?

12 synthetic 40-second dashboard recordings (ticking clock, one metric change, one alert banner shown for 2 s at a random time). The agent must call `read_video` once on the whole video and report the alert code. Same model, same prompt; only frame selection changes. Script: [`eval/video_eval.py`](eval/video_eval.py); raw runs: [`eval/results/`](eval/results).

| Frame selection | Frames per call | Alert found | Median input tokens |
|---|---|---|---|
| Change-ranked (ours) | **4** | **12 / 12** | **14.2k** |
| Change-ranked (ours) | 8 | 12 / 12 | 16.4k |
| Uniform (baseline) | 8 | 8 / 12 | 16.4k |
| Uniform (baseline) | 24 | 12 / 12 | 24.8k |

Uniform sampling needs 6× the frames and 1.75× the input tokens to match change-ranked selection at 4 frames. Medians are reported because two uniform runs fell back to extracting extra frames with bash (124k and 198k tokens).

**Why ranking, not a threshold.** ffmpeg's scene score is designed for film cuts (> 0.3). In a screen recording an error banner scored **0.13** and a one-line text change **~0.005**, so the usual 0.3 threshold kept only the first frame. `read_video` therefore scores every frame on a 320-px copy and keeps the first frame plus the largest changes, at least 1 s apart.

## Engineering notes worth discussing

- **Fit the host's architecture.** Tools register on `ctx.tools`, guidance on `ctx.systemPrompt` at centrally allocated orders, memory on `agent/turn-stopping`; images go through `ctx.attachments` so dsh's existing `compaction-image-offload` handles old frames for free.
- **Coarse to fine everywhere.** Outline → pages; time index → window; whole-video frames → narrowed window with the same frame budget.
- **Timestamps the seam doesn't give.** dsh's speech seam returns plain text, so `read_audio` cuts audio at detected pauses and transcribes segment by segment; each segment's bounds are its timestamps.
- **A canonical WAV header, written by hand.** ffmpeg's WAV muxer adds `LIST` chunks that the SenseVoice provider rejects; a unit test validates every segment with dsh's own validator.
- **Fakes hide lifecycle.** The scripted recognizer was always ready; real SenseVoice refuses until its model is downloaded and loaded, a step only dsh's voice UI triggered. `read_audio` now starts or joins the provider's preparation through the seam and waits for it.
- **Tool adoption is a design problem.** Once bash worked, the model extracted frames with ffmpeg instead of calling `read_video`; one scoped system-prompt sentence per tool (dsh's own pattern for `read`) fixed it.
- **Benchmarks leak.** An early memory test "passed" because the agent globbed outside its workspace and read the harness's own logs. Answers now stay in memory until all runs finish.
- **Upstream's bar, not ours.** 57 package tests; dsh's 43 documentation gates pass (bilingual READMEs with Model Experience sections, generated tool/config catalogs, an acknowledged persistence-type change, locale metadata in 8 languages).

## Status

| Item | State |
|---|---|
| `read_document`, `read_video`, `ask_image`, `memory` | Done, verified end to end on DeepSeek |
| `read_audio` | Done and unit-tested with a scripted recognizer; a first real SenseVoice run found and fixed a missing provider-preparation step; full run pending network access to the Hugging Face file CDN (`us.aws.cdn.hf.co`) |
| Web UI cards, speech output | Not started |
| Upstream PR | Changes are separate commits on the imported release, ready to move to a fork |

## Repository layout

```
deepseek-harness/  the upgraded harness: official 0.2.2-alpha.2 plus this project's commits
install/           setup.ps1 (Windows), setup.sh, the dsh-mm launcher and plugin overlay
demos/             demo projects, recordings, fixtures, and run.sh
eval/              video benchmark (Python orchestrator, Playwright recorder) and results
memory/            first Python prototype of the memory design (MCP server + dsh plugin)
relay/             Relay, the self-hosted inference gateway this work started from
```
