/**
 * The shared Chromium: one persistent browser context that exposes a CDP port
 * for the agent's browser tools (Playwright MCP in attach mode) while this
 * module streams the active page, grounds marks to elements, and replays the
 * user's input.
 * @module @deepseek-ai/dsh-experimental-co-canvas/browser
 */

import { chromium } from 'playwright-core'
import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import type { CanvasFrame, CanvasInput, CanvasRect, MarkTarget } from './types.ts'

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

/** Owner of the shared browser process and its live view. */
export class SharedBrowser {
  private context: BrowserContext | undefined
  private pages: Page[] = []
  private readonly listeners = new Set<() => void>()

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
    await first.goto(this.options.startUrl)
  }

  /** Close the browser; pages opened by any client close with it. */
  async close(): Promise<void> {
    const context = this.context
    this.context = undefined
    this.pages = []
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
   * Read the active page's address and title.
   * @returns URL and title, empty without an active page.
   */
  async describe(): Promise<{ url: string; title: string }> {
    const page = this.page
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
   * Find the element at a viewport point of the active page.
   * @param x - CSS pixel x.
   * @param y - CSS pixel y.
   * @returns the element's description, or undefined when nothing is there.
   */
  async hitTest(x: number, y: number): Promise<MarkTarget | undefined> {
    const page = this.page
    if (page === undefined) return undefined
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
   * Capture a PNG of a viewport rectangle with a margin, clamped to the viewport.
   * @param rect - marked area in CSS pixels.
   * @param margin - context pixels added on every side.
   * @returns PNG bytes, or undefined without an active page.
   */
  async crop(rect: CanvasRect, margin: number): Promise<Buffer | undefined> {
    const page = this.page
    if (page === undefined) return undefined
    const { width, height } = page.viewportSize() ?? this.options.viewport
    const x = Math.max(0, Math.min(rect.x, rect.x + rect.width) - margin)
    const y = Math.max(0, Math.min(rect.y, rect.y + rect.height) - margin)
    const right = Math.min(width, Math.max(rect.x, rect.x + rect.width) + margin)
    const bottom = Math.min(height, Math.max(rect.y, rect.y + rect.height) + margin)
    return await page.screenshot({ clip: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) } })
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
    page.on('close', () => { this.pages = this.pages.filter(p => p !== page); this.changed() })
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) this.changed() })
    this.changed()
  }

  private changed(): void { for (const listener of this.listeners) listener() }
}
