/**
 * `read_document` over the real local filesystem, subprocess runtime, poppler,
 * LibreOffice and attachment store: whole-text reads, outlines, page
 * selection, image rendering gated by route capability, Office conversion,
 * caching, and refusals.
 */
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import * as ReadDocument from '../src/index.ts'
import { buildOutline, documentKind, parsePageCount, renderDocument, splitPages } from '../src/index.ts'
import type { DocumentReadValue } from '../src/index.ts'

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname

class CatalogAdapter extends LlmAdapter {
  constructor(private readonly models: LlmModelInfo[]) { super() }
  override listModels(): Promise<readonly LlmModelInfo[]> { return Promise.resolve(this.models) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = this.models.find(m => m.id === model)
    const modalities = found?.inputModalities === undefined ? {} : { inputModalities: [...found.inputModalities] }
    return Promise.resolve({ provider, id: model, name: model, ...modalities })
  }
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('read_document tests never stream') }
}

let dir: string
let home: string
let cacheDir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-read-document-ws-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-read-document-home-'))
  cacheDir = join(home, 'media-cache')
  for (const name of ['spec.pdf', 'scan.pdf', 'mixed.pdf', 'notes.docx']) await copyFile(join(FIXTURES, name), join(dir, name))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

async function setup(config: Partial<ReadDocument.Config> = {}, attachments = true): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(LocalSubprocessRuntime)
  if (attachments) await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], new CatalogAdapter([
    { provider: 'test', id: 'vision', name: 'Vision', inputModalities: ['text', 'image'] },
    { provider: 'test', id: 'text', name: 'Text', inputModalities: ['text'] },
  ]))
  await ctx.plugin(ReadDocument, Object.assign({ cacheDir }, config))
  return ctx
}

function agentOn(model: string): object {
  return { options: {}, session: { header: { cwd: dir }, requestHeader: () => ({ config: { provider: 'test', model } }) } }
}

let counter = 0
async function read(ctx: Context, args: Record<string, unknown>, model = 'vision') {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`doc-${++counter}`),
    name: 'read_document',
    arguments: args,
    agent: agentOn(model) as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
}
function images(result: { content: { type: string }[] }): number {
  return result.content.filter(b => b.type === 'image').length
}

describe('pure helpers', () => {
  it('classifies documents by extension', () => {
    expect(documentKind('a.PDF')).toBe('pdf')
    expect(documentKind('b.docx')).toBe('office')
    expect(documentKind('c.txt')).toBeUndefined()
  })

  it('parses pdfinfo and splits pdftotext pages', () => {
    expect(parsePageCount('Title: x\nPages:          12\n')).toBe(12)
    expect(() => parsePageCount('nothing')).toThrow(/no page count/)
    expect(splitPages('a  \fb\f', 3)).toEqual(['a', 'b', ''])
  })

  it('outlines text pages and marks pages without a text layer', () => {
    const outline = buildOutline(['\n  Title line\nbody text that is long enough', ''], 10)
    expect(outline).toContain('p1: ')
    expect(outline).toContain('Title line')
    expect(outline).toContain('p2: no text layer')
  })

  it('renders an outline value as guidance to request pages', () => {
    const value: DocumentReadValue = { path: '/x.pdf', pageCount: 40, outline: 'p1: ...', pages: [] }
    expect(renderDocument(value)[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(renderDocument(value))).toContain('Call read_document again with pages')
  })
})

describe('read_document', () => {
  it('returns the whole text of a short text-layer PDF', async () => {
    const ctx = await setup()
    const result = await read(ctx, { file_path: 'spec.pdf' })
    expect(result.isError).toBe(false)
    const out = text(result)
    expect(out).toContain('<pages>3</pages>')
    expect(out).toContain('<page number="2">')
    expect(out).toContain('120 requests per minute')
    expect(images(result)).toBe(0)
  })

  it('outlines a document that has a page without a text layer', async () => {
    const ctx = await setup()
    const out = text(await read(ctx, { file_path: 'mixed.pdf' }))
    expect(out).toContain('<outline>')
    expect(out).toContain('p4: no text layer')
  })

  it('renders only the scanned page as an image in auto mode', async () => {
    const ctx = await setup()
    const result = await read(ctx, { file_path: 'mixed.pdf', pages: '3-4' })
    expect(result.isError).toBe(false)
    expect(images(result)).toBe(1)
    expect(text(result)).toContain('E429 means a rate limit was exceeded')
    expect(text(result)).toContain('[no text layer]')
  })

  it('returns an image for every page in image mode and none in text mode', async () => {
    const ctx = await setup()
    expect(images(await read(ctx, { file_path: 'spec.pdf', pages: '1-2', mode: 'image' }))).toBe(2)
    expect(images(await read(ctx, { file_path: 'scan.pdf', pages: '1', mode: 'text' }))).toBe(0)
  })

  it('degrades to a note when the route cannot take images', async () => {
    const ctx = await setup()
    const result = await read(ctx, { file_path: 'scan.pdf', pages: '1' }, 'text')
    expect(images(result)).toBe(0)
    expect(text(result)).toContain('cannot take images')
  })

  it('degrades to a note when no attachment store is mounted', async () => {
    const ctx = await setup({}, false)
    const result = await read(ctx, { file_path: 'scan.pdf', pages: '1' })
    expect(images(result)).toBe(0)
    expect(text(result)).toContain('cannot take images')
  })

  it('caps images per call and says which pages were omitted', async () => {
    const ctx = await setup({ maxImagesPerCall: 1 })
    const result = await read(ctx, { file_path: 'spec.pdf', pages: '1-2', mode: 'image' })
    expect(images(result)).toBe(1)
    expect(text(result)).toContain('at most 1 page images per call')
  })

  it('converts Office documents through LibreOffice', async () => {
    const ctx = await setup()
    const result = await read(ctx, { file_path: 'notes.docx' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('/v1/relay/jobs')
  }, 120_000)

  it('caches extracted text by content', async () => {
    const ctx = await setup()
    await read(ctx, { file_path: 'spec.pdf' })
    const entries = await readdir(cacheDir)
    expect(entries.filter(name => name.startsWith('pdf-text-'))).toHaveLength(1)
    await copyFile(join(dir, 'spec.pdf'), join(dir, 'renamed.pdf'))
    await read(ctx, { file_path: 'renamed.pdf' })
    expect((await readdir(cacheDir)).filter(name => name.startsWith('pdf-text-'))).toHaveLength(1)
  })

  it('refuses unsupported, missing and out-of-range inputs with recovery hints', async () => {
    const ctx = await setup()
    expect(text(await read(ctx, { file_path: 'notes.txt' }))).toContain('use read for plain text')
    expect(text(await read(ctx, { file_path: 'missing.pdf' }))).toContain('not found')
    expect(text(await read(ctx, { file_path: 'spec.pdf', pages: '7' }))).toContain('pages 1-3')
    expect(text(await read(ctx, { file_path: ' ' }))).toContain('non-empty')
  })
})
