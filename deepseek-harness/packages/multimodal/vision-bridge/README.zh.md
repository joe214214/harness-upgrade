---
description: "ask_image 工具：纯文本路由上的模型向配置的识图模型询问图片内容，只取回文字答案，供组合无图片输入路由的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-vision-bridge

[English](README.md) | 中文

## 概述

`dsh-vision-bridge` 让不能接收图片的模型也能用上图片。当 agent 运行在 `deepseek-v4-pro` 这类纯文本路由上时，它用 `ask_image` 针对一个图片文件提问；图片与问题交给配置的识图模型，只有该模型的文字答案返回。调用方模型的历史里永远不会出现它无法接收的图片块。适合在保留强文本模型作为主路由的同时，仍能读懂截图、示意图和扫描件。

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

与文件系统后端、附件存储和 LLM 运行时一起挂载，并指定识图模型。

### 最小配置

```yaml
- insert:
    - id: vision-bridge
      name: '@deepseek-ai/dsh-vision-bridge'
      config:
        model: deepseek-flash
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `''` | 回答模型的提供方；为空时使用调用方 agent 的提供方 |
| `model` | `deepseek-flash` | 负责回答的识图模型；未声明图片输入的模型会在调用时被拒绝 |
| `maxTokens` | `1500` | 一次回答的输出上限 |
| `timeoutMs` | `120000` | 一次回答的时限 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工具通过 `ctx.fs` 读取文件，用 `ctx.attachments.saveImage` 持久化，检查配置的模型是否声明了图片输入，然后通过 `ctx.llm.prepareCall` 发送一次辅助请求，其固定系统提示要求准确转录可见文字。流式块组装后只返回其中的文字。面向模型的源码：[`src/index.ts`](src/index.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [tool-fs](../../fs/tool-fs/README.zh.md) — 在纯文本路由上会拒绝的 `read_image`。
- [tool-read-document](../tool-read-document/README.zh.md) — 在支持图片的路由上返回页面图片。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`ask_image` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-vision-bridge)：必填的 `file_path` 与 `question` 字符串。

#### Token 影响

工具可见的每次请求都有固定的 schema 成本。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

### 工具结果

#### 模型看到什么

由 `<answer model="provider/model">` 包裹的回答模型文字。调用方模型的历史中不会出现图片块。

##### 辅助请求的系统提示原文

```markdown
You describe images for another assistant that cannot see them. Answer the question precisely and completely from the image: transcribe any text, error messages, numbers and labels exactly, and describe layout only as far as it matters for the question. Do not guess beyond what is visible.
```

#### Token 影响

答案受 `maxTokens` 限制。辅助请求单独计费，不属于调用方 Session 的上下文。

#### KV Cache 影响

对调用方 Session 只追加；辅助请求独立，与其不共享前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **答案不缓存** — 同一个问题问两次会发两次请求。
- **只接受图片文件** — PDF 页面与视频帧只有在其他工具把它们保存为文件后，才能经本工具到达纯文本路由。
- **辅助请求不记入 Session 日志** — 只有其答案作为工具结果被记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
