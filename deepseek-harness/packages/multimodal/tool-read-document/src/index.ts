/**
 * The model-facing `read_document` tool: PDF and Office files, read coarse to
 * fine. Without `pages` it returns the whole text of a short document or a
 * per-page outline of a long one; with `pages` it returns those pages, and
 * pages without a usable text layer (scans, slides, figures) are rendered to
 * images when the calling route accepts image input.
 * @module @deepseek-ai/dsh-tool-read-document
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  MediaCache,
  STORED_IMAGE_SCHEMA,
  hashFile,
  imageBlock,
  parsePageSelection,
  routeAcceptsImages,
  savePng,
} from '@deepseek-ai/dsh-media-core'
import type { StoredImage } from '@deepseek-ai/dsh-media-core'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { convertOfficeToPdf, documentKind, extractText, renderPages } from './pdf.ts'
import type { PdfLimits } from './pdf.ts'

export { documentKind, parsePageCount, splitPages } from './pdf.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-read-document'

/** Services required by `read_document`; `attachments` and `llm` are optional. */
export const inject = ['tools', 'fs', 'subprocess']

/** Plugin config; every field has a validated default. */
export interface Config {
  /** Most pages one call may select. */
  maxPagesPerCall?: number
  /** Most page images one call may return. */
  maxImagesPerCall?: number
  /** A page with fewer text characters than this is treated as having no text layer. */
  textLayerMinChars?: number
  /** Render resolution for page images. */
  renderDpi?: number
  /** A document whose whole text is at most this long is returned whole when `pages` is omitted. */
  wholeTextMaxChars?: number
  /** Per-page text cap in characters. */
  maxPageChars?: number
  /** Deadline for each poppler or LibreOffice command. */
  commandTimeoutMs?: number
  /** Directory for cached text extraction results. */
  cacheDir?: string
}

export const Config: z<Config> = z.object({
  maxPagesPerCall: z.natural().min(1).default(10),
  maxImagesPerCall: z.natural().min(0).default(6),
  textLayerMinChars: z.natural().default(80),
  renderDpi: z.natural().min(36).max(300).default(110),
  wholeTextMaxChars: z.natural().default(12_000),
  maxPageChars: z.natural().min(500).default(20_000),
  commandTimeoutMs: z.natural().min(1000).default(120_000),
  cacheDir: z.string().default(join(tmpdir(), 'dsh-media-cache')),
})

type ResolvedConfig = Required<Config>

/** One returned page in the canonical value. */
export interface DocumentPage {
  page: number
  text: string
  /** False when the page has fewer than `textLayerMinChars` characters of text. */
  textLayer: boolean
  image?: StoredImage
  /** Why a page without a text layer has no image. */
  note?: string
}

/** Canonical value of one `read_document` call. */
export interface DocumentReadValue {
  path: string
  pageCount: number
  /** Present when `pages` was omitted and the document is too long to return whole. */
  outline?: string
  pages: DocumentPage[]
}

const PAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', required: true },
    text: { type: 'string', required: true },
    textLayer: { type: 'boolean', required: true },
    image: STORED_IMAGE_SCHEMA,
    note: { type: 'string' },
  },
} as const

/**
 * Build the per-page outline for a long document.
 * @param pages - page texts.
 * @param minChars - text-layer threshold.
 * @returns one line per page: number, size, and first line or a scan marker.
 */
export function buildOutline(pages: readonly string[], minChars: number): string {
  return pages.map((text, index) => {
    const chars = text.trim().length
    if (chars < minChars) return `p${index + 1}: no text layer (scanned page or figure) — request it to see the page image`
    const first = text.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? ''
    return `p${index + 1}: ${chars} chars — ${first.slice(0, 90)}`
  }).join('\n')
}

