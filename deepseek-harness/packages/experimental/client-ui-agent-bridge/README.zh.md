---
description: "Agent 互通网页标签页：把当前对话共享给 Claude Code、Codex 和 Gemini CLI，把它们的会话打开到当前对话，并查看共享的记忆，供在网页客户端启用 Agent 互通的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-bridge

[English](README.md) | 中文

## 概述

这个可选的浏览器插件为 [Agent 互通](../agent-bridge/README.zh.md)在右侧边栏添加一个“Agent 互通”标签页。复选框把当前对话共享给 Claude Code、Codex 或 Gemini CLI，并显示在对方那里继续的命令。本机上这些 Agent 的会话按时间从新到旧列出，每个都有按钮，可以打开到当前对话并持续跟随。正在跟随的会话会显示已转发的消息数，也可以停止跟随。记忆部分显示 DeepSeek Harness 的记忆写到了哪里，以及模型可以读取其他 Agent 的哪些记忆文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

按 [Agent 互通配置](../agent-bridge/README.zh.md#use-this-package)与 Agent 互通 Host 服务一起挂载，然后在 Session 中打开右侧边栏并选择“Agent 互通”。本插件没有配置项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器入口挂载生成的 `agentBridge` Remote，在插件存续期间保持一个状态流，并注册标签页类型、主体和标题。标签页作用于它所在侧边栏对应的 Session。源码：[`src/client/index.ts`](src/client/index.ts)、[`src/client/BridgeBody.tsx`](src/client/BridgeBody.tsx)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [agent-bridge](../agent-bridge/README.zh.md) — Host 服务、会话格式，以及 agent 收到的内容。
- [ui-sidebar-right](../../client/ui-sidebar-right/README.zh.md) — 承载标签页的侧边栏。

-----

<a id="model-experience"></a>
## 模型体验

间接经由 [Agent 互通服务](../agent-bridge/README.zh.md#model-experience)：在这里打开会话会请 agent 总结它，共享则不改变模型看到的内容。

#### KV Cache 影响

没有直接影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限网页端** — 桌面客户端不加载此标签页。
- **打开会唤醒 agent** — 从标签页打开会话会开启一轮，由 agent 总结该会话；通过 agent 自己的工具打开则不会。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
