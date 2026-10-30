/**
 * Model-facing text for user marks, and the queue that holds marks until the
 * agent's next tool result carries them.
 * @module @deepseek-ai/dsh-experimental-co-canvas/marks
 */

import type { CanvasControl, CanvasMark, MarkTarget } from './types.ts'

const SUFFIX: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' }
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : SUFFIX[n % 10] ?? 'th'}`

/**
 * Describe the element a mark points at.
 * @param target - grounded element.
 * @returns e.g. `button "Submit" (2nd of 2 buttons with this text), selector div:nth-of-type(3) > button`.
 */
export function describeTarget(target: MarkTarget): string {
  const kind = target.role ?? target.tag
  const name = target.text !== '' ? ` "${target.text}"` : target.label === undefined ? '' : ` labelled "${target.label}"`
  const which = target.sameCount > 1 ? ` (${ordinal(target.nth)} of ${target.sameCount} ${kind} elements with this text)` : ''
  return `${kind}${name}${which}, selector \`${target.selector}\``
}

/**
 * Describe one mark on one line.
 * @param mark - recorded mark.
 * @returns the mark's shape, position, element and note.
 */
export function describeMark(mark: CanvasMark): string {
  const { x, y, width, height } = mark.rect
  const where = mark.shape === 'point'
    ? `point at (${Math.round(x)}, ${Math.round(y)})`
    : mark.shape === 'arrow'
      ? `arrow from (${Math.round(x)}, ${Math.round(y)}) to (${Math.round(x + width)}, ${Math.round(y + height)})`
      : `box at (${Math.round(x)}, ${Math.round(y)}), ${Math.round(Math.abs(width))}×${Math.round(Math.abs(height))}`
  const target = mark.target === undefined ? 'no element found there' : describeTarget(mark.target)
  const note = mark.note === undefined || mark.note === '' ? '' : ` — note: "${mark.note}"`
  return `${where} on "${mark.title}" (${mark.url}): ${target}${note}`
}

/**
 * Text delivered with the agent's next tool result.
 * @param marks - undelivered marks, oldest first.
 * @param handback - control the user held since the agent's last step, if any.
 * @param maxMarks - most marks listed; older ones are summarized by count.
 * @returns the message body.
 */
export function marksMessage(marks: readonly CanvasMark[], handback: CanvasControl | undefined, maxMarks: number): string {
  const lines: string[] = ['<user_marks>']
  if (handback === 'human') lines.push('The user operated the browser themselves and handed control back; the page may have changed since your last step.')
  if (handback === 'paused') lines.push('The user paused you and resumed; the page may have changed since your last step.')
  const shown = marks.slice(-maxMarks)
  if (marks.length > shown.length) lines.push(`(${marks.length - shown.length} older marks omitted)`)
  if (shown.length > 0) {
    lines.push('The user marked the shared browser (coordinates in page CSS pixels). Treat these marks as instructions:')
    shown.forEach((mark, i) => { lines.push(`${i + 1}. ${describeMark(mark)}`) })
  }
  lines.push('</user_marks>')
  return lines.join('\n')
}
