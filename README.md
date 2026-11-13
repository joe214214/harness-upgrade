# harness-upgrade — multimodal input, long-term memory, cross-agent sessions and human-in-the-loop browser and computer use for DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) is DeepSeek's open-source, all-plugin agent runtime. Out of the box its agents read text and single images; its own docs list PDF, audio and video as deferred and ship no built-in memory, and its browser and computer-use agents work alone, cut off from the user's other coding agents. This project adds all of that as **ten native dsh packages**, built only on dsh's documented extension points — no change to the agent loop — and held to dsh's own engineering gates.

| What an agent can now do | Package | Tool |
|---|---|---|
| Read PDF and Office files, including scanned pages | `dsh-tool-read-document` | `read_document` |
| Listen to recordings, with timestamps | `dsh-experimental-tool-read-audio` | `read_audio` |
| Watch videos as a timeline of keyframes and speech | `dsh-experimental-tool-read-video` | `read_video` |
| Use images on a text-only model (e.g. `deepseek-v4-pro`) | `dsh-vision-bridge` | `ask_image` |
| Remember facts and past sessions across sessions | `dsh-memory` | `memory_*`, `recall` |
| Work in a browser the user watches live, marks, and can take over | `dsh-experimental-co-canvas` + Web tab | `ask_user_to_mark` |
| Operate the desktop (computer use) while the user watches, marks windows, or marks the frozen screen | co-canvas `desktop` + official `dsh-experimental-computer-use-cua-driver-native` | `cua_driver_native__*` |
| Ask about what's on screen without stopping the agent: a light model you choose answers in seconds from a task brief recorded while the agent works | co-canvas **Ask** | — |
| Go back to any earlier step of the agent's work, mark what went wrong, and send it back there | co-canvas **Timeline** | — |
| Open a Claude Code, Codex, or Gemini CLI session here and follow it live; share this conversation as their native session; share memory both ways | `dsh-experimental-agent-bridge` + Web tab | `external_sessions`, `open_external_session`, `share_session`, `external_memory` |
| (shared) command runner, cache, windows, image commits | `dsh-media-core` | — |

[`deepseek-harness/`](deepseek-harness) is the complete upgraded harness: the official `0.2.2-rc.1` release unchanged, with these packages added on top and registered where upstream registers new packages. Upstream's build, documentation gates and test suite run on the combined tree.

## Try it

