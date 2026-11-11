/**
 * Marking on the real screen: a full-screen browser window shows a frozen
 * screenshot of the primary display, the user draws marks on it with notes,
 * and chooses to send them, discuss them first, or cancel.
 * @module @deepseek-ai/dsh-experimental-co-canvas/screen-marker
 */

import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import type { DesktopShot } from './desktop.ts'
import type { MarkInput } from './types.ts'

/** Browser used to show the frozen screen. */
export interface ScreenMarkerOptions {
  readonly executablePath?: string | undefined
  readonly channel?: string | undefined
  /** Run without a window; only tests drive a headless marker. */
  readonly headless: boolean
}

/** What the user did on the frozen screen. Mark rectangles are in screen points. */
export interface ScreenMarkResult {
  readonly action: 'send' | 'discuss' | 'cancel'
  readonly marks: readonly MarkInput[]
}

/** Origin the marker page is served from; requests never leave the browser. */
export const SCREEN_MARKER_ORIGIN = 'http://co-canvas.invalid'

/** Binding the marker page calls once with its JSON result. */
export const SCREEN_MARKER_BINDING = '__dshScreenMark'

// Plain browser JavaScript and markup: they run in the marker window, not in Node.
/** Page shown in the marker window; `@W@` and `@H@` are the screen size in points. */
export const SCREEN_MARKER_PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><title>co-canvas</title><style>
*{box-sizing:border-box;font:14px/1.4 system-ui,sans-serif}html,body{margin:0;height:100%;overflow:hidden;background:#000;cursor:crosshair;user-select:none}
img{position:fixed;inset:0;width:100vw;height:100vh;object-fit:fill;pointer-events:none}
.box{position:fixed;border:3px solid #e5383b;border-radius:4px;pointer-events:none}.box.point{width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%}
.box span{position:absolute;left:-3px;top:-24px;background:#e5383b;color:#fff;padding:0 6px;border-radius:4px;font-weight:600}
.bar{position:fixed;left:50%;top:14px;transform:translateX(-50%);display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;max-width:calc(100vw - 32px);
background:#fff;color:#1f1f1f;border:1px solid #d0d0d0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);cursor:default}
button{padding:5px 10px;border:1px solid #c8c8c8;border-radius:6px;background:#f6f6f6;color:#1f1f1f;cursor:pointer;white-space:nowrap}
button[aria-pressed=true]{background:#e8ecff;border-color:#4d6bfe}button.primary{background:#1f1f1f;color:#fff;border-color:#1f1f1f}
input{width:260px;max-width:40vw;padding:5px 8px;border:1px solid #c8c8c8;border-radius:6px}.hint{color:#666;font-size:12px}
</style></head><body><img src="/shot.png" alt=""><div class="marks"></div><div class="draft box" hidden></div>
<div class="bar"><button data-shape="box"></button><button data-shape="arrow"></button><button data-shape="point"></button>
<input class="note"><button class="primary send"></button><button class="discuss"></button><button class="cancel"></button><span class="hint"></span></div>
<script>
(() => {
  const W = @W@, H = @H@
  const zh = (navigator.language || '').toLowerCase().startsWith('zh')
  const T = zh
    ? { box: '框选', arrow: '箭头', point: '点选', note: '下一个标注的附言（可选）', send: '发送并继续', discuss: '先问 agent', cancel: '取消', hint: '在画面上拖动标注 · Esc 取消' }
    : { box: 'Box', arrow: 'Arrow', point: 'Point', note: 'Note for the next mark (optional)', send: 'Send and continue', discuss: 'Ask the agent first', cancel: 'Cancel', hint: 'Drag on the screen to mark · Esc cancels' }
  const $ = (s) => document.querySelector(s)
  const note = $('.note'), draft = $('.draft'), list = $('.marks'), bar = $('.bar')
  note.placeholder = T.note; $('.send').textContent = T.send; $('.discuss').textContent = T.discuss; $('.cancel').textContent = T.cancel; $('.hint').textContent = T.hint
  let shape = 'box', start = null, done = false
  const marks = []
  const shapes = [...document.querySelectorAll('[data-shape]')]
  const pick = (s) => { shape = s; shapes.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.shape === s))) }
  shapes.forEach((b) => { b.textContent = T[b.dataset.shape]; b.addEventListener('click', () => pick(b.dataset.shape)) })
  pick('box')
  const sx = () => W / innerWidth, sy = () => H / innerHeight
  const place = (el, r) => { el.style.left = Math.min(r.x, r.x + r.width) + 'px'; el.style.top = Math.min(r.y, r.y + r.height) + 'px'; el.style.width = Math.abs(r.width) + 'px'; el.style.height = Math.abs(r.height) + 'px' }
  const render = () => {
    list.textContent = ''
    marks.forEach((m, i) => {
      const el = document.createElement('div')
      const r = { x: m.rect.x / sx(), y: m.rect.y / sy(), width: m.rect.width / sx(), height: m.rect.height / sy() }
      el.className = 'box' + (m.shape === 'point' ? ' point' : '')
      if (m.shape === 'box') place(el, r); else { el.style.left = (r.x + r.width) + 'px'; el.style.top = (r.y + r.height) + 'px'; el.classList.add('point') }
      const label = document.createElement('span'); label.textContent = String(i + 1); el.appendChild(label)
      list.appendChild(el)
    })
    $('.send').disabled = $('.discuss').disabled = marks.length === 0
  }
  const finish = (action) => { if (done) return; done = true; window.${SCREEN_MARKER_BINDING}(JSON.stringify({ action, marks: action === 'cancel' ? [] : marks })) }
  $('.send').addEventListener('click', () => finish('send'))
  $('.discuss').addEventListener('click', () => finish('discuss'))
  $('.cancel').addEventListener('click', () => finish('cancel'))
  addEventListener('keydown', (e) => { if (e.key === 'Escape') finish('cancel') })
  addEventListener('pointerdown', (e) => {
    if (bar.contains(e.target)) return
    start = { x: e.clientX, y: e.clientY }; draft.hidden = false; place(draft, { ...start, width: 0, height: 0 })
  })
  addEventListener('pointermove', (e) => { if (start) place(draft, { x: start.x, y: start.y, width: e.clientX - start.x, height: e.clientY - start.y }) })
  addEventListener('pointerup', (e) => {
    if (!start) return
    const r = { x: start.x, y: start.y, width: e.clientX - start.x, height: e.clientY - start.y }
    start = null; draft.hidden = true
    const tiny = Math.hypot(r.width, r.height) < 6
    const kind = tiny ? 'point' : shape
    const local = kind === 'point' ? { x: r.x, y: r.y, width: 0, height: 0 }
      : kind === 'box' ? { x: Math.min(r.x, r.x + r.width), y: Math.min(r.y, r.y + r.height), width: Math.abs(r.width), height: Math.abs(r.height) } : r
    const rect = { x: local.x * sx(), y: local.y * sy(), width: local.width * sx(), height: local.height * sy() }
    const text = note.value.trim()
    marks.push(text === '' ? { shape: kind, rect } : { shape: kind, rect, note: text })
    note.value = ''
    render()
  })
  render()
})()
</script></body></html>`

/**
 * Show a frozen screenshot full screen and collect the user's marks.
 * @param shot - the screenshot to mark.
 * @param options - which browser shows it.
 * @param signal - closes the window and resolves as cancelled when aborted.
 * @param onReady - called with the page once it is shown; tests drive it through this.
 * @returns the chosen action and the marks in screen points.
 */
export async function markOnScreen(
  shot: DesktopShot,
  options: ScreenMarkerOptions,
  signal: AbortSignal,
  onReady?: (page: Page) => void,
): Promise<ScreenMarkResult> {
  const browser = await chromium.launch({
    headless: options.headless,
    ...options.executablePath === undefined ? {} : { executablePath: options.executablePath },
    ...options.channel === undefined ? {} : { channel: options.channel },
    args: ['--start-fullscreen', '--kiosk', '--no-first-run', '--no-default-browser-check'],
  })
  try {
    const context = await browser.newContext({ viewport: options.headless ? { width: shot.width, height: shot.height } : null })
    const page = await context.newPage()
    const html = SCREEN_MARKER_PAGE.replace('@W@', String(shot.width)).replace('@H@', String(shot.height))
    await page.route(`${SCREEN_MARKER_ORIGIN}/**`, route => route.fulfill(new URL(route.request().url()).pathname === '/shot.png'
      ? { status: 200, contentType: 'image/png', body: shot.png }
      : { status: 200, contentType: 'text/html; charset=utf-8', body: html }))
    const { promise, resolve } = Promise.withResolvers<ScreenMarkResult>()
    await page.exposeBinding(SCREEN_MARKER_BINDING, (_source, json: string) => { resolve(parseScreenMarks(json)) })
    const cancel = (): void => { resolve({ action: 'cancel', marks: [] }) }
    signal.addEventListener('abort', cancel, { once: true })
    page.on('close', cancel)
    browser.on('disconnected', cancel)
    try {
      await page.goto(`${SCREEN_MARKER_ORIGIN}/`)
      if (!options.headless) await fullScreen(page)
      await page.bringToFront()
      onReady?.(page)
      return await promise
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  } finally {
    await browser.close()
  }
}

/** Put the page's window into full-screen mode; launch flags alone are ignored under some window managers. */
async function fullScreen(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } })
  } finally {
    await cdp.detach()
  }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Validate the marker page's result.
 * @param json - the page's JSON message.
 * @returns the action and the well-formed marks; malformed input counts as cancelled.
 */
export function parseScreenMarks(json: string): ScreenMarkResult {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    // The marker page is ours; unparsable output means it failed, so nothing is sent.
    void error
    return { action: 'cancel', marks: [] }
  }
  if (typeof value !== 'object' || value === null) return { action: 'cancel', marks: [] }
  const { action, marks } = value as { action?: unknown; marks?: unknown }
  if (action !== 'send' && action !== 'discuss') return { action: 'cancel', marks: [] }
  const parsed: MarkInput[] = []
  for (const m of Array.isArray(marks) ? marks : []) {
    const { shape, rect, note } = m as { shape?: unknown; rect?: Record<string, unknown>; note?: unknown }
    if (shape !== 'box' && shape !== 'arrow' && shape !== 'point') continue
    const [x, y, width, height] = [rect?.x, rect?.y, rect?.width, rect?.height]
    if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) continue
    parsed.push({ shape, rect: { x, y, width, height }, ...typeof note === 'string' && note !== '' ? { note: note.slice(0, 500) } : {} })
  }
  return { action: parsed.length === 0 ? 'cancel' : action, marks: parsed }
}
