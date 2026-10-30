---
description: "实验性协同画布：用户实时查看、标注并接管 agent 正在使用的共享浏览器；标注定位到页面元素，随 agent 的下一个工具结果送达，供组合人机协同浏览器操作的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-co-canvas

[English](README.md) | 中文

## 概述

`dsh-experimental-co-canvas` 让用户和 agent 在同一个浏览器里协作。它启动一个 Chromium，agent 的浏览器工具连接到它，[协同画布标签页](../client-ui-co-canvas/README.zh.md)实时显示它。用户框选、点选某个元素或画箭头指向它，并附上一句话；每个标注都会定位到下方的元素（角色、文字、选择器，以及它是哪一个相似元素），随 agent 的下一个工具结果送达。用户可以暂停 agent 或接管页面。agent 也可以用 `ask_user_to_mark` 请用户标注，而不是自己猜。

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

与协同画布标签页，以及一个以 attach 模式指向 `debugPort` 的 browser-use 提供方一起挂载。协同画布条目要放在浏览器提供方之前，这样 Session 连接时浏览器已经在运行。

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

| 字段 | 默认值 | 含义 |
|---|---|---|
| `debugPort` | `9333` | agent 的浏览器工具连接的 CDP 端口 |
| `headless` | `true` | 不显示窗口运行；标签页都会显示页面 |
| `executablePath` | — | Chromium 可执行文件；优先于 `channel` |
| `channel` | — | 已安装的浏览器通道，例如 `chrome` 或 `msedge` |
| `userDataDir` | `<tmpdir>/dsh-co-canvas-profile` | 浏览器配置目录 |
| `startUrl` | `about:blank` | 启动时打开的页面 |
| `viewportWidth`、`viewportHeight` | `1280`、`800` | 视口大小（CSS 像素） |
| `frameQuality` | `60` | 实时画面的 JPEG 质量 |
| `gatedTools` | `(^\|__)browser_` | 匹配 agent 浏览器工具名称的正则表达式，带或不带 MCP 前缀均可；用户持有控制权时匹配的调用会等待 |
| `maxMarksPerMessage` | `10` | 一次送达最多列出的标注数；更早的只给出数量 |
| `maxCropsPerMessage` | `3` | 支持图片的路由上每次送达最多附带的截图数；`0` 表示不附带 |
| `cropMargin` | `40` | 截图在标注四周保留的像素 |
| `askTimeoutMs` | `300000` | `ask_user_to_mark` 的等待时限 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 一个浏览器，两个控制方

服务启动一个带远程调试端口的持久 Chromium 上下文。agent 的浏览器工具连接这个端口；服务在同一上下文上保留自己的 Playwright 句柄。活动页是最近打开且仍未关闭的页面，因此实时画面会跟随 agent 打开的标签页。

### 实时画面

`frames` 从活动页的 CDP screencast 推送 JPEG 画面，活动页变化时重新连接。读取较慢时只收到最新一帧。`follow` 推送 URL、标题、控制方、待回答的问题和未送达的标注。

### 标注定位

标注的焦点是框的中心、箭头的末端或点本身。`DOM.getNodeForLocation` 找到该处的节点；在节点上执行的函数返回它的标签、文字、角色、标签名、CSS 选择器，以及它在同标签同文字元素中的位置。同时截取标注周围的 PNG，之后页面跳转也不会改变用户标注的内容。

### 送达与控制权

`tools/post-execute` 监听器把未送达的标注，以及上次送达后的控制权交还，作为一条附加用户消息附在 agent 下一次工具调用的结果上；agent 循环会将它与结果一起记录。`tools/pre-execute` 监听器在控制权回到 agent 之前，挂起名称匹配 `gatedTools` 的调用；如果 agent 选定这样的调用之后用户标注了页面或持有过控制权，该调用不会执行，而是带着标注被拒绝，因此过时的操作不会作用到页面上。用户输入经 Playwright 重放，只有用户持有控制权时才被接受。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、Remote 方法、工具钩子、`ask_user_to_mark` |
| [`src/browser.ts`](src/browser.ts) | 浏览器启动、活动页、screencast、命中测试、截图、输入 |
| [`src/marks.ts`](src/marks.ts) | 面向模型的标注文字 |
| [`src/types.ts`](src/types.ts) | 与网页标签页共享的类型 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [client-ui-co-canvas](../client-ui-co-canvas/README.zh.md) — 显示浏览器并发送标注的网页标签页。
- [browser-use-playwright-mcp](../browser-use-playwright-mcp/README.zh.md) — agent 的浏览器工具，以 attach 模式运行。
- [tools](../../core/tools/README.zh.md) — 用于控制权与送达的 `tools/pre-execute` 和 `tools/post-execute` 事件。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示指引

#### 模型看到什么

系统提示中的一段话，仅在 `ask_user_to_mark` 对调用作用域可见时出现。

##### 指引原文

```markdown
The user watches your browser live and can mark elements on it. Their marks arrive in <user_marks> after a tool result; they take priority over your plan. While the user holds control, your browser actions wait until it is handed back; a browser action chosen before the user's latest input is not run.
```

#### Token 影响

固定且很小，出现在工具可见的每次请求中。

#### KV Cache 影响

工具可见性不变时前缀稳定；它位于被缓存的系统提示中。

### 工具 schema

#### 模型看到什么

模型看到生成的 [`ask_user_to_mark` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-co-canvas)：一个必填的 `question` 字符串。

#### Token 影响

工具可见的每次请求都有固定的 schema 成本。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

### 工具结果

#### 模型看到什么

`ask_user_to_mark` 返回问题待回答期间画下的标注，格式如下；用户没有标注时返回一句说明。

#### Token 影响

每个标注约一行，最多 `maxMarksPerMessage` 行。

#### KV Cache 影响

只追加；结果位于可复用的请求前缀之后。

### 被拒绝的浏览器操作

#### 模型看到什么

在用户最新输入之前选定的浏览器调用不会执行而直接失败，原因是下面这句话，后面跟着下文格式的标注：

```markdown
This browser action was not run: the user acted on the page after you chose it. Re-plan from their input below.
```

#### Token 影响

只在用户于 agent 选定与调用之间操作时出现：一句话，另加每个标注约一行。

#### KV Cache 影响

只追加；该失败就是这次调用的工具结果。

### 送达的标注

#### 模型看到什么

用户标注页面或交还控制权后，在一个工具结果之后附加一条用户消息。支持图片的路由还会收到最多 `maxCropsPerMessage` 张标注截图。

##### 示例

```markdown
<user_marks>
The user marked the shared browser (coordinates in page CSS pixels). Treat these marks as instructions:
1. box at (508, 233), 59×31 on "Orders" (http://127.0.0.1:8765/orders.html): button "Submit" (2nd of 2 button elements with this text), selector `div:nth-of-type(2) > button` — note: "This one — Plan B"
</user_marks>
```

#### Token 影响

只在用户操作时出现：每个标注约一行，另加每张截图的图片成本。

#### KV Cache 影响

只追加；消息跟在它所附着的工具结果之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每个 Host 一个共享浏览器** — 连接的所有 Session 使用同一个浏览器，同一时间只能有一个待回答的问题。
- **标注不在 Session 之外保存** — Host 重启时未送达的标注会丢失。
- **浏览器只运行在 Host 上** — 浏览器运行在 Host 机器上，不支持远程执行环境。
- **只处理顶层文档** — 命中测试只解析主文档中的元素，不进入跨域 iframe。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
