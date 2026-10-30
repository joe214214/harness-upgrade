---
description: "The co-canvas Web tab: a live view of the shared browser in the right Sidebar, with box, arrow and point marks, notes, and pause, take-over and hand-back controls, for users and maintainers enabling co-canvas in the Web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-co-canvas

English | [中文](README.zh.md)

## Summary

This optional browser plugin adds a Co-canvas tab to the right Sidebar. The tab shows the shared browser of [co-canvas](../co-canvas/README.md) live. Drag on the page to draw a box or an arrow, or click to place a point; text typed in the note field is attached to the next mark. Marks are listed, and removable, until the agent receives them. A question from the agent appears above the page with a button that sends the marks as the answer. Pause stops the agent's browser actions; Take over sends clicks, scrolling and typing to the page until Hand back.

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

Mount it next to the co-canvas Host service, as shown in the [co-canvas configuration](../co-canvas/README.md#use-this-package), then open the right Sidebar in a Session and choose Co-canvas. The plugin has no configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The browser entry mounts the generated `coCanvas` Remote and registers the tab type, body and title. The state and frame streams open when a tab subscribes and close after the last tab unmounts, so a closed tab costs no frames. Pointer positions are scaled from the displayed frame to page CSS pixels before they are sent. Source: [`src/client/index.ts`](src/client/index.ts), [`src/client/CanvasBody.tsx`](src/client/CanvasBody.tsx).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [co-canvas](../co-canvas/README.md) — the Host service, mark grounding, and what the agent receives.
- [ui-sidebar-right](../../client/ui-sidebar-right/README.md) — the Sidebar that hosts the tab.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [co-canvas service](../co-canvas/README.md#model-experience), which owns what the agent receives from the marks sent here.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web only** — the Desktop client does not load this tab.
- **Pointer and keyboard subset** — taking over forwards clicks, wheel scrolling, printable keys and common navigation keys; drag, hover and modifier shortcuts are not forwarded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
