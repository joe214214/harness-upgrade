---
description: "实验性协同画布：用户实时查看、标注、提问、回溯并接管 agent 正在使用的共享浏览器和桌面；标注定位到页面元素或桌面窗口，提问由轻量模型回答，agent 的每步操作记录在时间轴上，供组合人机协同浏览器与桌面操作的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-co-canvas

[English](README.md) | 中文

## 概述

`dsh-experimental-co-canvas` 让用户在共享浏览器中与 agent 协作；开启 `desktop` 后也可以在桌面上协作：实时查看、标注、暂停 agent 或接管操作。标注定位到下方的元素或窗口；用户发出后，随 agent 的下一个工具结果送达。**问一下**把关于标注的问题交给轻量模型，它根据 agent 工作时记录的任务背景，几秒内作答；agent 继续工作，并以知会的形式收到回答。时间轴保存每次操作后的画面，用户可以让 agent 回到任意一步。

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
| `pageToolbar` | `true` | 向浏览器窗口的每个页面注入标注工具栏 |
| `gatedTools` | `(^\|__)browser_` | 匹配 agent 浏览器工具名称的正则表达式，带或不带 MCP 前缀均可；用户持有控制权时匹配的调用会等待 |
| `maxMarksPerMessage` | `10` | 一次送达最多列出的标注数；更早的只给出数量 |
| `maxCropsPerMessage` | `3` | 支持图片的路由上每次送达最多附带的截图数；`0` 表示不附带 |
| `cropMargin` | `120` | 截图在标注四周保留的像素 |
| `askTimeoutMs` | `300000` | `ask_user_to_mark` 的等待时限 |
| `desktop` | `false` | 把主显示器作为第二个画面；与 computer use 提供方一起挂载，例如 [Cua Driver native](../computer-use-cua-driver-native/README.zh.md) |
| `desktopFrameIntervalMs` | `1000` | 两帧桌面实时画面之间的间隔 |
| `desktopMaxFrameEdge` | `1600` | 桌面实时画面最长边的像素数 |
| `gatedDesktopTools` | Cua Driver 的操作类工具 | 匹配 agent 桌面操作工具名称的正则表达式；与 `gatedTools` 一样，用户持有控制权时匹配的调用会等待 |
| `hiddenTools` | 空 | 匹配要对每个 agent 隐藏的全局工具的正则表达式，通过工具注册表的按 agent 限制实现，例如与共享浏览器重复的 computer use 工具；为空则不隐藏 |
| `ignoredWindows` | Windows 上不可见的覆盖窗口 | 匹配不会被当作标注或操作目标的窗口的正则表达式，按标题或应用名匹配，例如覆盖整个屏幕的 NVIDIA 覆盖层；为空则不忽略 |
| `dataDir` | `~/.dsh-co-canvas` | 时间轴画面和标签页设置 |
| `askProvider` | 空 | 回答提问的模型的提供方；为空时使用第一个有 API 密钥且提供该模型的提供方 |
| `askModel` | `deepseek-flash` | 回答提问并整理任务背景的模型，用户在标签页中另选之前使用它 |
| `askMaxTokens` | `600` | 一次回答的输出上限 |
| `sideTimeoutMs` | `60000` | 一次回答的时限 |
| `timelineMaxSteps` | `300` | 时间轴最多保留的步数；更早的画面会被删除 |
| `timelineSettleMs` | `400` | 操作后等待多久再记录画面 |
| `briefEverySteps` | `4` | 每隔多少次操作刷新一次任务背景摘要 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 一个浏览器，两个控制方

服务启动一个带远程调试端口的持久 Chromium 上下文。agent 的浏览器工具连接这个端口；服务在同一上下文上保留自己的 Playwright 句柄。活动页是最近打开且仍未关闭的页面，因此实时画面会跟随 agent 打开的标签页。调试端口已被占用时（例如被另一个 DeepSeek Harness 窗口占用），启动会立即失败并说明原因，而不是等到浏览器的启动超时。

### 实时画面

