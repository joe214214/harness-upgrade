/**
 * The model-facing `read_video` tool: keyframes and speech of a video window
 * merged into one timeline. The first call covers the whole video with a few
 * frames; the model then narrows `start`/`end` around a moment, and the same
 * frame budget spread over a shorter window samples it more densely.
 * @module @deepseek-ai/dsh-experimental-tool-read-video
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  STORED_IMAGE_SCHEMA,
  formatTimestamp,
  imageBlock,
  probeMedia,
  resolveWindow,
  routeAcceptsImages,
  savePng,
} from '@deepseek-ai/dsh-media-core'
import type { StoredImage } from '@deepseek-ai/dsh-media-core'
import * as ReadAudio from '@deepseek-ai/dsh-experimental-tool-read-audio'
import type { TranscriptSegment } from '@deepseek-ai/dsh-experimental-tool-read-audio'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { extractFrames } from './frames.ts'
import type { Sampling } from './frames.ts'

export { extractFrames, parseSceneScores, selectChangeTimes, uniformTimes } from './frames.ts'
export type { ExtractedFrame, FrameRequest, Sampling, ScoredFrame } from './frames.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-read-video'

/** Required services; images need `attachments` and transcripts need `speechToText` at call time. */
export const inject = ['tools', 'fs', 'subprocess']

/** Plugin config; every field has a validated default. */
export interface Config {
  /** Frames returned by one call. */
  maxFramesPerCall?: number
  /** Frame selection: largest visual changes, or evenly spaced as a baseline. */
  sampling?: Sampling
  /** Scene scores below this are encoder noise (0–1). */
  minSceneScore?: number
  /** Minimum spacing between selected frames, in seconds. */
  minFrameGapSeconds?: number
  /** Frames wider than this are scaled down. */
  frameMaxWidth?: number
  /** Longest file accepted, in seconds. */
  maxDurationSeconds?: number
  /** Transcript characters included in one timeline before speech is summarized. */
  maxTranscriptChars?: number
  /** Deadline for each ffmpeg command. */
  commandTimeoutMs?: number
  /** Directory for cached transcripts (shared with read_audio). */
  cacheDir?: string
}

export const Config: z<Config> = z.object({
  maxFramesPerCall: z.natural().min(1).max(32).default(8),
  sampling: z.union(['scene', 'uniform']).default('scene'),
  minSceneScore: z.number().min(0).max(1).default(0.001),
  minFrameGapSeconds: z.number().min(0.1).default(1),
  frameMaxWidth: z.natural().min(160).default(1024),
  maxDurationSeconds: z.natural().min(1).default(4 * 3600),
  maxTranscriptChars: z.natural().min(50).default(8000),
  commandTimeoutMs: z.natural().min(1000).default(300_000),
  cacheDir: z.string().default(join(tmpdir(), 'dsh-media-cache')),
})

type ResolvedConfig = Required<Config>

/** One frame in the canonical value. */
export interface VideoFrame {
  time: number
  image?: StoredImage
}

/** Canonical value of one `read_video` call. */
export interface VideoReadValue {
  path: string
  duration: number
  start: number
  end: number
  frames: VideoFrame[]
  segments: TranscriptSegment[]
  notes: string[]
}

/** One timeline entry, frames before speech at equal times. */
type TimelineEntry =
  | { kind: 'frame'; time: number; index: number; frame: VideoFrame }
  | { kind: 'speech'; time: number; segment: TranscriptSegment }

/**
 * Merge frames and speech into one time-ordered list.
 * @param value - the read outcome.
 * @returns timeline entries.
 */
export function buildTimeline(value: VideoReadValue): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...value.frames.map((frame, index) => ({ kind: 'frame' as const, time: frame.time, index, frame })),
    ...value.segments.map(segment => ({ kind: 'speech' as const, time: segment.start, segment })),
  ]
  return entries.sort((a, b) => a.time - b.time || (a.kind === 'frame' ? -1 : 1))
}

/**
 * Project a canonical value into model-facing content: an interleaved
 * timeline of frame images and speech.
 * @param value - the read outcome.
 * @returns content blocks.
 */
