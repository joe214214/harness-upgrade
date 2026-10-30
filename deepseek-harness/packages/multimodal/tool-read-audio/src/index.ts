/**
 * The model-facing `read_audio` tool: a timestamped transcript of an audio
 * (or video) file through the speech seam. A short recording comes back
 * whole; a long one comes back as a time index, and the model reads the part
 * it needs with `start`/`end`.
 * @module @deepseek-ai/dsh-tool-read-audio
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import { MediaCache, formatTimestamp, hashFile, probeMedia, resolveWindow } from '@deepseek-ai/dsh-media-core'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { transcribeMedia } from './transcribe.ts'
import type { TranscribeOptions, TranscriptSegment } from './transcribe.ts'

export { isSilent, parseSilences, planSegments } from './segment.ts'
export type { Silence, Span } from './segment.ts'
export { canonicalWave, transcribeMedia } from './transcribe.ts'
export type { TranscribeOptions, TranscriptSegment } from './transcribe.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-read-audio'

/** Required services; the transcript itself needs `speechToText` at call time. */
export const inject = ['tools', 'fs', 'subprocess']

/** Plugin config; every field has a validated default. */
export interface Config {
  /** Longest transcription segment in seconds. */
  maxSegmentSeconds?: number
  /** Shortest segment worth cutting at a pause. */
  minSegmentSeconds?: number
  /** silencedetect noise floor. */
  silenceNoise?: string
  /** Shortest pause counted as silence, in seconds. */
  silenceSeconds?: number
  /** Longest file accepted, in seconds. */
  maxDurationSeconds?: number
  /** Transcript characters returned before switching to a time index. */
  maxTranscriptChars?: number
  /** Length of one entry of the time index, in seconds. */
  indexBlockSeconds?: number
  /** Deadline for each ffmpeg command. */
  commandTimeoutMs?: number
  /** Directory for cached transcripts. */
  cacheDir?: string
}

export const Config: z<Config> = z.object({
  maxSegmentSeconds: z.natural().min(5).max(120).default(30),
  minSegmentSeconds: z.natural().min(1).default(8),
  silenceNoise: z.string().pattern(/^-\d+dB$/u).default('-30dB'),
  silenceSeconds: z.number().min(0.1).max(5).default(0.4),
  maxDurationSeconds: z.natural().min(1).default(4 * 3600),
  maxTranscriptChars: z.natural().min(50).default(12_000),
  indexBlockSeconds: z.natural().min(30).default(300),
  commandTimeoutMs: z.natural().min(1000).default(300_000),
  cacheDir: z.string().default(join(tmpdir(), 'dsh-media-cache')),
})

type ResolvedConfig = Required<Config>

/** Canonical value of one `read_audio` call. */
export interface AudioReadValue {
  path: string
  duration: number
  start: number
  end: number
  /** Segments inside the window; empty when an index is returned instead. */
  segments: TranscriptSegment[]
  /** Time index of a transcript too long to return whole. */
  index?: string
}

/**
 * Format segments as `[MM:SS–MM:SS] text` lines.
 * @param segments - transcript segments.
 * @returns one line per segment.
 */
export function formatTranscript(segments: readonly TranscriptSegment[]): string {
  return segments.map(s => `[${formatTimestamp(s.start)}–${formatTimestamp(s.end)}] ${s.text}`).join('\n')
}

/**
 * Group segments into fixed blocks with a preview of each block's speech.
 * @param segments - segments inside the window.
 * @param start - window start.
 * @param end - window end.
 * @param blockSeconds - block length.
 * @returns one line per block that contains speech.
 */
export function buildTimeIndex(segments: readonly TranscriptSegment[], start: number, end: number, blockSeconds: number): string {
  const lines: string[] = []
  for (let from = start; from < end; from += blockSeconds) {
    const to = Math.min(end, from + blockSeconds)
    const inside = segments.filter(s => s.start >= from && s.start < to)
    if (inside.length === 0) continue
    const words = inside.map(s => s.text).join(' ')
    const chars = inside.reduce((sum, s) => sum + s.text.length, 0)
    lines.push(`[${formatTimestamp(from)}–${formatTimestamp(to)}] ${chars} chars — ${words.slice(0, 160)}${words.length > 160 ? '…' : ''}`)
  }
  return lines.join('\n')
}

/**
 * Select the segments overlapping a window.
 * @param segments - whole-file transcript.
 * @param start - window start.
 * @param end - window end.
 * @returns overlapping segments.
 */
