/**
 * `read_audio` over the real local filesystem, subprocess runtime and ffmpeg,
 * with a recording speech provider registered on the real speech seam:
 * silence-aware segmentation, canonical WAV segments, timestamps, windows,
 * the long-transcript index, caching, and refusals.
 */
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/src/wave.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import * as ReadAudio from '../src/index.ts'
import { buildTimeIndex, canonicalWave, formatTranscript, isSilent, parseSilences, planSegments, renderAudio, selectWindow } from '../src/index.ts'

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname

let dir: string
let cacheDir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-read-audio-ws-'))
  cacheDir = join(dir, '.cache')
  await copyFile(join(FIXTURES, 'tones.mp3'), join(dir, 'tones.mp3'))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** Seconds of each WAV the provider received, in call order. */
let heard: number[]

async function setup(config: Partial<ReadAudio.Config> = {}, speech = true): Promise<Context> {
  heard = []
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(LocalSubprocessRuntime)
  if (speech) {
    await ctx.plugin(SpeechToText, { defaultProvider: 'fake', language: 'auto' })
    ctx.get('speechToText')!.register({
      info: { id: 'fake' as SpeechProviderId, name: 'fake', location: 'host-local', languages: ['auto'] },
      transcribe: async ({ audio }) => {
        const seconds = validateWave(audio, 120)
        heard.push(Math.round(seconds))
        return { text: `tone of ${Math.round(seconds)} seconds`, audioSeconds: seconds, inferenceSeconds: 0 }
      },
    })
  }
  await ctx.plugin(ReadAudio, Object.assign({ cacheDir, maxSegmentSeconds: 5, minSegmentSeconds: 1 }, config))
  return ctx
}

let counter = 0
async function read(ctx: Context, args: Record<string, unknown>) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`audio-${++counter}`),
    name: 'read_audio',
    arguments: args,
  })
}
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
}

describe('segmentation', () => {
  it('parses silencedetect output and closes a trailing silence at the duration', () => {
    const stderr = '[silencedetect @ 0x1] silence_start: 3.0\n[silencedetect @ 0x1] silence_end: 5.0 | silence_duration: 2\nsilence_start: 9.01\n'
    expect(parseSilences(stderr, 12)).toEqual([{ start: 3, end: 5 }, { start: 9.01, end: 12 }])
  })

  it('cuts in the middle of the last usable pause and hard-cuts long speech', () => {
    // The pause at 3-5 s gives a cut at 4 s; the next pause's middle (10 s) is past 4 + 5, so 9 s is a hard cut.
    expect(planSegments(14, [{ start: 3, end: 5 }, { start: 9, end: 11 }], 5, 1)).toEqual([
      { start: 0, end: 4 }, { start: 4, end: 9 }, { start: 9, end: 14 },
    ])
    expect(planSegments(12, [], 5, 1)).toEqual([{ start: 0, end: 5 }, { start: 5, end: 10 }, { start: 10, end: 12 }])
    expect(planSegments(4, [], 5, 1)).toEqual([{ start: 0, end: 4 }])
    // A 0.5 s remainder joins the previous segment.
    expect(planSegments(10.5, [], 5, 1)).toEqual([{ start: 0, end: 5 }, { start: 5, end: 10.5 }])
  })

  it('recognizes spans that are entirely silent', () => {
    expect(isSilent({ start: 9, end: 10 }, [{ start: 9, end: 11 }])).toBe(true)
    expect(isSilent({ start: 8, end: 10 }, [{ start: 9, end: 11 }])).toBe(false)
  })
})

describe('formatting', () => {
  const segs = [{ start: 0, end: 4, text: 'hello' }, { start: 400, end: 404, text: 'later' }]

  it('formats transcripts, windows and the time index', () => {
    expect(formatTranscript(segs)).toBe('[00:00–00:04] hello\n[06:40–06:44] later')
    expect(selectWindow(segs, 300, 500)).toEqual([segs[1]])
    expect(buildTimeIndex(segs, 0, 600, 300)).toBe('[00:00–05:00] 5 chars — hello\n[05:00–10:00] 5 chars — later')
  })

  it('says when a window has no speech', () => {
    expect(renderAudio({ path: '/a.mp3', duration: 10, start: 0, end: 10, segments: [] })).toContain('no speech recognized')
  })
})

describe('read_audio', () => {
  it('transcribes speech segments with timestamps and skips silence', async () => {
    const ctx = await setup()
    const result = await read(ctx, { file_path: 'tones.mp3' })
    expect(result.isError).toBe(false)
    const out = text(result)
    expect(out).toContain('<duration>00:14</duration>')
    expect(out).toMatch(/\[00:00–00:0\d\] tone of \d seconds/u)
    // 3 s tone + 2 s pause + 4 s tone + 2 s pause + 3 s tone, at most 5 s per segment:
    // every segment the provider received was a canonical WAV of at most 5 s.
    expect(heard.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...heard)).toBeLessThanOrEqual(5)
  }, 60_000)

  it('serves windows from the cached whole-file transcript', async () => {
    const ctx = await setup()
    await read(ctx, { file_path: 'tones.mp3' })
    const calls = heard.length
    const out = text(await read(ctx, { file_path: 'tones.mp3', start: '10', end: '00:14' }))
    expect(out).toContain('<window>00:10–00:14</window>')
    expect(out).not.toContain('[00:00–')
    expect(heard.length).toBe(calls)
    expect((await readdir(cacheDir)).filter(name => name.startsWith('transcript-'))).toHaveLength(1)
  }, 60_000)

  it('returns a time index when the transcript is too long', async () => {
    const ctx = await setup({ maxTranscriptChars: 50, indexBlockSeconds: 30 })
    const out = text(await read(ctx, { file_path: 'tones.mp3' }))
    expect(out).toContain('<index>')
    expect(out).toContain('[00:00–00:14]')
    expect(out).toContain('Call read_audio again with start and end')
  }, 60_000)

  it('writes canonical WAV headers for any sample count', () => {
    const wav = canonicalWave(new Uint8Array(32_001))
    expect(wav.byteLength).toBe(44 + 32_000)
    expect(validateWave(wav, 10)).toBe(1)
  })

  it('refuses without a speech service, without audio, and for bad windows', async () => {
    const noSpeech = await setup({}, false)
    expect(text(await read(noSpeech, { file_path: 'tones.mp3' }))).toContain('no speech-to-text service is mounted')
    const ctx = await setup()
    await writeFile(join(dir, 'notes.txt'), 'plain text')
    expect(text(await read(ctx, { file_path: 'notes.txt' }))).toMatch(/no duration|ffprobe failed/u)
    expect(text(await read(ctx, { file_path: 'tones.mp3', start: '20' }))).toContain('past the end')
    expect(text(await read(ctx, { file_path: 'missing.mp3' }))).toContain('not found')
    const short = await setup({ maxDurationSeconds: 5 })
    expect(text(await read(short, { file_path: 'tones.mp3' }))).toContain('accepts at most 00:05')
  }, 60_000)
})
