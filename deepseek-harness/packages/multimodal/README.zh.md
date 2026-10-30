---
description: "multimodal 组导览：文档读取、共享媒体辅助，以及为纯文本路由提供的视觉桥接，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/multimodal

[English](README.md) | 中文

## 概述

multimodal 组让 agent 不只处理文本文件：PDF 与 Office 文档（包括扫描页），以及在模型无法接收图片的路由上使用图片。每个工具都由粗到细读取，长文档先付出大纲的代价，再只读 agent 请求的页。音频与视频读取基于实验性的语音 seam，因此放在 experimental 组，并共用本组的辅助库。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`media-core`](media-core/README.zh.md) | 共享库：经子进程 seam 执行媒体命令、内容寻址缓存、页码与时间窗口、图片持久化 | 库——无 ctx 键 |
| [`tool-read-document`](tool-read-document/README.zh.md) | 让 agent 读取 PDF 与 Office 文档，没有文字层的页面以图片返回 | 注册到 `ctx.tools` |
| [`vision-bridge`](vision-bridge/README.zh.md) | 让纯文本路由向识图模型询问图片内容 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [tool-read-audio](../experimental/tool-read-audio/README.zh.md) 与 [tool-read-video](../experimental/tool-read-video/README.zh.md) — 基于 `media-core` 的实验性音频与视频工具。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-read-document) — 模型收到的 schema。
- [attachment 组](../attachment/README.zh.md) — 页面图片与帧背后的持久化存储。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