export function renderVideo(value: VideoReadValue): ContentBlock[] {
  const window = `${formatTimestamp(value.start)}–${formatTimestamp(value.end)}`
  const lines = [`<path>${value.path}</path>`, `<duration>${formatTimestamp(value.duration)}</duration>`, `<window>${window}</window>`]
  for (const note of value.notes) lines.push(`<note>${note}</note>`)
  const blocks: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
  for (const entry of buildTimeline(value)) {
    if (entry.kind === 'frame') {
      blocks.push({ type: 'text', text: `[${formatTimestamp(entry.time)}] frame ${entry.index + 1}` })
      if (entry.frame.image !== undefined) blocks.push(imageBlock(entry.frame.image))
    } else {
      blocks.push({ type: 'text', text: `[${formatTimestamp(entry.segment.start)}–${formatTimestamp(entry.segment.end)}] said: ${entry.segment.text}` })
    }
  }
  blocks.push({ type: 'text', text: 'To look closer at a moment, call read_video again with start and end around it; the same frame budget then covers a shorter span.' })
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
 * Register `read_video`.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = config as ResolvedConfig
  const audioConfig = ReadAudio.Config({ cacheDir: cfg.cacheDir, commandTimeoutMs: cfg.commandTimeoutMs }) as Required<ReadAudio.Config>

  ctx.tools.register(defineTool({
    name: 'read_video',
    description: 'Watch a video file (.mp4, .mov, .webm, screen recordings, …): returns keyframes at the largest visual changes and the spoken audio, merged into one timestamped timeline. '
      + 'Start with the whole video, then call again with start/end around a moment to see it in more detail.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the video file.' },
      start: { type: 'string', description: 'Window start: seconds, MM:SS or HH:MM:SS. Default: beginning.' },
      end: { type: 'string', description: 'Window end: seconds, MM:SS or HH:MM:SS. Default: end of video.' },
      transcript: { type: 'boolean', description: 'Include the spoken audio. Default true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          duration: { type: 'number', required: true },
          start: { type: 'number', required: true },
          end: { type: 'number', required: true },
          frames: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { time: { type: 'number', required: true }, image: STORED_IMAGE_SCHEMA },
            },
          },
          segments: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                start: { type: 'number', required: true },
                end: { type: 'number', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderVideo(value),
      presentationMeta: (_args, value) => ({
        path: value.path,
        duration: value.duration,
        start: value.start,
        end: value.end,
        frameTimes: value.frames.map(f => f.time),
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
      const target = await resolveTarget(ctx, exec, args.file_path)
      const hostPath = ctx.fs.processPath(target)
      const info = await probeMedia(ctx, hostPath, cfg.commandTimeoutMs, exec.signal)
      if (!info.hasVideo) throw new Error(`"${target.displayPath}" has no video stream; use read_audio for audio files`)
      if (info.duration > cfg.maxDurationSeconds) {
        throw new Error(`"${target.displayPath}" is ${formatTimestamp(info.duration)} long; read_video accepts at most ${formatTimestamp(cfg.maxDurationSeconds)}`)
      }
      const window = resolveWindow(args.start, args.end, info.duration)
      const notes: string[] = []
      const frames: VideoFrame[] = []

      const imagesOk = ctx.get('attachments') !== undefined && await routeAcceptsImages(ctx, exec)
      if (imagesOk) {
        const outDir = await mkdtemp(join(tmpdir(), 'dsh-read-video-'))
        try {
          const extracted = await extractFrames(ctx, {
            path: hostPath,
            start: window.start,
            end: window.end,
            maxFrames: cfg.maxFramesPerCall,
            sampling: cfg.sampling,
            minSceneScore: cfg.minSceneScore,
            minGapSeconds: cfg.minFrameGapSeconds,
            maxWidth: cfg.frameMaxWidth,
            timeoutMs: cfg.commandTimeoutMs,
            outDir,
          }, exec.signal)
          for (const frame of extracted) {
            const label = `${basename(target.displayPath)} ${formatTimestamp(frame.time).replaceAll(':', '-')}.png`
            frames.push({ time: frame.time, image: await savePng(ctx, frame.file, label) })
          }
        } finally {
          await rm(outDir, { recursive: true, force: true })
        }
      } else {
        notes.push('Frames were not returned because the current model cannot take images.')
      }

      let segments: TranscriptSegment[] = []
      if (args.transcript !== false && info.hasAudio) {
        if (ctx.get('speechToText') === undefined) {
          notes.push('Speech was not transcribed because no speech-to-text service is mounted.')
        } else {
          const all = await ReadAudio.transcribeFile(ctx, hostPath, info.duration, audioConfig, exec.signal)
          segments = ReadAudio.selectWindow(all, window.start, window.end)
          const chars = segments.reduce((sum, s) => sum + s.text.length, 0)
          if (chars > cfg.maxTranscriptChars) {
            notes.push(`Speech in this window exceeds ${cfg.maxTranscriptChars} characters; only the first part is shown. Narrow start/end or use read_audio.`)
            let used = 0
            segments = segments.filter((s) => { used += s.text.length; return used <= cfg.maxTranscriptChars })
          }
        }
      } else if (!info.hasAudio) {
        notes.push('The video has no audio track.')
      }
      return { path: target.displayPath, duration: info.duration, start: window.start, end: window.end, frames, segments, notes }
    },
    presentCall(args): GenericCallView {
      const window = args.start === undefined && args.end === undefined ? '' : ` (${args.start ?? '0'}–${args.end ?? 'end'})`
      return { card: 'generic', title: `Watch ${args.file_path}${window}`, kind: 'read', locations: [{ path: args.file_path }] }
    },
  }))
}
