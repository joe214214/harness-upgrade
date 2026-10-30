/**
 * PDF access through poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) and Office
 * conversion through LibreOffice. Every call goes through the subprocess seam
 * and every derived text result is cached by source content.
 * @module @deepseek-ai/dsh-tool-read-document/pdf
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { runMediaCommand } from '@deepseek-ai/dsh-media-core'
import type { MediaCache } from '@deepseek-ai/dsh-media-core'

const POPPLER_HINT = 'poppler-utils (apt install poppler-utils / brew install poppler)'
const LIBREOFFICE_HINT = 'LibreOffice (apt install libreoffice / brew install --cask libreoffice)'

/** File extensions converted to PDF before reading. */
export const OFFICE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx', '.odp', '.xls', '.xlsx', '.ods',
])

/** Limits the PDF helpers apply to every command. */
export interface PdfLimits {
  readonly timeoutMs: number
  readonly maxTextBytes: number
}

/** Extracted text of a whole document, one entry per page. */
export interface PdfText {
  readonly pageCount: number
  readonly pages: readonly string[]
}

/**
 * Classify a path for `read_document`.
 * @param path - model-supplied or resolved path.
 * @returns `pdf`, `office`, or undefined for unsupported files.
 */
export function documentKind(path: string): 'pdf' | 'office' | undefined {
  const ext = extname(path).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  return OFFICE_EXTENSIONS.has(ext) ? 'office' : undefined
}

/**
 * Parse the page count from `pdfinfo` output.
 * @param info - stdout of `pdfinfo`.
 * @returns the page count.
 * @throws Error when the output has no `Pages:` line.
 */
export function parsePageCount(info: string): number {
  const match = /^Pages:\s+(\d+)\s*$/mu.exec(info)
  if (match === null) throw new Error('pdfinfo reported no page count; the file may not be a valid PDF')
  return Number(match[1])
}

/**
 * Split `pdftotext` output into pages. Poppler ends every page with a form
 * feed, so the trailing empty segment is dropped and short output is padded.
 * @param text - stdout of `pdftotext`.
 * @param pageCount - pages reported by `pdfinfo`.
 * @returns exactly `pageCount` page texts with trailing whitespace removed.
 */
export function splitPages(text: string, pageCount: number): string[] {
  const parts = text.split('\f').map(p => p.replace(/\s+$/u, ''))
  const pages = parts.slice(0, pageCount)
  while (pages.length < pageCount) pages.push('')
  return pages
}

/**
 * Read page count and per-page text, using the cache when possible.
 * @param ctx - context providing `ctx.subprocess`.
 * @param pdfPath - host path of the PDF.
 * @param digest - SHA-256 of the PDF bytes.
 * @param cache - result cache.
 * @param limits - command deadline and output cap.
 * @param signal - cancellation.
 * @returns the document's page texts.
 */
export async function extractText(
  ctx: Context, pdfPath: string, digest: string, cache: MediaCache, limits: PdfLimits, signal: AbortSignal,
): Promise<PdfText> {
  const key = cache.key(digest, 'pdf-text', { layout: true })
  const cached = await cache.get<PdfText>(key)
  if (cached !== undefined) return cached
  const common = { cwd: tmpdir(), timeoutMs: limits.timeoutMs, signal }
  const info = await runMediaCommand(ctx, { ...common, argv: ['pdfinfo', pdfPath], maxStdoutBytes: 64 * 1024, maxStderrBytes: 4096 }, POPPLER_HINT)
  const pageCount = parsePageCount(info.stdout)
  const text = await runMediaCommand(
    ctx, { ...common, argv: ['pdftotext', '-layout', '-enc', 'UTF-8', pdfPath, '-'], maxStdoutBytes: limits.maxTextBytes, maxStderrBytes: 4096 }, POPPLER_HINT,
  )
  const result: PdfText = { pageCount, pages: splitPages(text.stdout, pageCount) }
  // A truncated extraction would cache a document with missing pages.
  if (!text.truncated) await cache.put(key, result)
  return result
}

/**
 * Render selected pages to PNG files in a fresh temporary directory.
 * @param ctx - context providing `ctx.subprocess`.
 * @param pdfPath - host path of the PDF.
 * @param pages - 1-based page numbers.
 * @param dpi - render resolution.
 * @param limits - command deadline.
 * @param signal - cancellation.
 * @returns the directory (caller removes it) and one PNG path per page.
 */
export async function renderPages(
  ctx: Context, pdfPath: string, pages: readonly number[], dpi: number, limits: PdfLimits, signal: AbortSignal,
): Promise<{ dir: string; files: Map<number, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-read-document-'))
  const files = new Map<number, string>()
  try {
    for (const page of pages) {
      const prefix = join(dir, `page-${page}`)
      await runMediaCommand(ctx, {
        argv: ['pdftoppm', '-f', String(page), '-l', String(page), '-r', String(dpi), '-png', '-singlefile', pdfPath, prefix],
        cwd: dir,
        timeoutMs: limits.timeoutMs,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        signal,
      }, POPPLER_HINT)
      files.set(page, `${prefix}.png`)
    }
  } catch (error: unknown) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return { dir, files }
}

/**
 * Convert an Office file to PDF with headless LibreOffice.
 * @param ctx - context providing `ctx.subprocess`.
 * @param sourcePath - host path of the Office file.
 * @param outDir - directory receiving the PDF.
 * @param limits - command deadline.
 * @param signal - cancellation.
 * @returns host path of the produced PDF.
 * @throws Error when LibreOffice produced no PDF.
 */
export async function convertOfficeToPdf(
  ctx: Context, sourcePath: string, outDir: string, limits: PdfLimits, signal: AbortSignal,
): Promise<string> {
  // A private profile directory keeps concurrent conversions from fighting
  // over the user's LibreOffice profile lock.
  const profile = join(outDir, 'lo-profile')
  await runMediaCommand(ctx, {
    argv: ['soffice', `-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, sourcePath],
    cwd: outDir,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 4096,
    signal,
  }, LIBREOFFICE_HINT)
  const expected = `${basename(sourcePath, extname(sourcePath))}.pdf`
  const produced = (await readdir(outDir)).find(name => name === expected)
  if (produced === undefined) throw new Error(`LibreOffice did not produce a PDF for "${basename(sourcePath)}"`)
  return join(outDir, produced)
}
