---
description: "The agent bridge Web tab: share the open conversation with Claude Code, Codex, and Gemini CLI, open their sessions in it, and see shared memory, for users and maintainers enabling the agent bridge in the Web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-bridge

English | [中文](README.zh.md)

## Summary

This optional browser plugin adds an Agent bridge tab to the right Sidebar for the [agent bridge](../agent-bridge/README.md). Checkboxes share the open conversation with Claude Code, Codex, or Gemini CLI and show the command that continues it there. Sessions of those agents on this machine are listed, newest first, with a button that opens one in the conversation and keeps following it. Followed sessions show how many messages were relayed and can be stopped. The memory section shows where DeepSeek Harness memory was written and which memory files of the other agents the model can read.

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

Mount it next to the agent bridge Host service, as shown in the [agent bridge configuration](../agent-bridge/README.md#use-this-package), then open the right Sidebar in a Session and choose Agent bridge. The plugin has no configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The browser entry mounts the generated `agentBridge` Remote, keeps one state stream open for the plugin's lifetime, and registers the tab type, body, and title. The tab acts on the Session its Sidebar belongs to. Source: [`src/client/index.ts`](src/client/index.ts), [`src/client/BridgeBody.tsx`](src/client/BridgeBody.tsx).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [agent-bridge](../agent-bridge/README.md) — the Host service, the session formats, and what the agent receives.
- [ui-sidebar-right](../../client/ui-sidebar-right/README.md) — the Sidebar that hosts the tab.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [agent bridge service](../agent-bridge/README.md#model-experience): opening a session here asks the agent to summarise it, and sharing changes nothing the model sees.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web only** — the Desktop client does not load this tab.
- **Opening wakes the agent** — opening a session from the tab starts a turn in which the agent summarises it; opening through the agent's own tool does not.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
