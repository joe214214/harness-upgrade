---
description: "协同画布网页标签页：在右侧边栏实时显示共享浏览器，支持框选、箭头和点选标注、附言，以及暂停、接管和交还控制，供在网页客户端启用协同画布的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-co-canvas

[English](README.md) | 中文

## 概述

这个可选的浏览器插件在右侧边栏添加一个“协同画布”标签页，实时显示 [co-canvas](../co-canvas/README.zh.md) 的共享浏览器。在页面上拖动可画框或箭头，单击可放置一个点；附言输入框里的文字会附在下一个标注上。标注在 agent 收到之前一直列出，并可移除。agent 的问题显示在页面上方，并附有一个把标注作为回答发送的按钮。“暂停”让 agent 的浏览器操作停下；“接管”把点击、滚动和键盘输入发送到页面，直到点击“交还给 agent”。

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

按 [co-canvas 配置](../co-canvas/README.zh.md#use-this-package)与 co-canvas Host 服务一起挂载，然后在 Session 中打开右侧边栏并选择“协同画布”。本插件没有配置项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器入口挂载生成的 `coCanvas` Remote，并注册标签页类型、主体和标题。状态流和画面流在有标签页订阅时打开，最后一个标签页卸载后关闭，因此关闭的标签页不消耗画面。指针位置在发送前从显示的画面换算为页面 CSS 像素。源码：[`src/client/index.ts`](src/client/index.ts)、[`src/client/CanvasBody.tsx`](src/client/CanvasBody.tsx)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [co-canvas](../co-canvas/README.zh.md) — Host 服务、标注定位，以及 agent 收到的内容。
- [ui-sidebar-right](../../client/ui-sidebar-right/README.zh.md) — 承载标签页的侧边栏。

-----

<a id="model-experience"></a>
## 模型体验

间接经由 [co-canvas 服务](../co-canvas/README.zh.md#model-experience)，它负责这里发送的标注最终送达 agent 的内容。

#### KV Cache 影响

没有直接影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限网页端** — 桌面客户端不加载此标签页。
- **只转发部分指针与键盘操作** — 接管时转发点击、滚轮、可打印按键和常用导航键；拖拽、悬停和修饰键快捷键不转发。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
