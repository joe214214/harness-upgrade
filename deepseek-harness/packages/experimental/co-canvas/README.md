---
description: "Experimental co-canvas: a shared browser and desktop the user watches live, marks, asks about, rewinds, and takes over while the agent works, with marks grounded to page elements or desktop windows, side questions answered by a light model, and a timeline of the agent's actions, for users and maintainers composing human-in-the-loop browser and computer use."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-co-canvas

English | [中文](README.zh.md)

## Summary

`dsh-experimental-co-canvas` lets the user work beside the agent in a shared browser and, with `desktop`, on the desktop: watch both live, mark them, pause the agent, or take over. Marks resolve to the element or window underneath; sent marks reach the agent with its next tool result. **Ask** sends a question about them to a light model that answers within seconds from a task brief recorded while the agent works, which keeps working. A timeline keeps the screen after each action, so the user can send the agent back to any step.

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

Mount it with the co-canvas tab and a browser-use provider in attach mode that points at `debugPort`. Mount the co-canvas entry before the browser provider so the browser is running when a Session attaches.

```yaml
- insert:
    - id: co-canvas
      name: '@deepseek-ai/dsh-experimental-co-canvas'
      config:
        channel: msedge
    - id: ui-co-canvas
      name: '@deepseek-ai/dsh-experimental-client-ui-co-canvas'
    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'
    - id: browser-use-playwright-mcp
      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
      config:
        mode: attach
        endpoint: 'http://127.0.0.1:9333'
```

| Field | Default | Meaning |
|---|---|---|
| `debugPort` | `9333` | CDP port the agent's browser tools attach to |
| `headless` | `true` | Run without a window; the tab shows the page either way |
| `executablePath` | — | Chromium executable; wins over `channel` |
| `channel` | — | Installed browser channel, such as `chrome` or `msedge` |
| `userDataDir` | `<tmpdir>/dsh-co-canvas-profile` | Browser profile directory |
| `startUrl` | `about:blank` | Page opened at launch |
| `viewportWidth`, `viewportHeight` | `1280`, `800` | Viewport in CSS pixels |
| `frameQuality` | `60` | JPEG quality of live frames |
| `pageToolbar` | `true` | Inject the marking toolbar into every page of the browser window |
| `gatedTools` | `(^\|__)browser_` | Regular expression for the agent's browser tool names, bare or MCP-prefixed; matching calls wait while the user holds control |
| `maxMarksPerMessage` | `10` | Most marks listed in one delivery; older ones are counted |
| `maxCropsPerMessage` | `3` | Most cropped screenshots per delivery on image-capable routes; `0` disables them |
| `cropMargin` | `120` | Context pixels around a cropped mark |
| `askTimeoutMs` | `300000` | How long `ask_user_to_mark` waits |
| `desktop` | `false` | Offer the primary display as a second surface; pair it with a computer-use provider such as [Cua Driver native](../computer-use-cua-driver-native/README.md) |
| `desktopFrameIntervalMs` | `1000` | Pause between live desktop frames |
| `desktopMaxFrameEdge` | `1600` | Longest edge of a live desktop frame in pixels |
| `gatedDesktopTools` | Cua Driver action tools | Regular expression for the agent's desktop action tools; matching calls wait while the user holds control, like `gatedTools` |
| `hiddenTools` | empty | Regular expression for global tools withdrawn from every agent through the tool registry's per-agent restriction, such as computer-use tools that duplicate the shared browser's; empty hides nothing |
| `ignoredWindows` | invisible Windows overlays | Regular expression for windows never named as the target of a mark or action, matched against title or application, such as the NVIDIA overlay that covers the screen; empty ignores none |
| `dataDir` | `~/.dsh-co-canvas` | Timeline frames and the tab's settings |
| `askProvider` | empty | Provider of the side-question model; empty uses the first provider with an API key that offers it |
| `askModel` | `deepseek-flash` | Model that answers side questions and summarizes the task brief, until the user picks another in the tab |
| `askMaxTokens` | `600` | Output cap of one side answer |
| `sideTimeoutMs` | `60000` | Deadline of one side answer |
| `timelineMaxSteps` | `300` | Most timeline steps kept; older frames are deleted |
| `timelineSettleMs` | `400` | Wait after an action before its screen is recorded |
| `briefEverySteps` | `4` | Actions between refreshes of the task brief's summary |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### One browser, two controllers

