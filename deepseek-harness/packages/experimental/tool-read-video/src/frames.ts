/**
 * Keyframe selection. Change sampling scores every frame of the window with
 * ffmpeg's scene detector on a downscaled copy, then keeps the window's first
 * frame plus the largest changes. A fixed score threshold does not work
 * across content: film cuts score above 0.3, while an error banner appearing
 * in a screen recording scores about 0.1 and a text edit about 0.005. Ranking
 * changes instead of thresholding them covers both. Uniform sampling is the
 * baseline it is measured against.
 * @module @deepseek-ai/dsh-experimental-tool-read-video/frames
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FFMPEG_HINT, runMediaCommand } from '@deepseek-ai/dsh-media-core'

/** How frames are chosen inside a window. */
export type Sampling = 'scene' | 'uniform'

/** Scene score of one frame, at seconds from the window start. */
export interface ScoredFrame {
  readonly time: number
  readonly score: number
}

/** Parameters for one extraction run. */
export interface FrameRequest {
  readonly path: string
  readonly start: number
  readonly end: number
  readonly maxFrames: number
  readonly sampling: Sampling
  /** Changes scoring below this are encoder noise, not content. */
  readonly minSceneScore: number
  /** Selected frames are at least this far apart, so one transition yields one frame. */
  readonly minGapSeconds: number
  readonly maxWidth: number
  readonly timeoutMs: number
  readonly outDir: string
}

/** One extracted frame. */
export interface ExtractedFrame {
  /** Seconds from the start of the file. */
  readonly time: number
  readonly file: string
}

/** Width of the copy scored in the first pass; scene scores barely depend on resolution. */
const SCORE_WIDTH = 320

/**
 * Read `pts_time` and `lavfi.scene_score` pairs from ffmpeg `metadata=print` output.
 * @param stderr - ffmpeg diagnostic output.
 * @returns one score per frame in stream order.
 */
export function parseSceneScores(stderr: string): ScoredFrame[] {
  const out: ScoredFrame[] = []
  let time: number | undefined
  for (const line of stderr.split('\n')) {
    const pts = /pts_time:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (pts !== null) {
      time = Number(pts[1])
      continue
    }
    const score = /lavfi\.scene_score=(\d+(?:\.\d+)?)/u.exec(line)
    if (score !== null && time !== undefined) {
      out.push({ time, score: Number(score[1]) })
      time = undefined
    }
  }
  return out
}

/**
 * Choose frame times by change: the first frame, then the highest-scoring
 * changes above `minScore`, each at least `minGap` from those already kept.
 * A frame is taken shortly after its change point, so a transition that
 * spans a few frames is captured once it has settled.
 * @param scores - per-frame scores relative to the window start.
 * @param span - window length in seconds.
 * @param maxFrames - most frames to keep.
 * @param minScore - noise floor.
 * @param minGap - minimum spacing in seconds.
 * @returns selected times relative to the window start, ascending.
 */
export function selectChangeTimes(
  scores: readonly ScoredFrame[], span: number, maxFrames: number, minScore: number, minGap: number,
): number[] {
  const settle = Math.min(0.3, minGap / 2)
  const chosen: number[] = [0]
  const ranked = scores.filter(s => s.score >= minScore && s.time > 0).sort((a, b) => b.score - a.score)
  for (const candidate of ranked) {
    if (chosen.length >= maxFrames) break
    const at = Math.min(candidate.time + settle, Math.max(0, span - 0.05))
    if (chosen.every(t => Math.abs(t - at) >= minGap)) chosen.push(at)
  }
  return chosen.sort((a, b) => a - b)
}

/**
 * Evenly spaced times, each in the middle of its slice of the window.
 * @param span - window length in seconds.
 * @param count - how many frames.
 * @returns times relative to the window start, ascending.
 */
export function uniformTimes(span: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => ((i + 0.5) * span) / count)
}

/**
 * Select and extract frames for one window.
 * @param ctx - context providing `ctx.subprocess`.
 * @param request - window, sampling and limits.
 * @param signal - cancellation.
 * @returns extracted frames in time order.
 */
export async function extractFrames(ctx: Context, request: FrameRequest, signal: AbortSignal): Promise<ExtractedFrame[]> {
  const span = request.end - request.start
  const common = { cwd: request.outDir, timeoutMs: request.timeoutMs, maxStdoutBytes: 4096, signal }
  let times: number[]
  if (request.sampling === 'uniform') {
    times = uniformTimes(span, request.maxFrames)
  } else {
    const scored = await runMediaCommand(ctx, {
      ...common,
      argv: ['ffmpeg', '-hide_banner', '-nostats', '-ss', request.start.toFixed(3), '-to', request.end.toFixed(3), '-i', request.path, '-an',
        '-vf', `scale=${SCORE_WIDTH}:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score`, '-f', 'null', '-'],
      maxStderrBytes: 32 << 20,
    }, FFMPEG_HINT)
    times = selectChangeTimes(parseSceneScores(scored.stderr), span, request.maxFrames, request.minSceneScore, request.minGapSeconds)
  }
  const frames: ExtractedFrame[] = []
  for (const [index, offset] of times.entries()) {
    const file = join(request.outDir, `f-${String(index).padStart(3, '0')}.png`)
    await runMediaCommand(ctx, {
      ...common,
      argv: ['ffmpeg', '-hide_banner', '-nostats', '-y', '-ss', (request.start + offset).toFixed(3), '-i', request.path, '-an',
        '-frames:v', '1', '-vf', `scale='min(${request.maxWidth},iw)':-2`, file],
      maxStderrBytes: 16 * 1024,
    }, FFMPEG_HINT)
    frames.push({ time: request.start + offset, file })
  }
  return frames
}
