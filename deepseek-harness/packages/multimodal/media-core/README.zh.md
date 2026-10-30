---
description: "多模态读取工具的共享库：经子进程 seam 执行媒体命令、内容寻址的结果缓存、页码与时间窗口参数、ffprobe 信息与图片持久化，供构建或调试媒体工具的维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-media-core

[English](README.md) | 中文

## 概述

`dsh-media-core` 收纳 `read_document`、`read_audio` 与 `read_video` 共用的部分，让每个工具只需说明自己读什么。它经子进程 seam 运行 poppler 与 ffmpeg，限制明确并附带安装提示；按源文件内容缓存派生结果；以同一方式为所有工具解析页码与时间戳；用 `ffprobe` 读取流信息；并把渲染出的页面或帧持久化到附件存储。它不注册任何工具或服务。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

从注入了 `subprocess` 的工具插件中导入这些辅助（返回图片时还会读取 `attachments` 与 `llm`）。

| 导出 | 约定 |
|---|---|
| `runMediaCommand(ctx, request, installHint)` | 以明确的工作目录、时限和 stdout/stderr 上限运行一条命令直到结束；失败时抛出 `MediaCommandError`，code 为 `MEDIA_TOOL_MISSING`、`MEDIA_TOOL_FAILED` 或 `MEDIA_TOOL_TIMEOUT` |
| `MediaCache`、`hashFile` | 以源文件 SHA-256 加所有影响结果的参数为键的 JSON 条目；原子写入；损坏的条目视为未命中 |
| `parsePageSelection` | 按页数与单次上限解析 `"3"`、`"2-5"`、`"1,4-6"` |
| `parseTimestamp`、`formatTimestamp`、`resolveWindow` | 秒数、`MM:SS` 或 `HH:MM:SS`；窗口截断到时长，拒绝空窗口或越界窗口 |
| `probeMedia`、`parseProbe` | 时长与音视频流是否存在；附带的封面图不算视频 |
| `routeAcceptsImages` | 调用路由的确切模型是否声明了图片输入；无法解析的路由回答 false |
| `savePng`、`imageBlock`、`STORED_IMAGE_SCHEMA` | 把 PNG 存入 `ctx.attachments`，在工具值中保存其字段，并在渲染时重新生成图片块 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **辅助函数内部不设默认值。** 每个限制都是参数，由各工具经过校验的 `Config` 决定。
- **降级而不拒绝。** `routeAcceptsImages` 回答 false 而不是抛错，工具因此可以返回文字并附带说明。
- **看内容，不看名字。** 缓存键使用文件摘要，复制与重命名能命中，修改则不会。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/command.ts`](src/command.ts) | 可执行文件查找与收集式批量运行 |
| [`src/cache.ts`](src/cache.ts) | 摘要与 JSON 缓存 |
| [`src/ranges.ts`](src/ranges.ts) | 页码、时间戳、窗口 |
| [`src/probe.ts`](src/probe.ts) | ffprobe 解析 |
| [`src/images.ts`](src/images.ts) | 路由能力、PNG 持久化、图片块 |

</details>

-----

<a id="model-experience"></a>
## 模型体验

间接通过 read_document、read_audio 与 read_video 工具体现，它们拥有用这些辅助构建的所有模型可见 schema 与结果。

#### KV Cache 影响

本包自身没有影响；使用它的工具的结果都是只追加的。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **缓存条目从不淘汰** — 缓存目录会一直增长直到被删除；各工具默认把它指向临时目录。
- **只输出文本** — 命令把二进制结果写入文件；stdout 与 stderr 以文本形式按上限收集。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