`frames` 从活动页的 CDP screencast 推送 JPEG 画面，活动页变化时重新连接。读取较慢时只收到最新一帧。`follow` 推送 URL、标题、控制方、待回答的问题和未送达的标注。

### 页面内工具栏

开启 `pageToolbar` 时，每个顶层文档都会出现一个小工具栏：附言输入框、“标注”和“暂停/继续”按钮，以及 agent 待回答的问题和发送标注的按钮。它运行在隔离环境中；它上报所用的 binding 只存在于该环境，因此页面自身的脚本无法发送标注，而且它只接受可信（用户产生的）事件。它的宿主元素带有 `aria-hidden`，页面的无障碍快照不包含它。`document.open()` 会清除文档中的所有监听器，因此宿主一旦离开文档，工具栏就会整体重建。

### 标注定位

标注的焦点是框的中心、箭头的末端或点本身。`DOM.getNodeForLocation` 找到该处的节点；在节点上执行的函数返回它的标签、文字、角色、标签名、CSS 选择器，以及它在同标签同文字元素中的位置。期间工具栏会被隐藏。同时截取标注周围 `cropMargin` 像素的 PNG，并在图上画出标注，之后页面跳转也不会改变用户标注的内容。

### 送达与控制权

画出的标注先是草稿：用户用 `send` 发出之前，agent 看不到它；发出时，用户写的文字附在最后一个草稿上；agent 空闲时不会有下一步，所以发给它的标注会开启一个新回合。针对草稿提问会用掉这些草稿而不发出，因此用户还在输入问题时，问题不会变成指令。`tools/post-execute` 监听器把已发出的标注，以及上次送达后的控制权交还，作为一条附加用户消息附在 agent 下一次工具调用的结果上；agent 循环会将它与结果一起记录。`tools/pre-execute` 监听器在控制权回到 agent 之前，挂起名称匹配 `gatedTools` 或 `gatedDesktopTools` 的调用；如果 agent 选定这样的调用之后用户标注了画面或亲自操作过，该调用不会执行，而是带着标注被拒绝，因此过时的操作不会作用到页面上；如果用户只是暂停后继续，调用照常执行，交还说明随其结果送达。如果浏览器启动失败，监听器会带着启动错误拒绝这些调用，该错误同时输出到控制台并显示在协同画布标签页中。用户输入经 Playwright 重放，只有用户持有控制权时才被接受。agent 暂停期间，`frames` 和 `desktopFrames` 停止读取画面来源，画面停在最后一帧，用户在静止的画面上标注；这期间不截取桌面，桌面标注的截图取自这一帧。点“继续”或“接管”后恢复实时画面。

### 桌面画面

开启 `desktop` 后，服务会打开自己的同进程 Cua Driver 运行时，与 computer use 提供方的运行时互不影响。`desktopFrames` 以 `get_desktop_state` 截图生成 JPEG 实时画面，尺寸以屏幕点为单位，并用 sharp 缩放到 `desktopMaxFrameEdge`。桌面标注用 `list_windows` 定位：包含焦点的最前面的可见窗口给出标题、应用、pid 和窗口 id；截图取自标注时所用的那张屏幕截图。**在屏幕上框选**会等几秒、截一张屏，再在全屏浏览器窗口中显示它和一个工具栏；用户画出标注并附上说明，然后选择发送、问一下或取消。即使共享浏览器以无窗口方式运行，这个标注窗口也总会显示出来。网页标签页不能在桌面上重放输入：用户接管时直接使用真实的鼠标和键盘，agent 等待。

### 任务背景

任务背景记录目标、agent 最近一次操作所在的应用、窗口和页面，以及一行进展摘要。目标最初取自用户的请求；位置取自每一步记录（操作指定的窗口，否则是最前面的窗口，通过 `list_windows` 获取；浏览器中则是页面标题和网址）。每 `briefEverySteps` 次操作、每次收到新请求后，以及 agent 一轮结束时（带上它的最终回复），回答提问的模型会在 agent 的执行路径之外，根据最近三条请求和十二次操作重写目标和进展。面板会显示 agent 这一轮是否仍在运行。用户在标签页中修改的目标会一直保留，直到清空。

