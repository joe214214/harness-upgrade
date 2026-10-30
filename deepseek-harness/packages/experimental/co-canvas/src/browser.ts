/**
 * The shared Chromium: one persistent browser context that exposes a CDP port
 * for the agent's browser tools (Playwright MCP in attach mode) while this
 * module streams the active page, grounds marks to elements, and replays the
 * user's input.
 * @module @deepseek-ai/dsh-experimental-co-canvas/browser
 */

import { chromium } from 'playwright-core'
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import { OVERLAY_BINDING, OVERLAY_SOURCE, OVERLAY_TAG, OVERLAY_WORLD } from './overlay.ts'
import type { OverlayMessage, OverlayState } from './overlay.ts'
import type { CanvasFrame, CanvasInput, CanvasRect, MarkShape, MarkTarget } from './types.ts'

/** Launch and streaming options, all from the plugin config. */
export interface SharedBrowserOptions {
  readonly userDataDir: string
  readonly debugPort: number
  readonly headless: boolean
  /** Explicit Chromium executable; wins over `channel`. */
  readonly executablePath?: string
  /** Installed browser channel such as `chrome` or `msedge`. */
  readonly channel?: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly startUrl: string
  readonly frameQuality: number
  /** Inject the marking toolbar into every page. */
  readonly pageToolbar: boolean
}

/** A grounded mark: the element under its focus point and a crop with the mark drawn on it. */
export interface Capture {
  readonly target?: MarkTarget
  readonly crop?: Buffer
}

/** Toolbar wiring of one page: its CDP session and the toolbar world's current context. */
interface ToolbarSession {
  readonly cdp: CDPSession
  mainFrame: string
  /** Live toolbar-world contexts of the main frame; a rewritten document can leave more than one. */
  readonly contexts: Set<number>
}

