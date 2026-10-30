---
description: "面向模型的 read_document 工具：由粗到细读取 PDF 与 Office 文件，没有文字层的页面在支持图片的路由上渲染为图片，供选择、配置或调试文档读取的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-read-document

[English](README.md) | 中文

## 概述

`dsh-tool-read-document` 让 agent 读取 PDF 与 Office 文档（`.pdf`、`.docx`、`.pptx`、`.xlsx`、`.odt` 等）。短文档整篇返回；长文档先返回逐页大纲，agent 再读取需要的页。扫描件、幻灯片、图表等没有可用文字层的页面，在当前模型接受图片时以页面图片返回。凡是 agent 需要依据规格书、论文、报告或扫描件工作的场景都适用；纯文本文件仍用 `read`。

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

与文件系统后端、子进程服务一起挂载；需要页面图片时，还需要附件存储和支持图片的模型路由。宿主机需要 poppler（`pdfinfo`、`pdftotext`、`pdftoppm`），Office 文件还需要 LibreOffice（`soffice`）；缺少程序时调用失败，并给出应安装的包。

### 最小配置

```yaml
- insert:
    - id: tool-read-document
      name: '@deepseek-ai/dsh-tool-read-document'
```

### 每次调用做什么

| 参数 | 结果 |
|---|---|
| 只有 `file_path`，短文档 | 每页文字，没有文字层的页面附带页面图片 |
| 只有 `file_path`，长文档或含扫描页 | 逐页大纲：每页的大小与首行，或"无文字层"标记 |
| `pages: "2-5"` | 这些页；`mode` 决定图片：`auto`（默认）只给没有文字层的页，`image` 给每一页，`text` 从不给 |

不能接收图片的路由，或没有附件存储的部署，会拿到文字，并在每个未返回图片的页面上附带说明。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxPagesPerCall` | `10` | 一次调用最多可选的页数 |
| `maxImagesPerCall` | `6` | 一次调用最多返回的页面图片数；其余页附带说明 |
| `textLayerMinChars` | `80` | 文字少于该字符数的页面视为没有文字层 |
| `renderDpi` | `110` | 页面图片分辨率 |
| `wholeTextMaxChars` | `12000` | 不带 `pages` 时整篇返回的最长文档 |
| `maxPageChars` | `20000` | 每页文字上限 |
| `commandTimeoutMs` | `120000` | 每条 poppler 或 LibreOffice 命令的时限 |
| `cacheDir` | `<tmpdir>/dsh-media-cache` | 提取文字的缓存 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **由粗到细。** 第一次调用代价低：整篇文字或大纲。页面需要显式选择，与 `read` 的行窗口同一思路。
- **先文字，必要时才用像素。** 文字只占图片代价的一小部分，而且精确；只有缺少文字或调用方需要版面时才用图片。
- **降级而不拒绝。** 纯文本路由仍能拿到除图片外的全部内容，并附带原因说明。

### 流程

1. 通过 `ctx.fs` 在 Session 工作目录中解析路径，并要求是普通文件。
2. Office 文件用 `soffice --headless --convert-to pdf` 转换到私有临时目录，并使用独立的 LibreOffice profile。
3. `pdfinfo` 给出页数；`pdftotext -layout` 一次给出所有页，按换页符切分。结果按 PDF 的 SHA-256 缓存，重命名或复制的文件可直接复用。
4. 需要图片的已选页逐页用 `pdftoppm` 渲染，并在返回结果前通过 `ctx.attachments.saveImage` 持久化。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、配置、工具定义、大纲、渲染 |
| [`src/pdf.ts`](src/pdf.ts) | poppler 与 LibreOffice 命令、分页 |

共享辅助（命令执行、缓存、页码选择、图片持久化）位于 [`dsh-media-core`](../media-core/README.zh.md)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [media-core](../media-core/README.zh.md) — 本工具使用的命令执行器、内容寻址缓存与图片辅助。
- [tool-fs](../../fs/tool-fs/README.zh.md) — 读取纯文本的 `read` 与读取单张图片的 `read_image`。
- [attachment](../../attachment/README.zh.md) — 页面图片背后的持久化图片存储。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示指引

#### 模型看到什么

系统提示中的一句话，仅在工具对调用作用域可见时出现，引导模型使用本工具而不是 shell 命令。

##### 指引原文

```markdown
Use the read_document tool — not shell tools like pdftotext or libreoffice — to read PDF and Office files. Call it without pages first for the outline, then request the pages you need.
```

#### Token 影响

固定且很小，出现在工具可见的每次请求中。

#### KV Cache 影响

工具可见性不变时前缀稳定；它位于被缓存的系统提示中。

### 工具 schema

#### 模型看到什么

模型看到生成的 [`read_document` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-read-document)：必填 `file_path`、描述中写明单次页数上限的可选 `pages`，以及可选 `mode`（`auto`、`text` 或 `image`）。

#### Token 影响

工具可见的每次请求都有固定的 schema 成本；描述只随 `maxPagesPerCall` 变化。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

### 工具结果

#### 模型看到什么

先是 `<path>` 与 `<pages>` 头部，然后是带"用 `pages` 再次调用"指引的逐页 `<outline>`，或每个所选页一个 `<page number="N">` 块。没有文字层的页以 `[no text layer]` 结尾；未返回图片的页附带原因。每张渲染出的页面图片以原生图片块紧随其页面块。

#### Token 影响

文字随所选页数增长，每页受 `maxPageChars` 限制；每张页面图片增加提供方的图片成本，并在压缩前一直留在历史中，压缩时 `compaction-image-offload` 可将其替换为文字引用。

#### KV Cache 影响

只追加；结果位于可复用的请求前缀之后，不会使已有条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只支持宿主机执行** — 工具把提供方的进程路径交给 poppler 与 LibreOffice，并把渲染结果写到宿主机临时目录，因此假定本地文件系统与子进程提供方在同一台机器上。
- **不重建版面** — 表格与多栏文字来自 `pdftotext -layout`；这种间距不够用时，调用方需要以 `mode: "image"` 请求该页。
- **不打开加密 PDF** — 会报告 poppler 的失败；没有密码参数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
