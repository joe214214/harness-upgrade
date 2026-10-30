/**
 * Timestamped transcription of any audio or video file: detect silences,
 * plan segments, convert each to canonical 16 kHz mono PCM16 WAV, and send
 * it through the speech seam (`ctx.speechToText`). The whole-file result is
 * cached by content, provider and language, so a later window read or a
 * `read_video` call on the same file costs no recognition.
 * @module @deepseek-ai/dsh-experimental-tool-read-audio/transcribe
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import { FFMPEG_HINT, runMediaCommand } from '@deepseek-ai/dsh-media-core'
import type { MediaCache } from '@deepseek-ai/dsh-media-core'
import { isSilent, parseSilences, planSegments } from './segment.ts'

/**
 * Wrap 16 kHz mono PCM16 samples in a canonical 44-byte WAV header.
 * @param pcm - little-endian 16-bit samples.
 * @returns WAV bytes accepted by speech providers.
 */
export function canonicalWave(pcm: Uint8Array): Uint8Array {
  const samples = pcm.byteLength - (pcm.byteLength % 2)
  const out = Buffer.alloc(44 + samples)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + samples, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16_000, 24)
  out.writeUInt32LE(32_000, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(samples, 40)
  out.set(pcm.subarray(0, samples), 44)
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

/** One transcribed segment. */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

/** Explicit transcription parameters, all from the calling tool's config. */
export interface TranscribeOptions {
  readonly duration: number
  readonly maxSegmentSeconds: number
  readonly minSegmentSeconds: number
  /** silencedetect noise floor, e.g. `-30dB`. */
  readonly silenceNoise: string
  /** Shortest pause counted as silence, in seconds. */
  readonly silenceSeconds: number
  readonly commandTimeoutMs: number
}

/**
 * Transcribe a whole media file into timestamped segments.
 * @param ctx - context with `subprocess` and `speechToText`.
 * @param path - host path of the media file.
 * @param digest - SHA-256 of the file.
 * @param cache - result cache.
 * @param options - segmentation and command limits.
 * @param signal - cancellation.
 * @returns non-empty transcript segments in time order.
 * @throws Error when no speech service is mounted.
 */
export async function transcribeMedia(
  ctx: Context, path: string, digest: string, cache: MediaCache, options: TranscribeOptions, signal: AbortSignal,
): Promise<TranscriptSegment[]> {
  const speech = ctx.get('speechToText')
  if (speech === undefined) {
    throw new Error('no speech-to-text service is mounted; enable a speech provider (for example the voice input bundle) to transcribe audio')
  }
  const spec = speech.resolve({ audio: new Uint8Array() })
  const key = cache.key(digest, 'transcript', {
    provider: spec.provider.info.id,
    language: spec.language,
    max: options.maxSegmentSeconds,
    min: options.minSegmentSeconds,
    noise: options.silenceNoise,
    pause: options.silenceSeconds,
  })
  const cached = await cache.get<TranscriptSegment[]>(key)
  if (cached !== undefined) return cached

  const common = { cwd: tmpdir(), timeoutMs: options.commandTimeoutMs, signal }
  const detect = await runMediaCommand(ctx, {
    ...common,
    argv: ['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-vn', '-af',
      `silencedetect=noise=${options.silenceNoise}:d=${options.silenceSeconds}`, '-f', 'null', '-'],
    maxStdoutBytes: 4096,
    maxStderrBytes: 8 << 20,
  }, FFMPEG_HINT)
  const silences = parseSilences(detect.stderr, options.duration)
  const spans = planSegments(options.duration, silences, options.maxSegmentSeconds, options.minSegmentSeconds)

  const work = await mkdtemp(join(tmpdir(), 'dsh-read-audio-'))
  const segments: TranscriptSegment[] = []
  try {
    for (const [index, span] of spans.entries()) {
      if (isSilent(span, silences)) continue
      const pcm = join(work, `seg-${index}.pcm`)
      // Raw PCM plus a header written here: ffmpeg's WAV muxer may add
      // LIST/INFO chunks, and speech providers accept only the canonical
      // 44-byte header.
      await runMediaCommand(ctx, {
        ...common,
        argv: ['ffmpeg', '-hide_banner', '-nostats', '-y', '-ss', span.start.toFixed(3), '-t', (span.end - span.start).toFixed(3),
          '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-c:a', 'pcm_s16le', pcm],
        maxStdoutBytes: 4096,
        maxStderrBytes: 16 * 1024,
      }, FFMPEG_HINT)
      const samples = await readFile(pcm)
      await rm(pcm, { force: true })
      // Under 0.1 s of samples: nothing a recognizer could use.
      if (samples.byteLength < 3200) continue
      const audio = canonicalWave(samples)
      const result = await speech.transcribe(speech.resolve({ audio }), signal)
      const text = result.text.trim()
      if (text) segments.push({ start: span.start, end: span.end, text })
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  await cache.put(key, segments)
  return segments
}
