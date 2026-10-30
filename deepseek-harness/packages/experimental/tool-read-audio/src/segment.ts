/**
 * Silence-aware segmentation. The speech seam returns text without
 * timestamps, so timestamps come from transcribing short segments whose
 * boundaries are known. Cutting inside pauses keeps sentences whole.
 * @module @deepseek-ai/dsh-experimental-tool-read-audio/segment
 */

/** One span of silence reported by ffmpeg `silencedetect`. */
export interface Silence {
  readonly start: number
  readonly end: number
}

/** One planned or transcribed span in seconds. */
export interface Span {
  readonly start: number
  readonly end: number
}

/**
 * Parse `silencedetect` lines from ffmpeg stderr. A silence still open at the
 * end of the stream is closed at `duration`.
 * @param stderr - ffmpeg diagnostic output.
 * @param duration - media duration in seconds.
 * @returns silences in stream order.
 */
export function parseSilences(stderr: string, duration: number): Silence[] {
  const out: Silence[] = []
  let open: number | undefined
  for (const match of stderr.matchAll(/silence_(start|end): (-?\d+(?:\.\d+)?)/gu)) {
    const at = Math.max(0, Number(match[2]))
    if (match[1] === 'start') {
      open = at
    } else if (open !== undefined) {
      out.push({ start: open, end: at })
      open = undefined
    }
  }
  if (open !== undefined) out.push({ start: open, end: duration })
  return out
}

/**
 * Plan segments of at most `maxSeconds`, cutting at the middle of the last
 * silence that ends a segment of at least `minSeconds`; a stretch with no
 * usable silence is cut hard at `maxSeconds`. A final remainder shorter than
 * `minSeconds` extends the last segment, which may then exceed `maxSeconds`
 * by less than `minSeconds`.
 * @param duration - media duration in seconds.
 * @param silences - detected silences.
 * @param maxSeconds - longest segment.
 * @param minSeconds - shortest segment worth a cut at a silence.
 * @returns contiguous spans covering `[0, duration]`.
 */
export function planSegments(duration: number, silences: readonly Silence[], maxSeconds: number, minSeconds: number): Span[] {
  const cuts = silences.map(s => (s.start + s.end) / 2).filter(t => t > 0 && t < duration)
  const spans: Span[] = []
  let start = 0
  for (;;) {
    // The first pause after minSeconds ends the segment, so a segment is about one utterance;
    // speech without such a pause is cut hard at maxSeconds.
    const pause = cuts.find(t => t >= start + minSeconds && t <= start + maxSeconds)
    const cut = pause ?? (duration - start > maxSeconds ? start + maxSeconds : undefined)
    // A tail shorter than minSeconds joins this segment instead of standing
    // alone: a sliver of audio decodes to too few samples to recognize.
    if (cut === undefined || duration - cut < minSeconds) break
    spans.push({ start, end: cut })
    start = cut
  }
  spans.push({ start, end: duration })
  return spans
}

/**
 * Whether a span lies entirely in silence, so it needs no transcription.
 * @param span - planned segment.
 * @param silences - detected silences.
 * @returns true when one silence covers the whole span.
 */
export function isSilent(span: Span, silences: readonly Silence[]): boolean {
  return silences.some(s => s.start <= span.start + 0.05 && s.end >= span.end - 0.05)
}
