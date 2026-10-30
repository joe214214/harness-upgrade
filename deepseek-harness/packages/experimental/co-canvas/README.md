---
description: "Experimental co-canvas: a shared browser the user watches live, marks, and takes over while the agent works, with marks grounded to page elements and delivered with the agent's next tool result, for users and maintainers composing human-in-the-loop browser use."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-co-canvas

English | [中文](README.zh.md)

## Summary

`dsh-experimental-co-canvas` lets the user work in the same browser as the agent. It launches one Chromium that the agent's browser tools attach to, and the [co-canvas tab](../client-ui-co-canvas/README.md) shows it live. The user boxes, points at, or draws an arrow to an element, with an optional note; each mark is resolved to the element underneath (role, text, selector, and which look-alike it is) and reaches the agent with its next tool result. The user can pause the agent or take over. The agent can ask for a mark with `ask_user_to_mark` instead of guessing.

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
| `gatedTools` | `(^\|__)browser_` | Regular expression for the agent's browser tool names, bare or MCP-prefixed; matching calls wait while the user holds control |
| `maxMarksPerMessage` | `10` | Most marks listed in one delivery; older ones are counted |
| `maxCropsPerMessage` | `3` | Most cropped screenshots per delivery on image-capable routes; `0` disables them |
| `cropMargin` | `40` | Context pixels around a cropped mark |
| `askTimeoutMs` | `300000` | How long `ask_user_to_mark` waits |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### One browser, two controllers

The service launches a persistent Chromium context with a remote-debugging port. The agent's browser tools connect to that port; the service keeps its own Playwright handle on the same context. The active page is the most recently opened page that is still open, so the live view follows the tabs the agent opens.

### Live view

`frames` streams JPEG frames from the CDP screencast of the active page and reattaches when the active page changes. A slow reader receives only the newest frame. `follow` streams the URL, title, control holder, open question, and undelivered marks.

### Grounding a mark

The focus point of a mark is the centre of a box, the head of an arrow, or the point itself. `DOM.getNodeForLocation` finds the node there; a function evaluated on that node returns its tag, text, role, label, a CSS selector, and its position among elements with the same tag and text. A PNG crop around the mark is taken at the same time, so a later navigation does not change what the user marked.

### Delivery and control

A `tools/post-execute` listener attaches undelivered marks, and any handback since the last delivery, to the result of the agent's next tool call as one additional user message; the agent loop logs it with the result. A `tools/pre-execute` listener holds calls whose name matches `gatedTools` until control returns to the agent; if the user marked the page or held control after the agent chose such a call, the call is refused with the marks instead of run, so a stale action never reaches the page. User input is replayed through Playwright and refused unless the user holds control.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, config, Remote methods, tool hooks, `ask_user_to_mark` |
| [`src/browser.ts`](src/browser.ts) | Browser launch, active page, screencast, hit testing, crops, input |
| [`src/marks.ts`](src/marks.ts) | Model-facing mark text |
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
The user watches your browser live and can mark elements on it. Their marks arrive in <user_marks> after a tool result; they take priority over your plan. While the user holds control, your browser actions wait until it is handed back; a browser action chosen before the user's latest input is not run.
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

`ask_user_to_mark` returns the marks drawn while the question was open, in the format below, or a sentence saying that the user marked nothing.

#### Token effect

About one line per mark, at most `maxMarksPerMessage` lines.

#### KV Cache effect

Append-only; the result follows the reusable request prefix.

### Refused browser action

#### What the model sees

A browser call chosen before the user's latest input fails without running, with this reason followed by the marks in the format below:

```markdown
This browser action was not run: the user acted on the page after you chose it. Re-plan from their input below.
```

#### Token effect

Only when the user acts between the agent's choice and the call: one sentence plus about one line per mark.

#### KV Cache effect

Append-only; the failure is the call's tool result.

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
- **Top frame only** — hit testing resolves elements of the main document, not inside cross-origin iframes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