// Runs in the page with `this` bound to the hit element.
const DESCRIBE_ELEMENT = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement
  const short = s => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
  const text = short(el.innerText || el.value || '')
  const tag = el.tagName.toLowerCase()
  const implicit = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', h1: 'heading', h2: 'heading', h3: 'heading' }
  const role = el.getAttribute('role') || (tag === 'input' ? (el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox') : implicit[tag])
  const label = short(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '')
  const segment = node => {
    if (node.id) return '#' + CSS.escape(node.id)
    const same = [...node.parentElement.children].filter(c => c.tagName === node.tagName)
    const name = node.tagName.toLowerCase()
    return same.length > 1 ? name + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : name
  }
  const parts = []
  for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
    parts.unshift(segment(node))
    if (node.id) break
  }
  const peers = [...document.querySelectorAll(tag)].filter(c => short(c.innerText || c.value || '') === text)
  return { tag, text, role: role || undefined, label: label || undefined, selector: parts.join(' > '),
    nth: peers.indexOf(el) + 1, sameCount: peers.length }
}`

/** Runs in the page: hide or show the toolbar host. */
function showToolbar([tag, visible]: readonly [string, boolean]): void {
  const host = document.querySelector<HTMLElement>(tag)
  if (host !== null) host.style.visibility = visible ? 'visible' : 'hidden'
}

/** Runs in the page: draw the mark for the crop. */
function drawPreview([shape, rect]: readonly [MarkShape, CanvasRect]): void {
  const el = document.createElement('div')
  el.id = '__dsh_co_canvas_preview'
  const point = shape === 'point'
  const x = point ? rect.x - 11 : Math.min(rect.x, rect.x + rect.width)
  const y = point ? rect.y - 11 : Math.min(rect.y, rect.y + rect.height)
  el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:3px solid #e5383b;'
    + `left:${x}px;top:${y}px;width:${point ? 22 : Math.abs(rect.width)}px;height:${point ? 22 : Math.abs(rect.height)}px;`
    + `border-radius:${point ? '50%' : '4px'}`
  document.documentElement.appendChild(el)
}

/** Runs in the page: remove the mark drawn for the crop. */
function clearPreview(): void {
  document.getElementById('__dsh_co_canvas_preview')?.remove()
}

/**
 * Validate a toolbar message; the payload crosses a process boundary.
 * @param payload - JSON text from the toolbar world.
 * @returns the message, or undefined when malformed.
 */
export function parseToolbarMessage(payload: string): OverlayMessage | undefined {
  let value: unknown
  try { value = JSON.parse(payload) } catch { return undefined } // malformed JSON is ignored like any malformed message
  if (typeof value !== 'object' || value === null) return undefined
  const m = value as Record<string, unknown>
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  switch (m.type) {
    case 'hello': return { type: 'hello' }
    case 'control': return m.control === 'agent' || m.control === 'paused' ? { type: 'control', control: m.control } : undefined
    case 'answer': return typeof m.questionId === 'string' ? { type: 'answer', questionId: m.questionId } : undefined
    case 'mark': {
      const r = m.rect as Record<string, unknown> | null | undefined
      if ((m.shape !== 'box' && m.shape !== 'point') || typeof m.note !== 'string' || r == null) return undefined
      if (!num(r.x) || !num(r.y) || !num(r.width) || !num(r.height)) return undefined
      return { type: 'mark', shape: m.shape, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, note: m.note.slice(0, 500) }
    }
    default: return undefined
  }
}

/** Owner of the shared browser process and its live view. */
export class SharedBrowser {
  private context: BrowserContext | undefined
  private pages: Page[] = []
  private readonly listeners = new Set<() => void>()
  private readonly toolbars = new Map<Page, ToolbarSession>()
  private readonly installing = new Map<Page, Promise<void>>()
  /** Receives toolbar messages; set by the owning service. */
  onToolbar: ((page: Page, message: OverlayMessage) => void) | undefined

  constructor(private readonly options: SharedBrowserOptions) {}

  /** CDP endpoint the agent's browser tools attach to. */
  get endpoint(): string { return `http://127.0.0.1:${this.options.debugPort}` }

  /** Launch the browser and open the start page. */
  async start(): Promise<void> {
    const { executablePath, channel } = this.options
    const context = await chromium.launchPersistentContext(this.options.userDataDir, {
      headless: this.options.headless,
      viewport: this.options.viewport,
      args: [`--remote-debugging-port=${this.options.debugPort}`],
      ...executablePath === undefined ? channel === undefined ? {} : { channel } : { executablePath },
    })
    this.context = context
    context.on('page', (page) => { this.track(page) })
    for (const page of context.pages()) this.track(page)
    const first = this.pages.at(-1) ?? await context.newPage()
    await this.installing.get(first)
    await first.goto(this.options.startUrl)
  }

  /** Close the browser; pages opened by any client close with it. */
  async close(): Promise<void> {
    const context = this.context
    this.context = undefined
    this.pages = []
    this.toolbars.clear()
    this.installing.clear()
    await context?.close()
  }

  /**
   * Observe changes of the active page (opened, closed, navigated).
   * @param listener - invalidation callback.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The page the agent opened most recently that is still open. */
  get page(): Page | undefined { return this.pages.at(-1) }

  /**
   * Read a page's address and title.
   * @param target - the page; defaults to the active page.
   * @returns URL and title, empty without an active page.
   */
  async describe(target?: Page): Promise<{ url: string; title: string }> {
    const page = target ?? this.page
    if (page === undefined) return { url: '', title: '' }
    return { url: page.url(), title: await page.title().catch(() => '') }
  }

  /**
   * Stream JPEG frames of whichever page is active, following page switches.
   * Only the newest frame is kept when the reader is slower than the screencast.
   * @param signal - reader lifetime.
   * @returns frames until the signal aborts.
   */
  async *frames(signal: AbortSignal): AsyncIterable<CanvasFrame> {
    let latest: CanvasFrame | undefined
    let wake = Promise.withResolvers<undefined>()
    const deliver = (frame: CanvasFrame): void => { latest = frame; wake.resolve(undefined) }
    const take = (): CanvasFrame | undefined => { const frame = latest; latest = undefined; return frame }
    let session: CDPSession | undefined
    const attach = async (): Promise<void> => {
      const previous = session
      session = undefined
      await previous?.detach().catch(() => {}) // the page may already be closed
      const page = this.page
      if (page === undefined || signal.aborted) return
      const next = await page.context().newCDPSession(page)
      next.on('Page.screencastFrame', (frame) => {
        deliver({ data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight })
        next.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}) // detached mid-ack
      })
      await next.send('Page.startScreencast', { format: 'jpeg', quality: this.options.frameQuality, everyNthFrame: 1 })
      session = next
    }
    const unsubscribe = this.subscribe(() => { void attach() })
    const stop = (): void => { wake.resolve(undefined) }
    signal.addEventListener('abort', stop, { once: true })
    try {
      await attach()
      while (!signal.aborted) {
        const frame = take() ?? await wake.promise.then(take)
        wake = Promise.withResolvers<undefined>()
        if (frame !== undefined) yield frame
      }
    } finally {
      unsubscribe()
      signal.removeEventListener('abort', stop)
      await session?.detach().catch(() => {}) // the page may already be closed
    }
  }

  /**
   * Ground a mark and crop it. The toolbar is hidden meanwhile; the crop shows the page around
   * the mark, with the mark drawn on it, so a later navigation does not change what was marked.
   * @param page - page the mark was drawn on; defaults to the active page.
   * @param shape - mark kind.
   * @param rect - marked area in viewport CSS pixels.
   * @param focus - point whose element the mark refers to.
   * @param margin - context pixels around the crop, or undefined for no crop.
   * @returns the grounded element and the crop, each absent when unavailable.
   */
  async capture(
    page: Page | undefined, shape: MarkShape, rect: CanvasRect, focus: { x: number; y: number }, margin: number | undefined,
  ): Promise<Capture> {
    const target = page ?? this.page
    if (target === undefined) return {}
    await target.evaluate(showToolbar, [OVERLAY_TAG, false] as const).catch(() => {}) // the page may be navigating
    try {
      const element = await this.hitTest(target, focus.x, focus.y)
      if (margin === undefined) return element === undefined ? {} : { target: element }
      await target.evaluate(drawPreview, [shape, rect] as const)
      const { width, height } = await target.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      const x = Math.max(0, Math.min(rect.x, rect.x + rect.width) - margin)
      const y = Math.max(0, Math.min(rect.y, rect.y + rect.height) - margin)
      const right = Math.min(width, Math.max(rect.x, rect.x + rect.width) + margin)
      const bottom = Math.min(height, Math.max(rect.y, rect.y + rect.height) + margin)
      const crop = await target.screenshot({ clip: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) } })
      return { ...element === undefined ? {} : { target: element }, crop }
    } finally {
      await target.evaluate(clearPreview).catch(() => {}) // the page may be navigating
      await target.evaluate(showToolbar, [OVERLAY_TAG, true] as const).catch(() => {}) // the page may be navigating
    }
  }

  /**
   * Push state to the toolbar of every page.
   * @param stateOf - the state for one page, given its URL.
   */
  pushToolbarState(stateOf: (url: string) => OverlayState): void {
    for (const [page, toolbar] of this.toolbars) this.pushTo(page, toolbar, stateOf(page.url()))
  }

  /**
   * Push state to one page's toolbar.
   * @param page - the page.
   * @param state - toolbar state.
   */
  pushToolbarStateTo(page: Page, state: OverlayState): void {
    const toolbar = this.toolbars.get(page)
    if (toolbar !== undefined) this.pushTo(page, toolbar, state)
  }

  private pushTo(page: Page, toolbar: ToolbarSession, state: OverlayState): void {
    if (page.isClosed()) return
    for (const contextId of toolbar.contexts) {
      toolbar.cdp.send('Runtime.evaluate', {
        expression: `window.__dshCoCanvasState?.(${JSON.stringify(state)})`, contextId,
      }).catch(() => {}) // the document is being replaced; its successor greets with 'hello'
    }
  }

  private async hitTest(page: Page, x: number, y: number): Promise<MarkTarget | undefined> {
    const cdp = await page.context().newCDPSession(page)
    try {
      const { backendNodeId } = await cdp.send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y) })
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId })
      if (object.objectId === undefined) return undefined
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration: DESCRIBE_ELEMENT, returnByValue: true,
      })
      return result.value as MarkTarget
    } catch {
      return undefined // no node at that point, or the page navigated away
    } finally {
      await cdp.detach().catch(() => {}) // the page may already be closed
    }
  }

  /**
   * Install the toolbar world and its binding on one page. The binding exists only in
   * that isolated world, so the page's own scripts cannot send marks.
   */
  private async installToolbar(page: Page): Promise<void> {
    const cdp = await page.context().newCDPSession(page)
    const { frameTree } = await cdp.send('Page.getFrameTree')
    const toolbar: ToolbarSession = { cdp, mainFrame: frameTree.frame.id, contexts: new Set() }
    this.toolbars.set(page, toolbar)
    cdp.on('Runtime.executionContextCreated', ({ context }) => {
      const aux = context.auxData as { frameId?: string } | undefined
      if (context.name === OVERLAY_WORLD && aux?.frameId === toolbar.mainFrame) toolbar.contexts.add(context.id)
    })
    cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => { toolbar.contexts.delete(executionContextId) })
    cdp.on('Runtime.executionContextsCleared', () => { toolbar.contexts.clear() })
    cdp.on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
      if (name !== OVERLAY_BINDING || !toolbar.contexts.has(executionContextId)) return
      const message = parseToolbarMessage(payload)
      if (message !== undefined) this.onToolbar?.(page, message)
    })
    // Without the Page domain enabled, the script below runs only immediately, not on later navigations.
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Runtime.addBinding', { name: OVERLAY_BINDING, executionContextName: OVERLAY_WORLD })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY_SOURCE, worldName: OVERLAY_WORLD, runImmediately: true })
  }

  /**
   * Replay one user input on the active page.
   * @param input - click, scroll, typed text, or a key press.
   */
  async input(input: CanvasInput): Promise<void> {
    const page = this.page
    if (page === undefined) return
    switch (input.type) {
      case 'click': await page.mouse.click(input.x, input.y); return
      case 'scroll': await page.mouse.move(input.x, input.y); await page.mouse.wheel(0, input.deltaY); return
      case 'text': await page.keyboard.type(input.text); return
      case 'key': await page.keyboard.press(input.key); return
    }
  }

  /**
   * Read the active page's viewport size.
   * @returns CSS pixel width and height.
   */
  viewport(): { width: number; height: number } {
    return this.page?.viewportSize() ?? { ...this.options.viewport }
  }

  private track(page: Page): void {
    if (this.pages.includes(page)) return
    this.pages.push(page)
    page.on('close', () => { this.pages = this.pages.filter(p => p !== page); this.toolbars.delete(page); this.installing.delete(page); this.changed() })
    // A failed install leaves the page without a toolbar; the page closed during setup.
    if (this.options.pageToolbar) this.installing.set(page, this.installToolbar(page).catch(() => {}))
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) this.changed() })
    this.changed()
  }

  private changed(): void { for (const listener of this.listeners) listener() }
}
