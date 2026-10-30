/** `ask_image` with a scripted vision model over the real filesystem and attachment store. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest'
import * as VisionBridge from '../src/index.ts'

/** 1x1 red PNG. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

class VisionAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override listModels(): Promise<readonly LlmModelInfo[]> { return Promise.resolve([]) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: model === 'eyes' ? ['text', 'image'] : ['text'] })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = 'The error reads: TypeError at cart.js:10'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-vision-bridge-'))
  await writeFile(join(dir, 'shot.png'), PNG_1X1)
  await writeFile(join(dir, 'notes.txt'), 'text')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function setup(model: string) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(LocalAttachmentStore, { dshHome: dir })
  await ctx.plugin(LlmRuntime)
  const adapter = new VisionAdapter()
  ctx.llm.registerAdapter(['test'], adapter)
  await ctx.plugin(VisionBridge, { provider: 'test', model })
  return { ctx, adapter }
}

async function ask(ctx: Context, args: Record<string, unknown>) {
  const result = await executeToolFixture(ctx, { signal: new AbortController().signal, callId: ToolCallId('ask-1'), name: 'ask_image', arguments: args })
  return { isError: result.isError, text: result.content.map(b => (b.type === 'text' ? b.text : '')).join(''), images: result.content.filter(b => b.type === 'image').length }
}

it('sends the image and question to the vision model and returns only text', async () => {
  const { ctx, adapter } = await setup('eyes')
  const out = await ask(ctx, { file_path: 'shot.png', question: 'What error is shown?' })
  expect(out).toMatchObject({ isError: false, images: 0 })
  expect(out.text).toContain('<answer model="test/eyes">')
  expect(out.text).toContain('TypeError at cart.js:10')
  const content = adapter.requests[0]?.messages[0]?.content as { type: string; text?: string }[]
  expect(content.map(b => b.type)).toEqual(['image', 'text'])
  expect(content[1]?.text).toBe('What error is shown?')
  expect(adapter.requests[0]?.system).toContain('cannot see them')
})

it('refuses non-image files and a configured model without image input', async () => {
  const { ctx } = await setup('eyes')
  expect((await ask(ctx, { file_path: 'notes.txt', question: 'x' })).text).toContain('accepts PNG/JPEG/WebP/GIF')
  expect((await ask(ctx, { file_path: 'missing.png', question: 'x' })).text).toContain('not found')
  const blind = await setup('blind')
  expect((await ask(blind.ctx, { file_path: 'shot.png', question: 'x' })).text).toContain('does not declare image input')
})
