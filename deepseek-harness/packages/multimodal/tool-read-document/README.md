---
description: "The model-facing read_document tool: PDF and Office files read coarse to fine, with pages that lack a text layer rendered to images for image-capable routes, for users and maintainers choosing, configuring, or debugging document reading."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-read-document

English | [中文](README.zh.md)

## Summary

`dsh-tool-read-document` lets the agent read PDF and Office documents (`.pdf`, `.docx`, `.pptx`, `.xlsx`, `.odt`, and related formats). A short document comes back whole; a long one comes back as a per-page outline, and the agent then reads the pages it needs. Pages without a usable text layer, such as scans, slides, and figures, come back as page images when the current model accepts images. Use it wherever an agent works from specifications, papers, reports, or scanned paperwork; `read` stays the choice for plain text files.

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

Mount the plugin next to a filesystem backend, the subprocess service, and, for page images, an attachment store and an image-capable model route. The host needs poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) and, for Office files, LibreOffice (`soffice`); a missing program fails the call with the package to install.

### Minimal configuration

```yaml
- insert:
    - id: tool-read-document
      name: '@deepseek-ai/dsh-tool-read-document'
```

### What each call does

| Arguments | Result |
|---|---|
| `file_path` only, short document | Every page's text, plus page images for pages without a text layer |
| `file_path` only, long document or one with scanned pages | A per-page outline: size and first line of each page, or a "no text layer" marker |
| `pages: "2-5"` | Those pages; `mode` decides images: `auto` (default) only for pages without a text layer, `image` for every page, `text` never |

A route that cannot accept images, or a deployment without an attachment store, receives the text with a note on each page whose image was not returned.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxPagesPerCall` | `10` | Most pages one call may select |
| `maxImagesPerCall` | `6` | Most page images one call returns; further pages carry a note |
| `textLayerMinChars` | `80` | A page with fewer text characters is treated as having no text layer |
| `renderDpi` | `110` | Page image resolution |
| `wholeTextMaxChars` | `12000` | Longest document returned whole without `pages` |
| `maxPageChars` | `20000` | Per-page text cap |
| `commandTimeoutMs` | `120000` | Deadline for each poppler or LibreOffice command |
| `cacheDir` | `<tmpdir>/dsh-media-cache` | Cache for extracted text |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### Design philosophy

- **Coarse to fine.** The first call is cheap: whole text or an outline. Pages are selected explicitly, the same shape as `read`'s line windows.
- **Text first, pixels when needed.** Text costs a fraction of an image and is exact; images are spent only where text is missing or the caller asks for layout.
- **Degrade, do not refuse.** A text-only route still gets everything except the images, with a note saying why.

### Pipeline

1. Resolve the path through `ctx.fs` in the Session's working directory and require a regular file.
2. Office files are converted with `soffice --headless --convert-to pdf` into a private temporary directory with its own LibreOffice profile.
3. `pdfinfo` gives the page count; `pdftotext -layout` gives all pages at once, split on form feeds. The result is cached by the PDF's SHA-256, so a renamed or copied file reuses it.
4. Selected pages that need images are rendered one at a time with `pdftoppm` and committed with `ctx.attachments.saveImage` before the result is returned.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, config, tool definition, outline, rendering |
| [`src/pdf.ts`](src/pdf.ts) | poppler and LibreOffice commands, page splitting |

Shared helpers (command execution, cache, page selection, image commits) live in [`dsh-media-core`](../media-core/README.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [media-core](../media-core/README.md) — the command runner, content-addressed cache, and image helpers this tool uses.
- [tool-fs](../../fs/tool-fs/README.md) — `read` for plain text and `read_image` for single images.
- [attachment](../../attachment/README.md) — durable image storage behind page images.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`read_document` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-read-document): a required `file_path`, an optional `pages` selection whose description states the per-call page limit, and an optional `mode` of `auto`, `text`, or `image`.

#### Token effect

Fixed schema cost on every request where the tool is visible; the description changes only with `maxPagesPerCall`.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged.

### Tool result

#### What the model sees

A `<path>` and `<pages>` header, then either an `<outline>` with one line per page and the instruction to call again with `pages`, or one `<page number="N">` block per selected page. A page without a text layer ends with `[no text layer]`; a page whose image was withheld adds the reason. Each rendered page image follows its page block as a native image block.

#### Token effect

Text grows with the selected pages and is capped per page by `maxPageChars`; each page image adds the provider's image cost and stays in history until compaction, where `compaction-image-offload` can replace it with a text reference.

#### KV Cache effect

Append-only; the result follows the reusable request prefix and does not invalidate earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Host execution only** — the tool passes the provider's process path to poppler and LibreOffice and writes renders to the host temporary directory, so it assumes the local filesystem and subprocess providers share one machine.
- **No layout reconstruction** — tables and multi-column text come from `pdftotext -layout`; when that spacing is not enough, the caller must request the page with `mode: "image"`.
- **Encrypted PDFs are not opened** — poppler's failure is reported; there is no password argument.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
