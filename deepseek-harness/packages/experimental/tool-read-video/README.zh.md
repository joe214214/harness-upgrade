---
description: "实验性 read_video 工具：把视频的场景切换关键帧与语音合并为一条带时间戳的时间线，由粗到细读取，供选择、配置或调试视频读取的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-read-video

[English](README.md) | 中文

## 概述

`dsh-experimental-tool-read-video` 让 agent 能看视频，例如 bug 的屏幕录像、产品演示或录制的讲座。它在画面变化最大的时刻取关键帧，与说话内容一起合并为一条带时间戳的时间线。第一次调用用少量帧覆盖整段视频；agent 再围绕某个时刻缩小 `start` 与 `end`，同样的帧预算分布在更短的时间段上，就能看到更多细节。

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

与文件系统后端、子进程服务、附件存储和支持图片的模型路由一起挂载。语音转文字服务提供说话内容。宿主机需要 `ffmpeg` 与 `ffprobe`。在纯文本路由上或没有语音服务时，时间线保留可用的部分，并说明缺少了什么。

### 最小配置

```yaml
- insert:
    - id: tool-read-video
      name: '@deepseek-ai/dsh-experimental-tool-read-video'
```

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxFramesPerCall` | `8` | 一次调用返回的帧数 |
| `sampling` | `scene` | `scene` 保留第一帧与变化最大的时刻；`uniform` 均匀取帧（作为基线） |
| `minSceneScore` | `0.001` | 低于该值的场景得分视为编码噪声 |
| `minFrameGapSeconds` | `1` | 所选帧之间的最小间隔 |
| `frameMaxWidth` | `1024` | 更宽的帧会被缩小 |
| `maxDurationSeconds` | `14400` | 接受的最长文件 |
| `maxTranscriptChars` | `8000` | 一条时间线中包含的语音上限 |
| `commandTimeoutMs` | `300000` | 每条 ffmpeg 命令的时限 |
| `cacheDir` | `<tmpdir>/dsh-media-cache` | 转写缓存，与 `read_audio` 共享 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 帧选择

第一次 ffmpeg 扫描在 320 像素宽的副本上用场景检测器给窗口内每一帧打分。保留窗口第一帧，然后按得分从高到低选取高于 `minSceneScore` 的变化，每个与已选帧至少相隔 `minFrameGapSeconds`，直到 `maxFramesPerCall`；每帧取在变化点之后 0.3 秒，确保过渡已经稳定。随后对每个选定时间用输入定位提取一帧。之所以用排序代替固定阈值，是因为得分取决于内容：电影镜头切换得分高于 0.3，而屏幕录像中出现报错横幅只得 0.13，一行文字变化约 0.005。均匀模式把帧放在窗口等分片段的中点。

### 时间线

帧通过 `ctx.attachments.saveImage` 持久化。语音来自对整个文件的 `read_audio` 转写（按内容缓存），并按窗口过滤。帧与语音按时间排序，同一秒开始时帧在前。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、配置、工具定义、时间线渲染 |
| [`src/frames.ts`](src/frames.ts) | 场景打分、变化排序、均匀时间点、帧提取 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [tool-read-audio](../tool-read-audio/README.zh.md) — 时间线语音部分背后的转写。
- [media-core](../../multimodal/media-core/README.zh.md) — 探测、窗口与图片持久化。
- [compaction-image-offload](../../compaction/compaction-image-offload/README.zh.md) — 图片超出路由预算时把旧帧替换为文字引用。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`read_video` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-read-video)：必填 `file_path`、可选的 `start` 与 `end` 时间戳，以及可选的 `transcript` 布尔值。

#### Token 影响

工具可见的每次请求都有固定的 schema 成本。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

### 工具结果

#### 模型看到什么

先是 `<path>`、`<duration>`、`<window>` 头部与可能的 `<note>` 行，然后是时间线：`[MM:SS] frame N` 后接该帧的原生图片块，以及 `[MM:SS–MM:SS] said: 文字` 行，最后是"缩小 `start` 与 `end` 查看细节"的指引。

#### Token 影响

每次调用最多 `maxFramesPerCall` 张图片加最多 `maxTranscriptChars` 的语音。帧在压缩前留在历史中，压缩时 `compaction-image-offload` 可将其替换为文字引用。

#### KV Cache 影响

只追加；结果位于可复用的请求前缀之后，不会使已有条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **纯文本路由没有帧** — 时间线只包含语音与说明；不会替模型描述画面。
- **缓慢变化排名靠后** — 缓慢滚动把变化分散成许多小分数，帧预算可能被更明显的变化占用；缩小窗口或使用 `uniform` 采样可以覆盖。
- **只支持宿主机执行** — ffmpeg 在提供方的进程路径上运行，并把帧写到宿主机临时目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