The full harness source is in this repository. One script installs its dependencies, builds it (about 5 minutes), and adds a `dsh-mm` command. A [DeepSeek API key](https://platform.deepseek.com/api_keys) is enough; the script asks for it, and it can be left empty to add keys for any provider in the app instead.

Clone into the folder that should hold everything; the script keeps the harness and all its data side by side there (pass `-Root` / `--root` to choose another folder). Only the pnpm package store stays in its usual shared location.

```
<folder>\harness-upgrade\   this repository, including the full harness
<folder>\data\              memory, speech model, co-canvas browser profile, dsh-mm launcher
<folder>\dsh-home\          DSH sessions, settings and logs
```

**Windows** (PowerShell; installs missing Node.js, FFmpeg and Poppler with winget):

```powershell
mkdir D:\dsh; cd D:\dsh; git clone -b main https://github.com/joe214214/harness-upgrade; cd harness-upgrade
powershell -ExecutionPolicy Bypass -File install\setup.ps1          # add -WithOffice for .docx/.pptx/.xlsx
```

**macOS / Linux** (needs Node.js 24.9+; `brew install poppler ffmpeg` or `apt install poppler-utils ffmpeg`):

```bash
mkdir -p ~/dsh && cd ~/dsh && git clone -b main https://github.com/joe214214/harness-upgrade && harness-upgrade/install/setup.sh
```

Then, in any project folder:

```
dsh-mm                                        # DSH Web UI with all new tools
dsh-mm headless "what error is in bug.webm?"  # one task, answer printed
```

![DSH Web UI reading a scanned PDF page with read_document](docs/web-ui-scanned-pdf.png)

### Update

Close any running `dsh-mm` window, then pull and run the setup script again; it rebuilds and keeps sessions, memory, settings and API keys.

```powershell
cd D:\dsh\harness-upgrade; git pull; powershell -ExecutionPolicy Bypass -File install\setup.ps1
```

```bash
cd ~/dsh/harness-upgrade && git pull && install/setup.sh
```

### Turning plugins off

Each feature is a separate plugin. To turn one off, add its id with `disabled: true` to `data/overlay.local.yml` (`C:\dsh\data\overlay.local.yml` on Windows) and restart `dsh-mm`; the file lists every id. Setup creates that file once and never overwrites it, so the change survives updates, unlike edits to `overlay.yml`, which setup rewrites.

```yaml
- id: memory
  disabled: true
```

### Models and API keys

The model menu under the message box picks the model for the conversation. **Manage models and API keys** at its bottom opens Settings → Models: enter a key for DeepSeek, or **Add model provider** for any of about 40 providers (Anthropic, OpenAI, Google Gemini, OpenRouter, …) or a custom OpenAI- or Anthropic-compatible endpoint, whose model list is fetched from the endpoint. Every new tool works on any model: `ask_image` picks an image-capable model that has a key when the conversation's model reads no images.

| Model menu | Settings → Models |
|---|---|
| ![Model menu with Manage models and API keys](docs/models-menu.png) | ![Settings, Models section with DeepSeek and a custom provider](docs/models-settings.png) |

## Demos (real runs on the DeepSeek API)

**Co-canvas · Point instead of explaining.** The agent works in a shared browser whose window carries a small toolbar; the Web UI also shows it live in a side tab. The user boxes or points at something on the real page, with a note; each mark is resolved to the element underneath — `button "Submit" (2nd of 2 button elements with this text)` plus a CSS selector — and reaches the agent with its next tool result. Two real runs on a page with two identical "Submit" buttons — **[watch marking in the real browser window](docs/co-canvas-in-page-demo.mp4)** (72 s) or [in the Web tab](docs/co-canvas-demo.mp4) (77 s), both with Chinese captions:

- *The agent asks.* Told only to "press the Submit button", the agent noticed the ambiguity and called `ask_user_to_mark`; the user boxed Plan B and sent the mark; the agent clicked Plan B.
- *The user corrects mid-task.* Told to "submit Plan A", the agent was paused the moment the page appeared; the user boxed Plan B with "Change of plan" and resumed. The browser action the agent had already chosen was refused instead of run, and it re-planned: "You changed the plan to Plan B… Plan A was never submitted."

**Agent bridge · Claude Code, Codex, and Gemini CLI in one conversation.** Like Codex's import of Claude Code sessions, but live and in both directions. A real run on the DeepSeek API through the Web UI: asked about "a checkout bug I fixed in Claude Code yesterday", the agent searched with `external_sessions`, opened the Claude Code session, and summarised where it stopped. Claude Code then added two messages to that session; they arrived as a relayed update without waking the agent, and "what did Claude Code just do?" was answered from them (a regression test, `tests/cart.test.js`). "Share this with Codex and Gemini CLI" wrote the conversation as a native session of each and returned `codex resume <thread>` and `gemini --resume <id>`: the real Gemini CLI lists it, and the real Codex holds every message, extended after each later turn through Codex's own importer. Memory went both ways: the API base path came from Claude Code's project memory and "use pnpm" from Gemini CLI's, each cited by source, while DeepSeek Harness's "Postgres 16 only" was written into a marked block of `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`.

| A followed Claude Code session reports its new work | The Agent bridge tab |
|---|---|
| ![Agent answering what Claude Code just did, from a relayed update](docs/agent-bridge-followed.png) | ![Shared with Codex and Gemini CLI with resume commands; followed sessions; other agents' sessions; memory](docs/agent-bridge-tab.png) |

**Co-canvas on the desktop · Ask on the side, go back in time.** With the official Cua Driver computer-use provider, the same tab shows the desktop live. A real run on the DeepSeek API with a flight-search app on the desktop: asked for the cheapest Shanghai→Beijing flight on 20 November, the agent worked the app with computer use while the tab's **Task** card filled itself in: the goal, the window "飞行网 · 机票查询", and a progress line. Mid-task the user boxed a result row and asked "这班几点到北京？是在哪个网站上？"; `deepseek-flash` answered in the tab in **3.1 s** ("HU7604 21:55 到达北京，¥640，在飞行网的机票查询页面上") while the agent kept working, and the question and answer reached the agent as information only. Then the user picked step 2 on the **Timeline** (the agent paused and the tab showed that step's screen), wrote "日期错了，我要的是 11月21日", and pressed **Went wrong here**: the agent went back, searched the 21st, and reported CA1832 at ¥540. Nothing was booked. **Mark on screen** freezes the real screen full screen for marking.

| Side question answered while the agent works | Back to step 2 on the timeline | The agent redid the search for the 21st |
|---|---|---|
| ![Task card, desktop view, and the side answer in the Questions section](docs/desktop-1-side-question.png) | ![Paused on step 2 with its screen and the Went wrong here button](docs/desktop-2-timeline-step.png) | ![Agent reply with CA1832 at 540 after going back](docs/desktop-4-rewound.png) |

| The agent asks; the user marks | The user corrects mid-task |
|---|---|
| ![Agent question and the user's box around Plan B's Submit](docs/co-canvas-1-question-marked.png) | ![Agent re-planned to Plan B after the user's mark](docs/co-canvas-4-correction-done.png) |


**1 · Fix a bug from a screen recording.** [`demos/1-video-bug`](demos/1-video-bug/shop) holds a tiny web shop and a 10-second Playwright recording in which Checkout throws. The agent watches the video, reads the error off the frame (`TypeError … reading 'price' (cart.js:11)`), finds the off-by-one loop, fixes it, and verifies the fix with Node. Change-ranked sampling picks 5 frames — one per UI change — and the last one is the error banner.

**2 · Meeting minutes from a recording.** [`demos/2-meeting/meeting.mp3`](demos/2-meeting/meeting.mp3) is a 58-second two-voice meeting synthesized with espeak-ng. `read_audio` transcribes it with the local SenseVoice model (downloaded and loaded on first use through the speech seam's preparation), and the agent writes [minutes](demos/2-meeting/meeting-minutes.example.md) with decisions, action items and open questions, each with a timestamp. It recovered the `/v1/relay` prefix, 120 requests per minute, the dead-letter queue after three attempts and the Friday deadline; robotic speech garbled the path's last segment and the owner's name, and the minutes flag both as low-confidence instead of guessing.

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

## Status

| Item | State |
|---|---|
| `read_document`, `read_video`, `ask_image`, `memory` | Done, verified end to end on DeepSeek |
| `read_audio` | Done, verified end to end with the real SenseVoice model (demo 2) |
| Co-canvas (shared browser, marks, pause/take over) | Done, verified end to end on DeepSeek through the real Web UI; Windows uses the built-in Edge |
| Agent bridge (open and follow Claude Code / Codex / Gemini CLI sessions, share live as their native sessions, two-way memory) | Done, verified end to end on DeepSeek through the Web UI with the real Codex and Gemini CLIs; resuming in Claude Code not exercised (needs a signed-in Claude Code) |
| Computer use + desktop co-canvas (desktop view, window-grounded marks, Mark on screen, task brief, side questions, timeline and going back) | Done, verified end to end on DeepSeek on a Linux X11 desktop; the Cua Driver runtime ships Windows binaries, Windows not yet fully exercised |
| Subagents | Co-canvas marks, side answers and the timeline belong to the top-level conversation; a subagent's browser and desktop actions still wait while the user holds control. Memory stores and reflects on top-level turns only |
| Other model providers | Verified end to end through a custom OpenAI-compatible provider added in Settings → Models: `read_document` on a scanned PDF answered on that route |
| Speech output | Not started |

## Repository layout

```
deepseek-harness/  the upgraded harness: official 0.2.2-rc.1 plus this project's commits
install/           setup.ps1 (Windows), setup.sh, the dsh-mm launcher and plugin overlay
demos/             demo projects, recordings, fixtures, and run.sh
eval/              video benchmark (Python orchestrator, Playwright recorder) and results
docs/              screenshots, recordings, and engineering notes
memory/            Python prototype of the memory design (MCP server + dsh plugin)
relay/             Relay, a self-hosted inference gateway
```
