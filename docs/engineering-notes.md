# Engineering notes

Design decisions and lessons from building the harness-upgrade packages. For using them, see the [README](../README.md).

## How the upgrade relates to upstream

[`deepseek-harness/`](../deepseek-harness) is the complete upgraded harness: the latest official release, `0.2.2-rc.1`, imported unmodified in one commit (byte-identical to upstream's tag), with every change of this project as separate commits on top — 220 files, +15,123 / −24 lines outside the lockfile and generated docs, plus regenerated catalogs. `git diff <import commit> HEAD -- deepseek-harness` shows exactly what was added.

**A superset of upstream, not a fork that drifts.** Everything in the official release is kept as is; this project only adds packages and registers them where upstream expects new packages to be registered. Upstream's own checks run on the combined tree: the full build and `build:check`, all 43 documentation gates, and upstream's complete unit-test suite (52,744 tests). In this cloud container 16 upstream test files fail identically on the untouched release (sandboxing, root user, IPv6, SSH and GitHub CLI access), so they are environmental; every other test passes.

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

### Models and API keys

The model menu under the message box picks the model for the conversation. **Manage models and API keys** at its bottom opens Settings → Models: enter a key for DeepSeek, or **Add model provider** for any of about 40 providers (Anthropic, OpenAI, Google Gemini, OpenRouter, …) or a custom OpenAI- or Anthropic-compatible endpoint, whose model list is fetched from the endpoint. Every new tool works on any model: `ask_image` picks an image-capable model that has a key when the conversation's model reads no images.

| Model menu | Settings → Models |
|---|---|
| ![Model menu with Manage models and API keys](docs/models-menu.png) | ![Settings, Models section with DeepSeek and a custom provider](docs/models-settings.png) |

## Notes

- **Fit the host's architecture.** Tools register on `ctx.tools`, guidance on `ctx.systemPrompt` at centrally allocated orders, memory on `agent/turn-stopping`; images go through `ctx.attachments` so dsh's existing `compaction-image-offload` handles old frames for free.
- **Coarse to fine everywhere.** Outline → pages; time index → window; whole-video frames → narrowed window with the same frame budget.
- **Timestamps the seam doesn't give.** dsh's speech seam returns plain text, so `read_audio` cuts audio at detected pauses and transcribes segment by segment; each segment's bounds are its timestamps.
- **A canonical WAV header, written by hand.** ffmpeg's WAV muxer adds `LIST` chunks that the SenseVoice provider rejects; a unit test validates every segment with dsh's own validator.
- **Fakes hide lifecycle.** The scripted recognizer was always ready; real SenseVoice refuses until its model is downloaded and loaded, a step only dsh's voice UI triggered. `read_audio` now starts or joins the provider's preparation through the seam and waits for it.
- **Timestamps must be as fine as the questions.** Segments first grew to the 30-second maximum before cutting at a pause, so asking for 0–15 s returned 0–25 s and the agent concluded the window was ignored. Segments now end at the first pause after the minimum length, about one utterance each.
- **Tool adoption is a design problem.** Once bash worked, the model extracted frames with ffmpeg instead of calling `read_video`; one scoped system-prompt sentence per tool (dsh's own pattern for `read`) fixed it.
- **MCP answers "how a model uses a tool", not "how a human joins in".** The agent's browser tools stay the stock Playwright MCP server in attach mode; co-canvas owns the same Chromium and hooks dsh's `tools/pre-execute` and `tools/post-execute` events — the plugin-only places where a human's input can reach a running agent loop.
- **A gate must match real names.** Pause first matched tools named `browser_*`; real Playwright MCP tools are `mcp__playwright-mcp__browser_*`, so a paused agent would have kept clicking. Unit tests used the bare name; reading a real session log caught it.
- **A page must not speak for the user.** Marks outrank the agent's plan, so a malicious page that could forge one would own the agent. The in-page toolbar runs in an isolated world whose binding page scripts cannot reach, and accepts only trusted (user-generated) events.
- **`document.open()` erases every listener**, shadow trees included, so a re-attached toolbar looked alive but was dead; it is now rebuilt whole.
- **Stale actions are the real hazard.** Delivering a correction after the agent's next action is too late if that action is the wrong click. A browser call chosen before the user's latest input is refused with the marks instead of run.
- **Benchmarks leak.** An early memory test "passed" because the agent globbed outside its workspace and read the harness's own logs. Answers now stay in memory until all runs finish.
- **A question must be able to stop the work.** Marks first reached the agent only with its next tool result, so a user who paused to ask had to resume first. A discussion now steers the Session with its own message and refuses every gated action at once, so a call already held by the pause returns and the agent can answer; the user's next own message ends the discussion.
- **Import a foreign session as context, not as fake history.** dsh logs each assistant message with its exact provider stream, so another agent's turns cannot honestly become DeepSeek's own. They arrive as relayed context, the same form dsh uses for messages between agents, parked in the inbox until the next step so following a busy session costs no model calls.
- **Use the other agent's own door.** Writing Codex's rollout format directly would break with its next release; Codex already ships an importer for Claude Code transcripts that appends to the same thread while it is idle and defers when it diverged. The bridge writes a Claude Code transcript and asks Codex to import it.
- **Never read your own echo.** Shared files are followed for what the other agent adds, so every record the bridge writes carries a marker, Codex copies are recognised by fingerprint, and the memory block it writes into other agents' files is stripped when their memory is read back.
- **Measure what every request carries.** A fresh install's simple turn used 243K tokens: 133 tool definitions (149K characters) rode on every step, 62% of them from the computer-use provider, including a second set of browser tools that duplicates the shared browser's. Co-canvas now withdraws such tools per agent through the tool registry's own `restrict`, 11K tokens less per request, without changing the provider.
- **Scope memory like the files it came from.** A one-off question about one project's PDF became a "project" fact, and global sharing would have put it into every project of every agent. Project and decision facts are now placed by the working directory of the Session that saved them, in DeepSeek Harness's own prompt and in the other agents' project memory alike.
- **Reuse the official provider, observe beside it.** Computer use is upstream's Cua Driver provider unchanged; co-canvas only reads the screen through a runtime of its own and gates the provider's action tools by name.
- **Upstream's bar, not ours.** 107 package tests; dsh's 43 documentation gates and `build:check` pass (bilingual READMEs with Model Experience sections, generated tool/config catalogs, an acknowledged persistence-type change, locale metadata in 8 languages).