The service launches a persistent Chromium context with a remote-debugging port. The agent's browser tools connect to that port; the service keeps its own Playwright handle on the same context. The active page is the most recently opened page that is still open, so the live view follows the tabs the agent opens. When the debugging port is already taken, for example by another DeepSeek Harness window, the launch fails at once with that reason instead of waiting for the browser's launch timeout.

### Live view

`frames` streams JPEG frames from the CDP screencast of the active page and reattaches when the active page changes. A slow reader receives only the newest frame. `follow` streams the URL, title, control holder, open question, and undelivered marks.

### In-page toolbar

With `pageToolbar`, every top-level document gets a small toolbar: a note field, Mark, and Pause or Resume, plus the agent's open question with a button that sends the marks. It runs in an isolated world; the binding it reports through exists only in that world, so the page's own scripts cannot send marks, and it accepts only trusted (user-generated) events. Its host is `aria-hidden`, so accessibility snapshots of the page omit it. `document.open()` erases every listener in a document, so the toolbar is rebuilt whenever its host leaves the document.

### Grounding a mark

The focus point of a mark is the centre of a box, the head of an arrow, or the point itself. `DOM.getNodeForLocation` finds the node there; a function evaluated on that node returns its tag, text, role, label, a CSS selector, and its position among elements with the same tag and text. The toolbar is hidden meanwhile. A PNG crop of `cropMargin` pixels around the mark is taken at the same time with the mark drawn on it, so a later navigation does not change what the user marked.

### Delivery and control

A drawn mark is a draft: the agent never sees it until the user sends it with `send`, which attaches the user's text to the last draft; an idle agent takes no next step, so marks sent to it start a turn. Asking about drafts consumes them without sending them, so a question never becomes an instruction while the user is still typing it. A `tools/post-execute` listener attaches sent marks, and any handback since the last delivery, to the result of the agent's next tool call as one additional user message; the agent loop logs it with the result. A `tools/pre-execute` listener holds calls whose name matches `gatedTools` or `gatedDesktopTools` until control returns to the agent; if the user marked the screen or operated it after the agent chose such a call, the call is refused with the marks instead of run, so a stale action never reaches the page; after a bare pause the call runs and the handback follows its result. If the browser failed to start, the listener refuses these calls with the launch error, which is also logged to the console and shown in the co-canvas tab. User input is replayed through Playwright and refused unless the user holds control. While the agent is paused, `frames` and `desktopFrames` stop reading their source, so the view holds the last frame and the user marks a still picture; no desktop screenshot is taken meanwhile, and desktop marks are cropped from that frame. Resume or Take over streams live frames again.

### Desktop surface

With `desktop`, the service opens its own same-process Cua Driver runtime, separate from the computer-use provider's. `desktopFrames` streams JPEG frames of `get_desktop_state` screenshots, sized in screen points and scaled with sharp to `desktopMaxFrameEdge`. A desktop mark is grounded with `list_windows`: the frontmost visible window containing the focus point gives the title, application, pid, and window id, and the crop is cut from the screenshot the mark was drawn on. **Mark on screen** waits a few seconds, takes a screenshot, and shows it in a full-screen browser window with its own toolbar; the user draws marks with notes and chooses to send them, ask about them, or cancel. The marker window always opens visibly, even beside a headless shared browser. The Web tab cannot replay input on the desktop: there the user takes over with the real mouse and keyboard, and the agent waits.

### Task brief

The brief holds the goal, the application, window and page of the agent's last action, and a one-line progress summary. The goal starts as the user's request; location comes from each recorded action (the window the action named, or the frontmost one, through `list_windows`; the page title and URL in the browser). Every `briefEverySteps` actions, after each new request, and when the agent's turn ends (with its final reply), the side-question model rewrites goal and progress from the last three requests and twelve actions, off the agent's path. The panel shows whether the agent's turn is running. A goal the user edits in the tab is kept until cleared.

### Side questions

