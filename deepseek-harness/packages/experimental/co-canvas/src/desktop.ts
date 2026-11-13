/**
 * The desktop surface: live frames of the primary display, marks grounded to
 * the window under them, and annotated crops. Screens are read through a Cua
 * Driver runtime owned by this surface, separate from any computer-use provider.
 * @module @deepseek-ai/dsh-experimental-co-canvas/desktop
 */

import sharp from 'sharp'
import type { CanvasFrame, CanvasRect, DesktopWindow, MarkShape } from './types.ts'

/** Result of one Cua Driver tool call, as the SDK returns it. */
export interface DesktopToolResult {
  readonly text: string
  readonly images: readonly { readonly mimeType: string; readonly dataBase64: string }[]
  readonly structuredJson?: string | undefined
  readonly isError: boolean
}

/** The part of a Cua Driver runtime the desktop surface uses. */
export interface DesktopDriver {
  callTool(name: string, argumentsJson: string): Promise<DesktopToolResult>
  shutdown(): Promise<void>
}

/** Settings of the desktop surface. */
export interface SharedDesktopOptions {
  /** Pause between live frames. */
  readonly frameIntervalMs: number
  /** JPEG quality of live frames. */
  readonly frameQuality: number
  /** Longest frame edge sent to the live view; larger screens are scaled down. */
  readonly maxFrameEdge: number
  /** Opens the runtime on first use. */
  readonly openDriver: () => Promise<DesktopDriver>
}

/** One screenshot with the screen size it depicts. */
export interface DesktopShot {
  /** PNG bytes in screenshot pixels. */
  readonly png: Buffer
  /** Screenshot size in pixels. */
  readonly pixelWidth: number
  readonly pixelHeight: number
  /** Screen size in the points that desktop input uses. */
  readonly width: number
  readonly height: number
}

/** A grounded desktop mark: the window under its focus point and the annotated crop. */
export interface DesktopCapture {
  readonly window?: DesktopWindow
  readonly crop?: Buffer
}

/** Screen fields of a `get_desktop_state` result. */
interface ScreenInfo {
  readonly screen_width?: number
  readonly screen_height?: number
  readonly screenshot_width?: number
  readonly screenshot_height?: number
}

interface WindowRecord {
  readonly pid?: number
  readonly window_id?: number | string
  readonly title?: string
  readonly app_name?: string
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly is_on_screen?: boolean
  readonly minimized?: boolean
  readonly z_index?: number | null
}

/**
 * Open the Cua Driver runtime bundled with this package.
 * @returns a same-process runtime; callers shut it down.
 */
export async function openCuaDriver(): Promise<DesktopDriver> {
  const { CuaDriver } = await import('@trycua/cua-driver')
  return CuaDriver.create(undefined)
}

/**
 * Pick the frontmost visible window containing a point.
 * @param windows - `list_windows` records.
 * @param x - screen x in points.
 * @param y - screen y in points.
 * @returns the window, or undefined when none contains the point.
 */
export function windowAt(windows: readonly WindowRecord[], x: number, y: number): DesktopWindow | undefined {
  let best: { record: WindowRecord; bounds: CanvasRect; z: number } | undefined
  for (const record of windows) {
    const b = record.bounds
    if (b === undefined || record.minimized === true || record.is_on_screen === false) continue
    if (x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) continue
    // A null z-index means stacking order is unknown; such windows lose to any ranked one.
    const z = typeof record.z_index === 'number' ? record.z_index : Number.NEGATIVE_INFINITY
    if (best === undefined || z > best.z) best = { record, bounds: b, z }
  }
  if (best === undefined) return undefined
  const { record, bounds: b } = best
  return {
    app: record.app_name ?? '',
    title: record.title ?? '',
    ...record.pid === undefined ? {} : { pid: record.pid },
    ...record.window_id === undefined ? {} : { windowId: String(record.window_id) },
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
  }
}

/**
 * The window an action was aimed at, or else the frontmost visible window.
 * @param windows - `list_windows` records.
 * @param pid - process the action named, when it named one.
 * @param windowId - window the action named, when it named one.
 * @returns the window, or undefined when none is visible.
 */
