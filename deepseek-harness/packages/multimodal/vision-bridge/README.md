---
description: "The ask_image tool: a model on a text-only route asks a configured image-capable model about an image and receives only the text answer, for users and maintainers composing routes without image input."
kind: "package-reference"
---

# @deepseek-ai/dsh-vision-bridge

English | [中文](README.zh.md)

## Summary

`dsh-vision-bridge` lets a model that cannot take images still use them. When the agent runs on a text-only route, such as `deepseek-v4-pro`, it asks a question about an image file with `ask_image`; the image and question go to a configured image-capable model, and only that model's text answer returns. The calling model's history never carries an image block it could not accept. Use it to keep a strong text model as the main route while screenshots, diagrams, and scans remain readable.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with a filesystem backend, an attachment store, and the LLM runtime, and name the image-capable model.

### Minimal configuration

```yaml
- insert:
    - id: vision-bridge
      name: '@deepseek-ai/dsh-vision-bridge'
      config:
        model: deepseek-flash
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `''` | Provider of the answering model; empty uses the calling agent's provider |
| `model` | `deepseek-flash` | Image-capable model that answers; a model without image input is refused at call time |
| `maxTokens` | `1500` | Output cap of one answer |
| `timeoutMs` | `120000` | Deadline of one answer |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The tool reads the file through `ctx.fs`, commits it with `ctx.attachments.saveImage`, checks that the configured model declares image input, and sends one auxiliary request through `ctx.llm.prepareCall` with a fixed system prompt that asks for exact transcription of visible text. The streamed blocks are assembled and only their text is returned. Model-facing source: [`src/index.ts`](src/index.ts).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [tool-fs](../../fs/tool-fs/README.md) — `read_image`, which refuses on text-only routes.
- [tool-read-document](../tool-read-document/README.md) — returns page images on image-capable routes.

-----

<a id="model-experience"></a>
## Model Experience

### System-prompt guidance

#### What the model sees

One sentence in the system prompt, present only while the tool is visible in the calling scope, steering the model to this tool instead of shell commands.

##### Verbatim guidance

```markdown
When you cannot view an image yourself, ask about it with ask_image instead of guessing from its file name or surrounding text.
```

#### Token effect

Fixed and small, on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool's visibility is unchanged; it sits in the cached system prompt.

### Tool schema

#### What the model sees

The model sees the generated [`ask_image` schema](../../../docs/tool-catalog.md#deepseek-aidsh-vision-bridge): required `file_path` and `question` strings.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged.

### Tool result

#### What the model sees

`<answer model="provider/model">` wrapping the answering model's text. No image block enters the calling model's history.

##### Verbatim system prompt of the auxiliary request

```markdown
You describe images for another assistant that cannot see them. Answer the question precisely and completely from the image: transcribe any text, error messages, numbers and labels exactly, and describe layout only as far as it matters for the question. Do not guess beyond what is visible.
```

#### Token effect

The answer is capped by `maxTokens`. The auxiliary request is billed separately and is not part of the calling Session's context.

#### KV Cache effect

Append-only for the calling Session; the auxiliary request is independent and shares no prefix with it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Answers are not cached** — asking the same question twice sends two requests.
- **Image files only** — PDF pages and video frames reach a text-only route only through this tool after another tool saved them as files.
- **The auxiliary request is not logged in the Session** — only its answer, as the tool result, is.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