`ask` takes the draft marks, which the agent then never receives, or takes marks drawn on a timeline step's frame, and sends one request to the side-question model: the brief, the last eight actions, a description of each mark, and the marks' crops on image-capable models (when nothing is marked, the window of the agent's latest desktop action, or the browser page), with the model's least reasoning effort. The answer streams into the tab. The agent keeps working unless the user turned on pausing for questions. When the answer is complete, the question and answer are queued in the agent's inbox for its next step, without waking it, as a user message the agent is told not to answer. The model is chosen in the tab from every model of every provider with an API key and is kept in `dataDir` with the pause choice.

### Timeline and going back

A `tools/post-execute` listener records each gated call of the top-level agent: after `timelineSettleMs`, a JPEG of the browser page or the desktop, the tool, its arguments in one line, and the window or page. Recording runs while the model thinks; the next gated call waits for it, so each frame shows the screen its action left. Actions whose arguments name submitting, paying, ordering, sending, deleting, confirming or booking, or a key press of Enter, are flagged as possibly irreversible. Frames live under `dataDir/timeline`, which is emptied when the service starts. Selecting a step in the tab pauses the agent and shows that frame. `rewind` refuses the agent's next gated call once and steers its Session with the step, the user's marks and note, the actions taken since, and the request to return to that state before continuing; the agent resumes. Nothing is undone automatically.

### Subagents

Marks, side answers, rewinds and the timeline belong to the conversation the user sees: the top-level agent that most recently ran a tool or received a user message, or else the most recently loaded top-level conversation. A subagent's browser and desktop actions still wait while the user holds control, but its tool results carry no marks and are not recorded on the timeline.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, config, Remote methods, tool hooks, `ask_user_to_mark` |
| [`src/browser.ts`](src/browser.ts) | Browser launch, active page, screencast, toolbar wiring, hit testing, crops, input |
| [`src/overlay.ts`](src/overlay.ts) | The in-page toolbar and its messages |
| [`src/marks.ts`](src/marks.ts) | Model-facing mark text |
| [`src/desktop.ts`](src/desktop.ts) | Desktop screenshots, live frames, window grounding, crops |
| [`src/screen-marker.ts`](src/screen-marker.ts) | Full-screen marking on a frozen screenshot |
| [`src/brief.ts`](src/brief.ts) | Task brief and its summary request |
| [`src/sidecar.ts`](src/sidecar.ts) | Side-question model choice and request |
| [`src/timeline.ts`](src/timeline.ts) | Timeline steps, frames, crops, irreversible-action check |
| [`src/types.ts`](src/types.ts) | Types shared with the Web tab |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [client-ui-co-canvas](../client-ui-co-canvas/README.md) — the Web tab that shows the browser and sends marks.
- [browser-use-playwright-mcp](../browser-use-playwright-mcp/README.md) — the agent's browser tools, in attach mode.
- [tools](../../core/tools/README.md) — the `tools/pre-execute` and `tools/post-execute` events used for control and delivery.

-----

<a id="model-experience"></a>
## Model Experience

### System-prompt guidance

#### What the model sees

One paragraph in the system prompt, present only while `ask_user_to_mark` is visible in the calling scope.

##### Verbatim guidance

```markdown
The user watches your browser and desktop live and can mark things on them. Their marks arrive in <user_marks> after a tool result or as a message; they take priority over your plan. While the user holds control, your browser and desktop actions wait until it is handed back; an action chosen before the user's latest input is not run. The user may go back to an earlier step and mark what went wrong (<user_rewind>). Questions the user asks a separate assistant about the screen arrive as <user_side_question> for your information; do not answer them.
```

#### Token effect

Fixed and small, on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool's visibility is unchanged; it sits in the cached system prompt.

### Tool schema

#### What the model sees

The model sees the generated [`ask_user_to_mark` schema](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-co-canvas): one required `question` string.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged.

### Tool result

#### What the model sees

`ask_user_to_mark` returns the marks drawn while the question was open, in the format below, followed on image-capable routes by up to `maxCropsPerMessage` crops with the marks drawn on them, or a sentence saying that the user marked nothing.

#### Token effect

About one line per mark, at most `maxMarksPerMessage` lines, plus each crop's image cost.

#### KV Cache effect

Append-only; the result follows the reusable request prefix.

### Refused browser action

#### What the model sees

A browser call chosen before the user's latest marks, or before the user operated the page, fails without running, with this reason followed by the marks in the format below. On image-capable routes their crops follow with the next tool result, under a one-line `<user_marks>` note.

##### Verbatim reason

```markdown
This action was not run: the user acted on the screen after you chose it. Re-plan from their input below.
```

#### Token effect

Only when the user acts between the agent's choice and the call: one sentence plus about one line per mark.

#### KV Cache effect

Append-only; the failure is the call's tool result.

### Browser not started

#### What the model sees

While the shared browser could not start, every gated browser call fails without running, with this reason followed by the launch error.

##### Verbatim reason

```markdown
The shared browser failed to start, so browser tools cannot run. Do not start a browser yourself; tell the user it failed to start and show this error:
```

#### Token effect

Only after a failed launch: one sentence plus the error per browser call.

#### KV Cache effect

Append-only; the failure is the call's tool result.

### Side questions

#### What the model sees

After the side-question model answers, one user message waits in the inbox and arrives at the agent's next step boundary, or before the user's next prompt when the agent is idle; it does not start a turn.

##### Example message

```markdown
<user_side_question>
The user asked a separate assistant about the screen while you worked. This is for your information; do not answer it, and change your plan only if it shows you misunderstood the task.
Question: 这班几点到北京？是在哪个网站上？
Mark 1: box at (838, 362), 712×52 on the desktop (screen points): window "飞行网 · 机票查询" of Chromium-browser (pid 17432, window_id 4194307), at (18, 282) inside it
Answer (deepseek-official/deepseek-flash): 标记的 HU7604 航班 21:55 到达北京，价格 ¥640，是在"飞行网"的机票查询页面上看到的。
</user_side_question>
```

#### Token effect

Only when the user asks: the question, one line per mark, and the answer, as text. The side request itself is a separate model call outside the Session, billed to the side-question model.

#### KV Cache effect

Append-only; the message enters the Session history like any user message.

### Going back to a step

#### What the model sees

One user message that starts or joins a turn, with up to `maxCropsPerMessage` crops of the marks on image-capable routes, and a refusal of the gated call the agent had already chosen.

##### Example message

```markdown
<user_rewind step="2">
The user went back to step 2 of your work, after you ran click pid=17432 window_id=4194307 element_index=14, and marked where it went wrong.
The screen then: Chromium-browser · 飞行网 · 机票查询.
The user says: "日期错了，我要的是 11月21日，不是 20 日。请从这里重新查。"
What you did after that step, oldest first:
3. scroll direction="down" pid=17432
Return to the state of step 2 before continuing: undo or navigate back where you can. Actions such as submitting, paying, or sending cannot be undone; if you took one, tell the user instead of repeating it.
</user_rewind>
```

##### Verbatim reason for the refused action

```markdown
This action was not run: the user went back to an earlier step of your work and marked what went wrong. Their message follows; re-plan from it.
```

#### Token effect

Only when the user goes back: a few lines plus one line per later action, and each crop's image cost.

#### KV Cache effect

Append-only.

### Delivered marks

#### What the model sees

After a tool result, one additional user message when the user marked the page or handed control back. Image-capable routes also receive up to `maxCropsPerMessage` cropped screenshots of the marks.

##### Example

```markdown
<user_marks>
The user marked the shared browser (coordinates in page CSS pixels). Treat these marks as instructions:
1. box at (508, 233), 59×31 on "Orders" (http://127.0.0.1:8765/orders.html): button "Submit" (2nd of 2 button elements with this text), selector `div:nth-of-type(2) > button` — note: "This one — Plan B"
</user_marks>
```

#### Token effect

Only when the user acts: about one line per mark plus each crop's image cost.

#### KV Cache effect

Append-only; the message follows the tool result it is attached to.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One shared browser per Host** — every Session that attaches uses the same browser, and one question can be open at a time.
- **Marks are not stored outside the Session** — undelivered marks are lost when the Host restarts, and the timeline starts empty.
- **Going back does not undo** — the agent is told the earlier state and must return to it itself; submitted forms, payments, and sent messages stay done. The irreversible-action flag is a word match on tool arguments and can miss clicks that name no target.
- **One timeline per Host** — steps of every top-level conversation share one timeline.
- **Host-only browser** — the browser runs on the Host machine; remote execution environments are not supported.
- **Top frame only** — the toolbar and hit testing cover the main document, not iframes.
- **Visible to screenshots** — the agent's own page screenshots include the toolbar in a corner of the viewport.

- **Desktop: primary display only** — live frames, marks, and the marker cover the primary display; windows on other displays are not grounded.
- **Desktop: verified on Linux (X11)** — the Cua Driver runtime ships Windows and macOS binaries, but the desktop surface and the full-screen marker were exercised end to end only on Linux; window grounding depends on what `list_windows` reports on each platform.
- **Desktop: one runtime per surface** — the desktop surface reads the screen through its own Cua Driver runtime beside the computer-use provider's.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