export function actionWindow(windows: readonly WindowRecord[], pid?: number, windowId?: string): DesktopWindow | undefined {
  const visible = windows.filter(r => r.bounds !== undefined && r.minimized !== true && r.is_on_screen !== false)
  const z = (r: WindowRecord): number => (typeof r.z_index === 'number' ? r.z_index : Number.NEGATIVE_INFINITY)
  const named = windowId === undefined ? undefined : visible.find(r => String(r.window_id) === windowId)
  const ofPid = pid === undefined ? [] : visible.filter(r => r.pid === pid)
  const front = (list: WindowRecord[]): WindowRecord | undefined =>
    list.reduce<WindowRecord | undefined>((a, r) => (a === undefined || z(r) > z(a) ? r : a), undefined)
  const record = named ?? front(ofPid) ?? front(visible)
  if (record?.bounds === undefined) return undefined
  const b = record.bounds
  return {
    app: record.app_name ?? '',
    title: record.title ?? '',
    ...record.pid === undefined ? {} : { pid: record.pid },
    ...record.window_id === undefined ? {} : { windowId: String(record.window_id) },
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
  }
}

/**
 * SVG drawing one mark in red over a crop.
 * @param shape - mark kind.
 * @param rect - mark rectangle in crop pixels.
 * @param width - crop width.
 * @param height - crop height.
 * @returns SVG source.
 */
export function markSvg(shape: MarkShape, rect: CanvasRect, width: number, height: number): string {
  const stroke = 'stroke="#e5383b" stroke-width="4" fill="none"'
  const body = shape === 'point'
    ? `<circle cx="${rect.x}" cy="${rect.y}" r="14" ${stroke}/>`
    : shape === 'arrow'
      ? `<line x1="${rect.x}" y1="${rect.y}" x2="${rect.x + rect.width}" y2="${rect.y + rect.height}" ${stroke}/>`
        + `<circle cx="${rect.x + rect.width}" cy="${rect.y + rect.height}" r="6" fill="#e5383b"/>`
      : `<rect x="${Math.min(rect.x, rect.x + rect.width)}" y="${Math.min(rect.y, rect.y + rect.height)}" width="${Math.abs(rect.width)}" height="${Math.abs(rect.height)}" rx="4" ${stroke}/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`
}

/** The primary display, read through a Cua Driver runtime opened on first use. */
export class SharedDesktop {
  private driver: Promise<DesktopDriver> | undefined
  private latest: DesktopShot | undefined
  private closed = false

  constructor(private readonly options: SharedDesktopOptions) {}

  private open(): Promise<DesktopDriver> {
    if (this.closed) return Promise.reject(new Error('the desktop surface is closed'))
    this.driver ??= this.options.openDriver()
    return this.driver
  }

  /**
   * Capture the primary display.
   * @returns the screenshot and the screen size in points.
   * @throws Error when the runtime refuses or returns no image.
   */
  async screenshot(): Promise<DesktopShot> {
    const driver = await this.open()
    const result = await driver.callTool('get_desktop_state', '{}')
    const image = result.images[0]
    if (result.isError || image === undefined) throw new Error(`desktop screenshot failed: ${result.text}`)
    const info = JSON.parse(result.structuredJson ?? '{}') as ScreenInfo
    const png = Buffer.from(image.dataBase64, 'base64')
    const meta = await sharp(png).metadata()
    const pixelWidth = info.screenshot_width ?? meta.width
    const pixelHeight = info.screenshot_height ?? meta.height
    const width = info.screen_width ?? pixelWidth
    const shot: DesktopShot = { png, pixelWidth, pixelHeight, width, height: info.screen_height ?? pixelHeight }
    this.latest = shot
    return shot
  }

  /**
   * Encode a screenshot as a JPEG frame scaled to the frame edge limit.
   * @param shot - the screenshot.
   * @returns the frame, sized in screen points.
   */
  async toFrame(shot: DesktopShot): Promise<CanvasFrame> {
    const scale = Math.min(1, this.options.maxFrameEdge / Math.max(shot.pixelWidth, shot.pixelHeight))
    const jpeg = await sharp(shot.png)
      .resize(Math.max(1, Math.round(shot.pixelWidth * scale)))
      .jpeg({ quality: this.options.frameQuality })
      .toBuffer()
    return { data: jpeg.toString('base64'), width: shot.width, height: shot.height }
  }

