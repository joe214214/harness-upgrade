---
description: "实验性 read_audio 工具：通过语音 seam 生成音频与视频文件的带时间戳转写，按静音切段，长录音返回时间索引，供选择、配置或调试音频读取的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-read-audio

[English](README.md) | 中文

## 概述

`dsh-experimental-tool-read-audio` 让 agent 能听录音：会议、访谈、语音备忘或视频的音轨。它返回每行都带时间范围的转写，agent 可以准确引用某句话是何时说的。长录音先返回时间索引，agent 再用 `start` 与 `end` 读取需要的部分。转写经由语音 seam 完成，因此本地 SenseVoice 提供方或任何已注册的识别器都可以提供服务。

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

与文件系统后端、子进程服务，以及注册了提供方的语音转文字服务一起挂载（语音输入 bundle 提供 SenseVoice）。宿主机需要 `ffmpeg` 与 `ffprobe`。没有语音服务时工具仍会注册，每次调用会说明需要启用什么。

### 最小配置

```yaml
- insert:
    - id: tool-read-audio
      name: '@deepseek-ai/dsh-experimental-tool-read-audio'
```

### 每次调用做什么

| 参数 | 结果 |
|---|---|
| `file_path` | 以 `[MM:SS–MM:SS] 文字` 行给出的完整转写；超过 `maxTranscriptChars` 时改为时间索引 |
| `start`、`end` | 与该窗口重叠的片段；时间戳接受秒数、`MM:SS` 或 `HH:MM:SS` |

对一个文件的第一次调用会转写一次；之后的窗口读取，以及对同一文件的 `read_video` 调用，复用缓存的转写。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxSegmentSeconds` | `30` | 发给识别器的最长片段 |
| `minSegmentSeconds` | `8` | 值得在停顿处切开的最短片段；更短的尾段并入前一段 |
| `silenceNoise` | `-30dB` | 停顿检测的噪声下限 |
| `silenceSeconds` | `0.4` | 计为静音的最短停顿 |
| `maxDurationSeconds` | `14400` | 接受的最长文件 |
| `maxTranscriptChars` | `12000` | 改为时间索引前返回的转写大小 |
| `indexBlockSeconds` | `300` | 时间索引中每一项的时长 |
| `commandTimeoutMs` | `300000` | 每条 ffmpeg 命令的时限 |
| `cacheDir` | `<tmpdir>/dsh-media-cache` | 转写缓存，与 `read_video` 共享 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 为什么是片段级时间戳

语音 seam 只返回文字，不带时间戳。因此工具先运行 `ffmpeg silencedetect`，规划最长 `maxSegmentSeconds`、在停顿中点结束的片段，再逐段转写；每段的起止就是它的时间戳。在停顿处切开能保持句子完整，完全处于静音中的片段不会发给识别器。

### 音频格式

每个片段解码为 16 kHz 单声道 PCM16 原始数据，再由工具自己写入标准的 44 字节 WAV 头。ffmpeg 的 WAV 封装器可能添加 `LIST` 块，而语音提供方会拒绝它。样本不足 0.1 秒的片段会被跳过。

### 缓存

整个文件的转写按文件 SHA-256、提供方 id、语言与切段参数组成的键缓存：更换提供方或设置会重新转写，重命名文件则不会。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、配置、工具定义、窗口、时间索引 |
| [`src/segment.ts`](src/segment.ts) | 静音解析与片段规划 |
| [`src/transcribe.ts`](src/transcribe.ts) | 片段提取、WAV 头、语音 seam 调用、缓存 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [speech-to-text](../speech-to-text/README.zh.md) — 本工具使用的语音 seam。
- [tool-read-video](../tool-read-video/README.zh.md) — 其时间线的语音部分复用这里的转写。
- [media-core](../../multimodal/media-core/README.zh.md) — 命令执行器、缓存与时间戳辅助。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示指引

#### 模型看到什么

系统提示中的一句话，仅在工具对调用作用域可见时出现，引导模型使用本工具而不是 shell 命令。

##### 指引原文

```markdown
Use the read_audio tool — not shell tools like ffmpeg or whisper — to transcribe recordings, and cite the timestamps it returns.
```

#### Token 影响

固定且很小，出现在工具可见的每次请求中。

#### KV Cache 影响

工具可见性不变时前缀稳定；它位于被缓存的系统提示中。

### 工具 schema

#### 模型看到什么

模型看到生成的 [`read_audio` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-read-audio)：必填 `file_path` 与可选的 `start`、`end` 时间戳。

#### Token 影响

工具可见的每次请求都有固定的 schema 成本。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

### 工具结果

#### 模型看到什么

先是 `<path>`、`<duration>` 与 `<window>` 头部，然后是 `[MM:SS–MM:SS] 文字` 行组成的 `<transcript>`、未识别到语音的说明，或带每段预览与"用 `start`、`end` 再次调用"指引的 `<index>`。

#### Token 影响

受 `maxTranscriptChars` 限制；更长的窗口改为返回索引。结果在压缩前留在历史中。

#### KV Cache 影响

只追加；结果位于可复用的请求前缀之后，不会使已有条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有片段级时间戳** — 一行的时间范围就是其片段的范围，最长 `maxSegmentSeconds`；词级时间需要能报告它的识别器。
- **没有说话人标签** — 转写不区分说话人。
- **依赖实验性 seam** — 语音 seam 是实验性的，本工具也因此是实验性的。
- **只支持宿主机执行** — ffmpeg 在提供方的进程路径上运行，并把片段写到宿主机临时目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
