/**
 * Model-facing text for user marks, and the queue that holds marks until the
 * agent's next tool result carries them.
 * @module @deepseek-ai/dsh-experimental-co-canvas/marks
 */

import type { CanvasControl, CanvasMark, DesktopWindow, MarkTarget } from './types.ts'

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
 * Describe the desktop window under a mark.
 * @param window - grounded window.
 * @param x - mark focus x in screen points.
 * @param y - mark focus y in screen points.
 * @returns e.g. `window "Untitled - Notepad" of Notepad (pid 42, window_id 7), at (120, 80) inside it`.
 */
export function describeWindow(window: DesktopWindow, x: number, y: number): string {
  const ids = [window.pid === undefined ? '' : `pid ${window.pid}`, window.windowId === undefined ? '' : `window_id ${window.windowId}`].filter(Boolean).join(', ')
  const app = window.app === '' ? '' : ` of ${window.app}`
  return `window "${window.title}"${app}${ids === '' ? '' : ` (${ids})`}, at (${Math.round(x - window.bounds.x)}, ${Math.round(y - window.bounds.y)}) inside it`
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
  const note = mark.note === undefined || mark.note === '' ? '' : ` — note: "${mark.note}"`
  if (mark.surface === 'desktop') {
    const fx = mark.shape === 'box' ? x + width / 2 : mark.shape === 'arrow' ? x + width : x
    const fy = mark.shape === 'box' ? y + height / 2 : mark.shape === 'arrow' ? y + height : y
    const target = mark.window === undefined ? 'no window found there' : describeWindow(mark.window, fx, fy)
    return `${where} on the desktop (screen points): ${target}${note}`
  }
  const target = mark.target === undefined ? 'no element found there' : describeTarget(mark.target)
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
  if (handback === 'human') lines.push('The user operated the browser or desktop themselves and handed control back; the screen may have changed since your last step.')
  if (handback === 'paused') lines.push('The user paused you and resumed; the screen may have changed since your last step.')
  const shown = marks.slice(-maxMarks)
  if (marks.length > shown.length) lines.push(`(${marks.length - shown.length} older marks omitted)`)
  if (shown.length > 0) {
    const surfaces = new Set(shown.map(m => m.surface))
    const what = surfaces.size > 1 ? 'the shared browser and the desktop' : surfaces.has('desktop') ? 'the desktop' : 'the shared browser'
    const units = surfaces.size > 1 ? 'page CSS pixels in the browser, screen points on the desktop' : surfaces.has('desktop') ? 'screen points' : 'page CSS pixels'
    lines.push(`The user marked ${what} (coordinates in ${units}). Treat these marks as instructions:`)
    shown.forEach((mark, i) => { lines.push(`${i + 1}. ${describeMark(mark)}`) })
  }
  lines.push('</user_marks>')
  return lines.join('\n')
}