### 提问

`ask` 取用草稿标注（之后 agent 也不会收到它们），或取用户画在某个时间轴步骤画面上的标注，向回答提问的模型发一次请求：任务背景、最近八次操作、每个标注的描述，以及在能识图的模型上附带标注的截图（没有标注时，附 agent 最近一次桌面操作所在的窗口，或浏览器页面），推理强度取该模型最低的一档。回答以流式显示在标签页中。除非用户开启了“问的时候暂停 Agent”，agent 会继续工作。回答完成后，这组问答被放进 agent 的收件箱，在它下一个步骤时送达，不会唤醒它；这条用户消息会告诉 agent 不必回答。模型在标签页中从所有有 API 密钥的提供方的全部模型里选择，和暂停选项一起保存在 `dataDir`。

### 时间轴与回溯

`tools/post-execute` 监听器记录顶层 agent 的每个受控调用：等 `timelineSettleMs` 后，保存浏览器页面或桌面的 JPEG、工具名、一行参数，以及所在的窗口或页面。记录在模型思考期间进行；下一个受控调用会等它完成，因此每一帧都是该操作留下的画面。参数中提到提交、支付、下单、发送、删除、确认或预订，或按下 Enter 的操作，会被标为可能无法撤销。画面保存在 `dataDir/timeline` 下，服务启动时清空。在标签页中选中一步会暂停 agent 并显示那一帧。`rewind` 拒绝 agent 的下一个受控调用一次，并向它的 Session 发出一条消息：那一步、用户的标注和说明、之后做过的操作，以及先回到那个状态再继续的要求；agent 随即继续运行。系统不会自动撤销任何操作。

### 子 agent

标注、提问的回答、回溯和时间轴都属于用户看到的那段对话：最近一次运行工具或收到用户消息的顶层 agent；如果没有，则是最近加载的顶层对话。子 agent 的浏览器和桌面操作在用户掌控时同样等待，但它的工具结果不携带标注，也不会记录到时间轴上。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、Remote 方法、工具钩子、`ask_user_to_mark` |
| [`src/browser.ts`](src/browser.ts) | 浏览器启动、活动页、screencast、工具栏接线、命中测试、截图、输入 |
| [`src/overlay.ts`](src/overlay.ts) | 页面内工具栏及其消息 |
| [`src/marks.ts`](src/marks.ts) | 面向模型的标注文字 |
| [`src/desktop.ts`](src/desktop.ts) | 桌面截图、实时画面、窗口定位、截图裁剪 |
| [`src/screen-marker.ts`](src/screen-marker.ts) | 在冻结的屏幕截图上全屏标注 |
| [`src/brief.ts`](src/brief.ts) | 任务背景及其摘要请求 |
| [`src/sidecar.ts`](src/sidecar.ts) | 回答提问的模型选择与请求 |
| [`src/timeline.ts`](src/timeline.ts) | 时间轴步骤、画面、截图，以及不可撤销操作的判断 |
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
The user watches your browser and desktop live and can mark things on them. Their marks arrive in <user_marks> after a tool result or as a message; they take priority over your plan. While the user holds control, your browser and desktop actions wait until it is handed back; an action chosen before the user's latest input is not run. The user may go back to an earlier step and mark what went wrong (<user_rewind>). Questions the user asks a separate assistant about the screen arrive as <user_side_question> for your information; do not answer them.
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

`ask_user_to_mark` 返回问题待回答期间画下的标注，格式如下，在支持图片的路由上其后附最多 `maxCropsPerMessage` 张画有标注的截图；用户没有标注时返回一句说明。

#### Token 影响

每个标注约一行，最多 `maxMarksPerMessage` 行，另加每张截图的图片成本。

#### KV Cache 影响

只追加；结果位于可复用的请求前缀之后。

### 被拒绝的浏览器操作

#### 模型看到什么