function clipPage(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[page truncated: ${text.length - max} more characters]` : text
}

/**
 * Project a canonical value into model-facing content: one text block per
 * page, followed by that page's image when one was rendered.
 * @param value - the read outcome.
 * @returns content blocks.
 */
export function renderDocument(value: DocumentReadValue): ContentBlock[] {
  const header = `<path>${value.path}</path>\n<pages>${value.pageCount}</pages>`
  if (value.outline !== undefined) {
    return [{
      type: 'text',
      text: `${header}\n<outline>\n${value.outline}\n</outline>\nThe document is too long to return whole. Call read_document again with pages (for example "1-3") to read specific pages.`,
    }]
  }
  const blocks: ContentBlock[] = [{ type: 'text', text: header }]
  for (const page of value.pages) {
    const marker = page.textLayer ? '' : '[no text layer]'
    const trailer = [marker, page.note ?? ''].filter(Boolean).join(' ')
    const body = trailer ? `${page.text}${page.text ? '\n' : ''}${trailer}` : page.text
    blocks.push({ type: 'text', text: `<page number="${page.page}">\n${body}\n</page>` })
    if (page.image !== undefined) blocks.push(imageBlock(page.image))
  }
  return blocks
}

async function resolveTarget(ctx: Context, exec: ToolExecution, requested: string) {
  const directory = ctx.get('workingDirectory')
  const cwd = exec.agent === undefined || directory === undefined ? undefined : await directory.ensure(exec.agent, exec.signal)
  const target = await ctx.fs.resolve(requested, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return target
}

/**
 * Register `read_document`.
 * @param ctx - plugin context with `tools`, `fs` and `subprocess`.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = config as ResolvedConfig
  const cache = new MediaCache(cfg.cacheDir)
  const limits: PdfLimits = { timeoutMs: cfg.commandTimeoutMs, maxTextBytes: 64 * 1024 * 1024 }

  ctx.tools.register(defineTool({
    name: 'read_document',
    description: 'Read a PDF or Office document (.pdf, .docx, .pptx, .xlsx, .odt, …). '
      + 'Without pages: returns the whole text of a short document, or a per-page outline of a long one. '
      + 'With pages: returns those pages; scanned pages, slides and figures come back as page images when the model accepts images. '
      + 'Use mode "image" to see a page\'s layout, tables or charts even when it has text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the document.' },
      pages: { type: 'string', description: `Pages to read, 1-based: "3", "2-5" or "1,4-6". At most ${cfg.maxPagesPerCall} per call.` },
      mode: { type: 'string', enum: ['auto', 'text', 'image'], description: 'auto (default): images only for pages without a text layer; text: never images; image: an image for every selected page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          pageCount: { type: 'integer', required: true },
          outline: { type: 'string' },
          pages: { type: 'array', required: true, items: PAGE_SCHEMA },
        },
      },
      render: (_args, value) => renderDocument(value),
      presentationMeta: (_args, value) => ({ path: value.path, pageCount: value.pageCount, pages: value.pages.map(p => p.page) }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
      const kind = documentKind(args.file_path)
      if (kind === undefined) {
        throw new Error(`cannot read "${args.file_path}" as a document: read_document supports PDF and Office files; use read for plain text`)
      }
      const target = await resolveTarget(ctx, exec, args.file_path)
      const sourcePath = ctx.fs.processPath(target)
      const mode = args.mode ?? 'auto'
      const work = await mkdtemp(join(tmpdir(), 'dsh-read-document-'))
      try {
        let pdfPath = sourcePath
        let digest = await hashFile(sourcePath, exec.signal)
        if (kind === 'office') {
          pdfPath = await convertOfficeToPdf(ctx, sourcePath, work, limits, exec.signal)
          digest = await hashFile(pdfPath, exec.signal)
        }
        const text = await extractText(ctx, pdfPath, digest, cache, limits, exec.signal)

        if (args.pages === undefined) {
          const total = text.pages.reduce((sum, page) => sum + page.length, 0)
          const allText = text.pages.every(page => page.trim().length >= cfg.textLayerMinChars)
          if (total > cfg.wholeTextMaxChars || !allText || text.pageCount > cfg.maxPagesPerCall) {
            const outline = buildOutline(text.pages, cfg.textLayerMinChars)
            return { path: target.displayPath, pageCount: text.pageCount, outline, pages: [] }
          }
        }
        const selected = args.pages === undefined
          ? text.pages.map((_, index) => index + 1)
          : parsePageSelection(args.pages, text.pageCount, cfg.maxPagesPerCall)

        const pages: DocumentPage[] = selected.map((page) => {
          const pageText = text.pages[page - 1] ?? ''
          return { page, text: clipPage(pageText, cfg.maxPageChars), textLayer: pageText.trim().length >= cfg.textLayerMinChars }
        })
        const wantImage = (p: DocumentPage) => mode === 'image' || (mode === 'auto' && !p.textLayer)
        const candidates = pages.filter(wantImage)
        if (candidates.length > 0) {
          const imagesOk = ctx.get('attachments') !== undefined && await routeAcceptsImages(ctx, exec)
          if (!imagesOk) {
            for (const p of candidates) p.note = 'The current model cannot take images, so this page\'s image was not returned.'
          } else {
            const toRender = candidates.slice(0, cfg.maxImagesPerCall)
            for (const p of candidates.slice(cfg.maxImagesPerCall)) {
              p.note = `Image omitted: at most ${cfg.maxImagesPerCall} page images per call; request this page separately.`
            }
            const rendered = await renderPages(ctx, pdfPath, toRender.map(p => p.page), cfg.renderDpi, limits, exec.signal)
            try {
              for (const p of toRender) {
                p.image = await savePng(ctx, rendered.files.get(p.page) ?? '', `${basename(target.displayPath)} p${p.page}.png`)
              }
            } finally {
              await rm(rendered.dir, { recursive: true, force: true })
            }
          }
        }
        return { path: target.displayPath, pageCount: text.pageCount, pages }
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read document ${args.file_path}${args.pages === undefined ? '' : ` (pages ${args.pages})`}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
