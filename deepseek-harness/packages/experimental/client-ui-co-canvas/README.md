---
description: "The co-canvas Web tab: a live view of the shared browser and desktop in the right Sidebar, with marks, a task brief, side questions answered by a light model, a timeline to go back to, and pause, take-over and hand-back controls, for users and maintainers enabling co-canvas in the Web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-co-canvas

English | [中文](README.zh.md)

## Summary

This optional browser plugin adds a Co-canvas tab to the right Sidebar: the live shared browser of [co-canvas](../co-canvas/README.md), and the desktop when the Host enables it, under a Task card. Draw a box, arrow or point to mark. **Ask** sends a question about the marks to a light model chosen in the Questions section. The Timeline lists the agent's actions; picking one pauses the agent and shows that screen to mark, ask about, or send the agent back to with **Went wrong here**. Pause freezes the view; Take over hands over control until Hand back.

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

The browser entry mounts the generated `coCanvas` Remote and registers the tab type, body and title. The state and frame streams open when a tab subscribes and close after the last tab unmounts, so a closed tab costs no frames. Pointer positions are scaled from the displayed frame to page CSS pixels, or to screen points on the desktop, before they are sent; each surface streams frames only while it is shown. Marks drawn on a timeline step stay in the tab until they are asked about or sent back with the step; the step's frame is fetched once when it is selected. The model list loads when the model menu is first opened. Source: [`src/client/index.ts`](src/client/index.ts), [`src/client/CanvasBody.tsx`](src/client/CanvasBody.tsx), [`src/client/Brief.tsx`](src/client/Brief.tsx), [`src/client/TimelineStrip.tsx`](src/client/TimelineStrip.tsx), [`src/client/Answers.tsx`](src/client/Answers.tsx).

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