  /**
   * Capture one area of the screen, or all of it.
   * @param bounds - area in screen points; undefined captures the whole screen.
   * @returns PNG bytes.
   */
  async windowImage(bounds: CanvasRect | undefined): Promise<Buffer> {
    const shot = await this.screenshot()
    if (bounds === undefined) return shot.png
    const sx = shot.pixelWidth / shot.width
    const sy = shot.pixelHeight / shot.height
    const left = Math.max(0, Math.floor(bounds.x * sx))
    const top = Math.max(0, Math.floor(bounds.y * sy))
    const width = Math.min(shot.pixelWidth - left, Math.ceil(bounds.width * sx))
    const height = Math.min(shot.pixelHeight - top, Math.ceil(bounds.height * sy))
    if (width <= 0 || height <= 0) return shot.png
    return sharp(shot.png).extract({ left, top, width, height }).png().toBuffer()
  }

  /**
   * Find the window an action was aimed at, or else the frontmost one.
   * @param pid - process the action named.
   * @param windowId - window the action named.
   * @returns the window, or undefined when the runtime lists none.
   */
  async window(pid?: number, windowId?: string): Promise<DesktopWindow | undefined> {
    const driver = await this.open()
    const listed = await driver.callTool('list_windows', JSON.stringify({ on_screen_only: true }))
    return actionWindow((JSON.parse(listed.structuredJson ?? '{}') as { windows?: WindowRecord[] }).windows ?? [], pid, windowId)
  }

  /**
   * Stream JPEG frames of the primary display.
   * @param signal - observation lifetime.
   * @returns frames sized in screen points, one per interval while read.
   */
  async* frames(signal: AbortSignal): AsyncIterable<CanvasFrame> {
    while (!signal.aborted) {
      yield await this.toFrame(await this.screenshot())
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.options.frameIntervalMs)
        function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }

  /**
   * Ground a mark to the window under its focus point and crop it.
   * @param shape - mark kind.
   * @param rect - mark rectangle in screen points.
   * @param focus - focus point in screen points.
   * @param margin - context points around the crop; undefined skips the crop.
   * @param shot - screenshot the mark was drawn on; a fresh one is taken when omitted.
   * @returns the window and crop; a failure of either leaves it out.
   */
  async capture(
    shape: MarkShape, rect: CanvasRect, focus: { x: number; y: number }, margin: number | undefined, shot?: DesktopShot,
  ): Promise<DesktopCapture> {
    const driver = await this.open()
    let window: DesktopWindow | undefined
    try {
      const listed = await driver.callTool('list_windows', JSON.stringify({ on_screen_only: true }))
      const windows = (JSON.parse(listed.structuredJson ?? '{}') as { windows?: WindowRecord[] }).windows ?? []
      window = windowAt(windows, focus.x, focus.y)
    } catch (error) {
      // Grounding is best effort: the mark still carries its coordinates and crop.
      void error
    }
    if (margin === undefined) return window === undefined ? {} : { window }
    const source = shot ?? this.latest ?? await this.screenshot()
    const sx = source.pixelWidth / source.width
    const sy = source.pixelHeight / source.height
    const left = Math.max(0, Math.floor((Math.min(rect.x, rect.x + rect.width) - margin) * sx))
    const top = Math.max(0, Math.floor((Math.min(rect.y, rect.y + rect.height) - margin) * sy))
    const right = Math.min(source.pixelWidth, Math.ceil((Math.max(rect.x, rect.x + rect.width) + margin) * sx))
    const bottom = Math.min(source.pixelHeight, Math.ceil((Math.max(rect.y, rect.y + rect.height) + margin) * sy))
    const width = right - left
    const height = bottom - top
    if (width <= 0 || height <= 0) return window === undefined ? {} : { window }
    const local: CanvasRect = { x: rect.x * sx - left, y: rect.y * sy - top, width: rect.width * sx, height: rect.height * sy }
    const crop = await sharp(source.png)
      .extract({ left, top, width, height })
      .composite([{ input: Buffer.from(markSvg(shape, local, width, height)), top: 0, left: 0 }])
      .png()
      .toBuffer()
    return { ...window === undefined ? {} : { window }, crop }
  }

  /** Shut the runtime down, if it was opened. */
  async close(): Promise<void> {
    this.closed = true
    const driver = this.driver
    this.driver = undefined
    if (driver !== undefined) await (await driver).shutdown()
  }
}
