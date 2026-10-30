/**
 * Parsing and formatting for the coarse-to-fine read arguments every media
 * tool shares: page lists for documents and time windows for audio/video.
 * @module @deepseek-ai/dsh-media-core/ranges
 */

/**
 * Parse a 1-based page selection such as `"3"`, `"2-5"` or `"1,4-6"`.
 * @param spec - model-supplied selection.
 * @param pageCount - pages in the document.
 * @param maxPages - most pages one call may return.
 * @returns sorted, de-duplicated page numbers.
 * @throws Error naming the valid range when the selection is malformed, out of range, or too long.
 */
export function parsePageSelection(spec: string, pageCount: number, maxPages: number): number[] {
  const pages = new Set<number>()
  for (const raw of spec.split(',')) {
    const part = raw.trim()
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/u.exec(part)
    if (match === null) throw new Error(`invalid pages "${spec}": use forms like "3", "2-5" or "1,4-6"`)
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (start < 1 || end > pageCount || start > end) {
      throw new Error(`invalid pages "${spec}": the document has pages 1-${pageCount}`)
    }
    for (let page = start; page <= end; page += 1) pages.add(page)
  }
  if (pages.size > maxPages) {
    throw new Error(`pages "${spec}" selects ${pages.size} pages; read at most ${maxPages} per call`)
  }
  return [...pages].sort((a, b) => a - b)
}

/**
 * Format seconds as `HH:MM:SS` (or `MM:SS` under an hour).
 * @param seconds - non-negative offset.
 * @returns the timestamp text used in transcripts and timelines.
 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Parse a timestamp argument: plain seconds (`"95"`, `"95.5"`), `MM:SS`, or `HH:MM:SS`.
 * @param text - model-supplied timestamp.
 * @returns seconds.
 * @throws Error when the text is not a timestamp.
 */
export function parseTimestamp(text: string): number {
  const trimmed = text.trim()
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed)
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/u.exec(trimmed)
  if (match === null) throw new Error(`invalid timestamp "${text}": use seconds, MM:SS or HH:MM:SS`)
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/**
 * Resolve optional start/end arguments against a media duration.
 * @param start - optional start timestamp text.
 * @param end - optional end timestamp text.
 * @param duration - media length in seconds.
 * @returns the clamped window in seconds.
 * @throws Error when the window is empty or starts past the end of the media.
 */
export function resolveWindow(start: string | undefined, end: string | undefined, duration: number): { start: number; end: number } {
  const from = start === undefined ? 0 : parseTimestamp(start)
  const to = end === undefined ? duration : Math.min(parseTimestamp(end), duration)
  if (from >= duration) throw new Error(`start ${formatTimestamp(from)} is past the end of the media (${formatTimestamp(duration)})`)
  if (to <= from) throw new Error(`empty window: end ${formatTimestamp(to)} is not after start ${formatTimestamp(from)}`)
  return { start: from, end: to }
}