export function selectWindow(segments: readonly TranscriptSegment[], start: number, end: number): TranscriptSegment[] {
  return segments.filter(s => s.end > start && s.start < end)
}

/**
 * Project a canonical value into model-facing text.
 * @param value - the read outcome.
 * @returns the transcript or the time index with guidance.
 */
export function renderAudio(value: AudioReadValue): string {
  const window = `${formatTimestamp(value.start)}–${formatTimestamp(value.end)}`
  const header = `<path>${value.path}</path>\n<duration>${formatTimestamp(value.duration)}</duration>\n<window>${window}</window>`
  if (value.index !== undefined) {
    return `${header}\n<index>\n${value.index}\n</index>\nThe transcript is too long to return whole. Call read_audio again with start and end (for example start "05:00", end "10:00") to read a part.`
  }
  if (value.segments.length === 0) return `${header}\n<transcript>\n(no speech recognized in this window)\n</transcript>`
  return `${header}\n<transcript>\n${formatTranscript(value.segments)}\n</transcript>`
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
 * Transcribe a file and select a window, shared with `read_video`.
 * @param ctx - context with `fs`, `subprocess` and `speechToText`.
 * @param hostPath - host path of the media file.
 * @param duration - media duration in seconds.
 * @param cfg - resolved `read_audio` config.
 * @param signal - cancellation.
 * @returns whole-file transcript segments.
 */
export async function transcribeFile(
  ctx: Context, hostPath: string, duration: number, cfg: ResolvedConfig, signal: AbortSignal,
): Promise<TranscriptSegment[]> {
  const options: TranscribeOptions = {
    duration,
    maxSegmentSeconds: cfg.maxSegmentSeconds,
    minSegmentSeconds: cfg.minSegmentSeconds,
    silenceNoise: cfg.silenceNoise,
    silenceSeconds: cfg.silenceSeconds,
    commandTimeoutMs: cfg.commandTimeoutMs,
  }
  return transcribeMedia(ctx, hostPath, await hashFile(hostPath, signal), new MediaCache(cfg.cacheDir), options, signal)
}

/**
 * Register `read_audio`.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = config as ResolvedConfig
  ctx.tools.register(defineTool({
    name: 'read_audio',
    description: 'Transcribe an audio or video file (.mp3, .wav, .m4a, .mp4, …) into timestamped text. '
      + 'A short recording returns the whole transcript; a long one returns a time index, then call again with start/end to read a part. '
      + 'Timestamps let you quote exactly when something was said.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the audio or video file.' },
      start: { type: 'string', description: 'Window start: seconds, MM:SS or HH:MM:SS. Default: beginning.' },
      end: { type: 'string', description: 'Window end: seconds, MM:SS or HH:MM:SS. Default: end of file.' },
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
          index: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderAudio(value) }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        duration: value.duration,
        segments: value.segments.map(s => ({ start: s.start, end: s.end, text: s.text.slice(0, 200) })),
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
      const target = await resolveTarget(ctx, exec, args.file_path)
      const hostPath = ctx.fs.processPath(target)
      const info = await probeMedia(ctx, hostPath, cfg.commandTimeoutMs, exec.signal)
      if (!info.hasAudio) throw new Error(`"${target.displayPath}" has no audio stream`)
      if (info.duration > cfg.maxDurationSeconds) {
        throw new Error(`"${target.displayPath}" is ${formatTimestamp(info.duration)} long; read_audio accepts at most ${formatTimestamp(cfg.maxDurationSeconds)}`)
      }
      const window = resolveWindow(args.start, args.end, info.duration)
      const all = await transcribeFile(ctx, hostPath, info.duration, cfg, exec.signal)
      const segments = selectWindow(all, window.start, window.end)
      const base = { path: target.displayPath, duration: info.duration, start: window.start, end: window.end }
      const chars = segments.reduce((sum, s) => sum + s.text.length + 16, 0)
      if (chars > cfg.maxTranscriptChars) {
        return { ...base, segments: [], index: buildTimeIndex(segments, window.start, window.end, cfg.indexBlockSeconds) }
      }
      return { ...base, segments }
    },
    presentCall(args): GenericCallView {
      const window = args.start === undefined && args.end === undefined ? '' : ` (${args.start ?? '0'}–${args.end ?? 'end'})`
      return { card: 'generic', title: `Transcribe ${args.file_path}${window}`, kind: 'read', locations: [{ path: args.file_path }] }
    },
  }))
}