在用户最新标注之前、或在用户亲自操作页面之前选定的浏览器调用不会执行而直接失败，原因是下面这句话，后面跟着下文格式的标注。在支持图片的路由上，这些标注的截图会随下一个工具结果送达，并附一行 `<user_marks>` 说明。

##### 原因原文

```markdown
This action was not run: the user acted on the screen after you chose it. Re-plan from their input below.
```

#### Token 影响

只在用户于 agent 选定与调用之间操作时出现：一句话，另加每个标注约一行。

#### KV Cache 影响

只追加；该失败就是这次调用的工具结果。

### 浏览器未启动

#### 模型看到什么

共享浏览器未能启动时，每个受控的浏览器调用都不会执行而直接失败，原因是下面这句话，后面跟着启动错误。

##### 原因原文

```markdown
The shared browser failed to start, so browser tools cannot run. Do not start a browser yourself; tell the user it failed to start and show this error:
```

#### Token 影响

只在启动失败后出现：每次浏览器调用一句话加错误信息。

#### KV Cache 影响

只追加；该失败就是这次调用的工具结果。

### 提问

#### 模型看到什么

回答提问的模型答完后，一条用户消息在收件箱中等待，在 agent 的下一个步骤边界送达；agent 空闲时，排在用户的下一条提问之前，不会开启新回合。

##### 示例消息

```markdown
<user_side_question>
The user asked a separate assistant about the screen while you worked. This is for your information; do not answer it, and change your plan only if it shows you misunderstood the task.
Question: 这班几点到北京？是在哪个网站上？
Mark 1: box at (838, 362), 712×52 on the desktop (screen points): window "飞行网 · 机票查询" of Chromium-browser (pid 17432, window_id 4194307), at (18, 282) inside it
Answer (deepseek-official/deepseek-flash): 标记的 HU7604 航班 21:55 到达北京，价格 ¥640，是在"飞行网"的机票查询页面上看到的。
</user_side_question>
```

#### Token 影响

只在用户提问时出现：问题、每个标注一行，以及回答，均为文字。提问本身是 Session 之外的一次单独模型调用，计入回答提问的模型。

#### KV Cache 影响

只追加；这条消息像普通用户消息一样进入 Session 历史。

### 回到某一步

#### 模型看到什么

一条开启或加入回合的用户消息，在支持图片的路由上附带最多 `maxCropsPerMessage` 张标注截图；agent 已经选定的那个受控调用会被拒绝。

##### 示例消息

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

##### 被拒绝操作的原文

```markdown
This action was not run: the user went back to an earlier step of your work and marked what went wrong. Their message follows; re-plan from it.
```

#### Token 影响

只在用户回溯时出现：几行说明，之后每个操作一行，以及每张截图的图片开销。

#### KV Cache 影响

只追加。

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
- **标注不在 Session 之外保存** — Host 重启时未送达的标注会丢失，时间轴从空开始。
- **回溯不会撤销操作** — agent 会被告知之前的状态，需要自己回到那里；已提交的表单、付款和发出的消息不会撤回。不可撤销的标记靠工具参数中的词语匹配，可能漏掉没有写明目标的点击。
- **每个 Host 一条时间轴** — 所有顶层对话的步骤共用一条时间轴。
- **浏览器只运行在 Host 上** — 浏览器运行在 Host 机器上，不支持远程执行环境。
- **只处理顶层文档** — 工具栏与命中测试只覆盖主文档，不进入 iframe。
- **截图中可见** — agent 自己的页面截图会在视口角落包含工具栏。

- **桌面：只覆盖主显示器** — 实时画面、标注和全屏标注窗口都只针对主显示器；其他显示器上的窗口不会被定位。
- **桌面：已在 Linux（X11）上验证** — Cua Driver 运行时自带 Windows 和 macOS 二进制，但桌面画面和全屏标注只在 Linux 上做过端到端验证；窗口定位取决于各平台 `list_windows` 的返回。
- **桌面：每个画面一个运行时** — 桌面画面通过自己的 Cua Driver 运行时读取屏幕，与 computer use 提供方的运行时并存。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
