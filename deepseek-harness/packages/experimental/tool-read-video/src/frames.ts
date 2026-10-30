/**
 * Keyframe extraction. Scene-change sampling keeps one frame per visual
 * change, which suits screen recordings where most frames repeat; uniform
 * sampling is the baseline it is measured against.
 * @module @deepseek-ai/dsh-experimental-tool-read-video/frames
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FFMPEG_HINT, runMediaCommand } from '@deepseek-ai/dsh-media-core'

/** How frames are chosen inside a window. */
export type Sampling = 'scene' | 'uniform'

/** Parameters for one extraction run. */
export interface FrameRequest {
  readonly path: string
  readonly start: number
  readonly end: number
  readonly maxFrames: number
  readonly sampling: Sampling
  /** Minimum scene score (0–1) for a scene-change frame. */
  readonly sceneThreshold: number
  readonly maxWidth: number
  /** Upper bound on frames written before selection, protecting disk on noisy video. */
  readonly maxCandidates: number
  readonly timeoutMs: number
  readonly outDir: string
}

/** One extracted frame. */
export interface ExtractedFrame {
  /** Seconds from the start of the file. */
  readonly time: number
  readonly file: string
}

/**
 * Read `pts_time` values from ffmpeg `showinfo` output, in frame order.
 * @param stderr - ffmpeg diagnostic output.
 * @returns presentation times relative to the input's start.
 */
export function parseShowinfoTimes(stderr: string): number[] {
  return [...stderr.matchAll(/Parsed_showinfo.*?pts_time:\s*(-?\d+(?:\.\d+)?)/gu)].map(m => Number(m[1]))
}

/**
 * Keep at most `max` items spread evenly across the list, always keeping the first.
 * @param items - candidates in time order.
 * @param max - how many to keep.
 * @returns the selected items in time order.
 */
export function spreadPick<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items]
  if (max <= 1) return items.slice(0, Math.max(0, max))
  const step = (items.length - 1) / (max - 1)
  const out: T[] = []
  for (let i = 0; i < max; i += 1) {
    const item = items.at(Math.round(i * step))
    if (item !== undefined) out.push(item)
  }
  return out
}

/**
 * Build the ffmpeg video filter for one sampling mode.
 * @param request - extraction parameters.
 * @returns the `-vf` filter graph.
 */
export function frameFilter(request: Pick<FrameRequest, 'sampling' | 'sceneThreshold' | 'maxFrames' | 'start' | 'end' | 'maxWidth'>): string {
  const scale = `scale='min(${request.maxWidth},iw)':-2`
  if (request.sampling === 'uniform') {
    const fps = request.maxFrames / (request.end - request.start)
    return `fps=${fps.toFixed(6)},showinfo,${scale}`
  }
  // The first frame of the window is always kept so a static video still yields one frame.
  return `select='eq(n\\,0)+gt(scene\\,${request.sceneThreshold})',showinfo,${scale}`
}

/**
 * Extract frames for one window and select at most `maxFrames`.
 * @param ctx - context providing `ctx.subprocess`.
 * @param request - window, sampling and limits.
 * @param signal - cancellation.
 * @returns selected frames in time order.
 */
export async function extractFrames(ctx: Context, request: FrameRequest, signal: AbortSignal): Promise<ExtractedFrame[]> {
  const result = await runMediaCommand(ctx, {
    argv: ['ffmpeg', '-hide_banner', '-nostats', '-y', '-ss', request.start.toFixed(3), '-to', request.end.toFixed(3), '-i', request.path,
      '-an', '-vf', frameFilter(request), '-fps_mode', 'vfr', '-frames:v', String(request.maxCandidates), join(request.outDir, 'f-%05d.png')],
    cwd: request.outDir,
    timeoutMs: request.timeoutMs,
    maxStdoutBytes: 4096,
    maxStderrBytes: 8 << 20,
    signal,
  }, FFMPEG_HINT)
  const times = parseShowinfoTimes(result.stderr)
  const files = (await readdir(request.outDir)).filter(name => /^f-\d{5}\.png$/u.test(name)).sort()
  const frames = files.map((name, index) => ({ time: request.start + (times[index] ?? 0), file: join(request.outDir, name) }))
  return spreadPick(frames, request.maxFrames)
}
