---
description: "Experimental co-canvas: a shared browser and desktop the user watches live, marks, discusses, and takes over while the agent works, with marks grounded to page elements or desktop windows and delivered with the agent's next tool result or as a message to discuss, for users and maintainers composing human-in-the-loop browser and computer use."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-co-canvas

English | [中文](README.zh.md)

## Summary

`dsh-experimental-co-canvas` lets the user work beside the agent in a shared browser and, with `desktop`, on the desktop. The user watches both live, marks them with a box, arrow or point and a note, and pauses the agent or takes over. Browser marks resolve to the element underneath; desktop marks name the window. Marks reach the agent with its next tool result, or, with **Ask the agent first**, as a message it answers before acting. **Mark on screen** freezes the real screen for direct marking. The agent can ask for a mark with `ask_user_to_mark`.

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

A `tools/post-execute` listener attaches undelivered marks, and any handback since the last delivery, to the result of the agent's next tool call as one additional user message; the agent loop logs it with the result. A `tools/pre-execute` listener holds calls whose name matches `gatedTools` or `gatedDesktopTools` until control returns to the agent; if the user marked the screen or operated it after the agent chose such a call, the call is refused with the marks instead of run, so a stale action never reaches the page; after a bare pause the call runs and the handback follows its result. If the browser failed to start, the listener refuses these calls with the launch error, which is also logged to the console and shown in the co-canvas tab. User input is replayed through Playwright and refused unless the user holds control.

### Desktop surface

With `desktop`, the service opens its own same-process Cua Driver runtime, separate from the computer-use provider's. `desktopFrames` streams JPEG frames of `get_desktop_state` screenshots, sized in screen points and scaled with sharp to `desktopMaxFrameEdge`. A desktop mark is grounded with `list_windows`: the frontmost visible window containing the focus point gives the title, application, pid, and window id, and the crop is cut from the screenshot the mark was drawn on. **Mark on screen** waits a few seconds, takes a screenshot, and shows it in a full-screen browser window with its own toolbar; the user draws marks with notes and chooses to send them, discuss them first, or cancel. The marker window always opens visibly, even beside a headless shared browser. The Web tab cannot replay input on the desktop: there the user takes over with the real mouse and keyboard, and the agent waits.

### Discussing marks

`discuss` takes the undelivered marks, pauses the agent, and steers its Session with one user message (source `dsh-co-canvas`, a `notice` with a one-line summary) that lists the marks and asks for a reply in text; crops follow on image-capable routes. While the discussion lasts, every gated browser or desktop call is refused at once instead of waiting, so a call already held by a pause returns and the agent can answer. The user's next own message in the Session, or Resume, ends the discussion without a handback note. Discussions go to the agent that most recently ran a tool or received a user message, or else the most recently loaded root conversation.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, config, Remote methods, tool hooks, `ask_user_to_mark` |
| [`src/browser.ts`](src/browser.ts) | Browser launch, active page, screencast, toolbar wiring, hit testing, crops, input |
| [`src/overlay.ts`](src/overlay.ts) | The in-page toolbar and its messages |
| [`src/marks.ts`](src/marks.ts) | Model-facing mark text |
| [`src/desktop.ts`](src/desktop.ts) | Desktop screenshots, live frames, window grounding, crops |
| [`src/screen-marker.ts`](src/screen-marker.ts) | Full-screen marking on a frozen screenshot |
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
The user watches your browser and desktop live and can mark things on them. Their marks arrive in <user_marks> after a tool result or as a message; they take priority over your plan. While the user holds control, your browser and desktop actions wait until it is handed back; an action chosen before the user's latest input is not run. When the user sends marks to discuss, answer in text before acting.
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

### Marks to discuss

#### What the model sees

When the user sends marks to discuss, one user message arrives at the next step boundary, or starts a turn when the agent is idle; image-capable routes also receive up to `maxCropsPerMessage` crops. Until the user replies or resumes, every gated browser or desktop call fails without running, with the verbatim reason below.

##### Example message

```markdown
<user_marks>
The user marked the desktop (coordinates in screen points):
1. box at (910, 389), 668×62 on the desktop (screen points): window "To-do (4)" (pid 8111, window_id 4194307), at (344, 340) inside it — note: "Is this a duplicate of the other Pay rent? Check with me first"
The user wants to talk about these marks before you continue. Reply in text: answer their notes or confirm what you understood. Do not operate the browser or the desktop until the user replies.
</user_marks>
```

##### Verbatim reason for a held action

```markdown
This action was not run: the user wants to discuss their marks with you first. Reply to them in text and do not operate the browser or the desktop until they reply.
```

#### Token effect

Only when the user asks: about one line per mark plus two sentences, and the image cost of each crop; one sentence per refused call.

#### KV Cache effect

Append-only; the message enters the Session history like any user message.

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
- **Marks are not stored outside the Session** — undelivered marks are lost when the Host restarts.
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
