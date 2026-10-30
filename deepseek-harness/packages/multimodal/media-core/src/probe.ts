/**
 * Media stream facts from `ffprobe`: duration and which stream kinds exist.
 * @module @deepseek-ai/dsh-media-core/probe
 */

import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { runMediaCommand } from './command.ts'

/** Hint shown when ffmpeg/ffprobe is missing. */
export const FFMPEG_HINT = 'ffmpeg (apt install ffmpeg / brew install ffmpeg)'

/** Facts the audio and video tools need before planning work. */
export interface MediaInfo {
  /** Container duration in seconds. */
  readonly duration: number
  readonly hasAudio: boolean
  readonly hasVideo: boolean
  /** Width and height of the first video stream, when present. */
  readonly width?: number
  readonly height?: number
}

/**
 * Parse `ffprobe -print_format json -show_format -show_streams` output.
 * Attached cover art (a still image in an audio file) does not count as video.
 * @param json - ffprobe stdout.
 * @returns media facts.
 * @throws Error when the output has no usable duration.
 */
export function parseProbe(json: string): MediaInfo {
  const data = JSON.parse(json) as {
    format?: { duration?: string }
    streams?: { codec_type?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }[]
  }
  const duration = Number(data.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe reported no duration; the file may not be audio or video')
  const streams = data.streams ?? []
  const video = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  return {
    duration,
    hasAudio: streams.some(s => s.codec_type === 'audio'),
    hasVideo: video !== undefined,
    ...video?.width === undefined || video.height === undefined ? {} : { width: video.width, height: video.height },
  }
}

/**
 * Probe one media file.
 * @param ctx - context providing `ctx.subprocess`.
 * @param path - host path of the media file.
 * @param timeoutMs - command deadline.
 * @param signal - cancellation.
 * @returns duration and stream facts.
 */
export async function probeMedia(ctx: Context, path: string, timeoutMs: number, signal: AbortSignal): Promise<MediaInfo> {
  const result = await runMediaCommand(ctx, {
    argv: ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    cwd: tmpdir(),
    timeoutMs,
    maxStdoutBytes: 1 << 20,
    maxStderrBytes: 4096,
    signal,
  }, FFMPEG_HINT)
  return parseProbe(result.stdout)
}
