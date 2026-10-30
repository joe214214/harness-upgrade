/**
 * `read_video` over the real local filesystem, subprocess runtime, ffmpeg and
 * attachment store, with a fake provider on the real speech seam: scene and
 * uniform sampling, timeline merge, route-gated frames, windows, and refusals.
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import * as ReadVideo from '../src/index.ts'
import { buildTimeline, parseSceneScores, selectChangeTimes, uniformTimes } from '../src/index.ts'

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname
const AUDIO_FIXTURE = new URL('../../tool-read-audio/tests/fixtures/tones.mp3', import.meta.url).pathname

class CatalogAdapter extends LlmAdapter {
  constructor(private readonly models: LlmModelInfo[]) { super() }
  override listModels(): Promise<readonly LlmModelInfo[]> { return Promise.resolve(this.models) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = this.models.find(m => m.id === model)
    const modalities = found?.inputModalities === undefined ? {} : { inputModalities: [...found.inputModalities] }
    return Promise.resolve({ provider, id: model, name: model, ...modalities })
  }
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('read_video tests never stream') }
}

let dir: string
let home: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-read-video-ws-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-read-video-home-'))
  await copyFile(join(FIXTURES, 'scenes.mp4'), join(dir, 'scenes.mp4'))
  await copyFile(AUDIO_FIXTURE, join(dir, 'tones.mp3'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

async function setup(config: Partial<ReadVideo.Config> = {}, speech = true): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], new CatalogAdapter([
    { provider: 'test', id: 'vision', name: 'Vision', inputModalities: ['text', 'image'] },
    { provider: 'test', id: 'text', name: 'Text', inputModalities: ['text'] },
  ]))
  if (speech) {
    await ctx.plugin(SpeechToText, { defaultProvider: 'fake', language: 'auto' })
    ctx.get('speechToText')!.register({
      info: { id: 'fake' as SpeechProviderId, name: 'fake', location: 'host-local', languages: ['auto'] },
      transcribe: async () => ({ text: 'beep', audioSeconds: 1, inferenceSeconds: 0 }),
    })
  }
  await ctx.plugin(ReadVideo, Object.assign({ cacheDir: join(home, 'cache') }, config))
  return ctx
}

let counter = 0
async function watch(ctx: Context, args: Record<string, unknown>, model = 'vision') {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`video-${++counter}`),
    name: 'read_video',
    arguments: args,
    agent: { options: {}, session: { header: { cwd: dir }, requestHeader: () => ({ config: { provider: 'test', model } }) } } as never,
  })
}
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
}
function images(result: { content: { type: string }[] }): number {
  return result.content.filter(b => b.type === 'image').length
}

describe('helpers', () => {
  it('parses scene scores in frame order', () => {
    const stderr = '[Parsed_metadata_2 @ 0x1] frame:0 pts:0 pts_time:0\n[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.000000\n'
      + '[Parsed_metadata_2 @ 0x1] frame:1 pts:40 pts_time:5.72\n[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.128515\n'
    expect(parseSceneScores(stderr)).toEqual([{ time: 0, score: 0 }, { time: 5.72, score: 0.128515 }])
  })

  it('keeps the first frame and the largest changes, spaced apart and above the noise floor', () => {
    const scores = [
      { time: 1, score: 0.004 }, { time: 1.04, score: 0.003 }, { time: 5.7, score: 0.13 },
      { time: 5.74, score: 0.09 }, { time: 8, score: 0.0005 }, { time: 9, score: 0.02 },
    ]
    // 5.74 is within 1 s of 5.7; 8 is noise; the budget of 4 takes 0, 5.7, 9, 1.
    expect(selectChangeTimes(scores, 10, 4, 0.001, 1)).toEqual([0, 1.3, 6, 9.3])
    expect(selectChangeTimes([], 10, 4, 0.001, 1)).toEqual([0])
    expect(selectChangeTimes(scores, 10, 1, 0.001, 1)).toEqual([0])
  })

  it('spaces uniform frames in the middle of equal slices', () => {
    expect(uniformTimes(8, 4)).toEqual([1, 3, 5, 7])
  })

  it('orders frames before speech at the same time', () => {
    const timeline = buildTimeline({
      path: '/v.mp4', duration: 10, start: 0, end: 10, notes: [],
      frames: [{ time: 0 }, { time: 5 }],
      segments: [{ start: 0, end: 4, text: 'a' }, { start: 4, end: 9, text: 'b' }],
    })
    expect(timeline.map(e => e.kind)).toEqual(['frame', 'speech', 'speech', 'frame'])
  })
})

describe('read_video', () => {
  it('returns one frame per scene and the speech, as one timeline', async () => {
    const ctx = await setup()
    const result = await watch(ctx, { file_path: 'scenes.mp4' })
    expect(result.isError).toBe(false)
    expect(images(result)).toBe(3)
    const out = text(result)
    expect(out).toContain('[00:00] frame 1')
    expect(out).toMatch(/\[00:0[23]\] frame 2/u)
    expect(out).toMatch(/\[00:0[67]\] frame 3/u)
    expect(out).toContain('said: beep')
  }, 60_000)

  it('spreads the frame budget evenly in uniform mode', async () => {
    const ctx = await setup({ sampling: 'uniform', maxFramesPerCall: 5 })
    expect(images(await watch(ctx, { file_path: 'scenes.mp4', transcript: false }))).toBe(5)
  }, 60_000)

  it('narrows to a window', async () => {
    const ctx = await setup()
    const out = text(await watch(ctx, { file_path: 'scenes.mp4', start: '4', end: '6' }))
    expect(out).toContain('<window>00:04–00:06</window>')
    expect(out).toContain('[00:04] frame 1')
    expect(out).not.toContain('frame 2')
  }, 60_000)

  it('omits frames with a note on a text-only route, and notes a missing speech service', async () => {
    const ctx = await setup({}, false)
    const result = await watch(ctx, { file_path: 'scenes.mp4' }, 'text')
    expect(images(result)).toBe(0)
    expect(text(result)).toContain('cannot take images')
    expect(text(result)).toContain('no speech-to-text service is mounted')
  }, 60_000)

  it('refuses audio-only files and bad windows', async () => {
    const ctx = await setup()
    expect(text(await watch(ctx, { file_path: 'tones.mp3' }))).toContain('use read_audio')
    expect(text(await watch(ctx, { file_path: 'scenes.mp4', start: '30' }))).toContain('past the end')
    expect(text(await watch(ctx, { file_path: ' ' }))).toContain('non-empty')
  }, 60_000)
})
