/**
 * The desktop surface: window grounding, crops and frames over a scripted Cua
 * Driver, the full-screen marker in headless Chromium, and the real runtime
 * when a display is available.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { IGNORED_WINDOWS, SharedDesktop, actionWindow, markOnScreen, openCuaDriver, parseScreenMarks, windowAt } from '../src/index.ts'
import type { DesktopDriver, DesktopShot, DesktopToolResult } from '../src/index.ts'

function findChromium(): string | undefined {
  const own = chromium.executablePath()
  if (existsSync(own)) return own
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (root === undefined || !existsSync(root)) return undefined
  for (const dir of readdirSync(root).filter(d => d.startsWith('chromium-')).sort().reverse()) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) if (existsSync(join(root, dir, sub))) return join(root, dir, sub)
  }
  return undefined
}
const executablePath = findChromium()

/** A 200×100-pixel screen of 100×50 points (scale 2), white with a black square at points (40, 20)–(60, 30). */
async function screenPng(): Promise<Buffer> {
  const square = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#000000' } }).png().toBuffer()
  return sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } }).composite([{ input: square, left: 80, top: 40 }]).png().toBuffer()
}

function scriptedDriver(png: Buffer, windows: unknown[]): DesktopDriver & { calls: string[]; closed: boolean } {
  const result = (over: Partial<DesktopToolResult>): DesktopToolResult => ({ text: 'ok', images: [], isError: false, ...over })
  return {
    calls: [],
    closed: false,
    callTool(name) {
      this.calls.push(name)
      if (name === 'get_desktop_state') {
        return Promise.resolve(result({
          images: [{ mimeType: 'image/png', dataBase64: png.toString('base64') }],
          structuredJson: JSON.stringify({ screen_width: 100, screen_height: 50, screenshot_width: 200, screenshot_height: 100 }),
        }))
      }
      if (name === 'list_windows') return Promise.resolve(result({ structuredJson: JSON.stringify({ windows }) }))
      return Promise.resolve(result({ isError: true, text: `unexpected ${name}` }))
    },
    shutdown() { this.closed = true; return Promise.resolve() },
  }
}

const FRAMES = { frameIntervalMs: 10, frameQuality: 60, maxFrameEdge: 1600 }

const editor = { pid: 42, window_id: 7, title: 'notes.txt', app_name: 'Editor', bounds: { x: 30, y: 10, width: 60, height: 35 }, is_on_screen: true, z_index: 2 }
const behind = { pid: 9, window_id: 3, title: 'Files', app_name: 'Files', bounds: { x: 0, y: 0, width: 100, height: 50 }, is_on_screen: true, z_index: 1 }

describe('desktop surface', () => {
  it('never names an ignored overlay window as the target', () => {
    const overlay = { pid: 1, window_id: 9, title: 'NVIDIA GeForce Overlay DT', app_name: 'NVIDIA Overlay', bounds: { x: 0, y: 0, width: 1600, height: 1000 }, z_index: 99 }
    const app = { pid: 2, window_id: 3, title: '飞行网 · 机票查询', app_name: 'Chromium', bounds: { x: 800, y: 80, width: 760, height: 640 }, z_index: 5 }
    const ignored = new RegExp(IGNORED_WINDOWS, 'u')
    expect(windowAt([overlay, app], 900, 300)?.title).toBe('NVIDIA GeForce Overlay DT')
    expect(windowAt([overlay, app], 900, 300, ignored)?.title).toBe('飞行网 · 机票查询')
    expect(actionWindow([overlay, app], undefined, undefined, ignored)?.title).toBe('飞行网 · 机票查询')
  })

  it('grounds a point to the frontmost visible window containing it', () => {
    expect(windowAt([behind, editor], 50, 25)).toMatchObject({ title: 'notes.txt', app: 'Editor', pid: 42, windowId: '7' })
    expect(windowAt([behind, editor], 5, 5)).toMatchObject({ title: 'Files' })
    expect(windowAt([behind, { ...editor, minimized: true }], 50, 25)).toMatchObject({ title: 'Files' })
    expect(windowAt([editor], 5, 5)).toBeUndefined()
  })

  it('crops a mark in screenshot pixels with the mark drawn, and names its window', async () => {
    const driver = scriptedDriver(await screenPng(), [behind, editor])
    const desktop = new SharedDesktop({ ...FRAMES, openDriver: () => Promise.resolve(driver) })
    const { window, crop } = await desktop.capture('box', { x: 40, y: 20, width: 20, height: 10 }, { x: 50, y: 25 }, 5)
    expect(window).toMatchObject({ title: 'notes.txt', windowId: '7' })
    // Points (35, 15)–(65, 35) at scale 2.
    expect(await sharp(crop).metadata()).toMatchObject({ width: 60, height: 40 })
    const { data, info } = await sharp(crop).raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels
      return Array.from(data.subarray(offset, offset + 3))
    }
    expect(at(10, 1)).toEqual([255, 255, 255])
    expect(at(30, 20)).toEqual([0, 0, 0])
    const red = at(10, 10)
    expect(red[0]).toBeGreaterThan(200)
    expect(red[1]).toBeLessThan(100)
    await desktop.close()
    expect(driver.closed).toBe(true)
  })

  it('streams JPEG frames sized in screen points, scaled to the edge limit', async () => {
    const driver = scriptedDriver(await screenPng(), [])
    const desktop = new SharedDesktop({ ...FRAMES, maxFrameEdge: 400, openDriver: () => Promise.resolve(driver) })
    const controller = new AbortController()
    const frames = []
    for await (const frame of desktop.frames(controller.signal)) {
      frames.push(frame)
      if (frames.length === 2) controller.abort()
    }
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ width: 100, height: 50 })
    expect(await sharp(Buffer.from(frames[0]!.data, 'base64')).metadata()).toMatchObject({ format: 'jpeg', width: 200, height: 100 })
    await desktop.close()
  })

  it('accepts only well-formed marks from the marker page', () => {
    expect(parseScreenMarks('not json')).toEqual({ action: 'cancel', marks: [] })
    expect(parseScreenMarks(JSON.stringify({ action: 'send', marks: [] }))).toEqual({ action: 'cancel', marks: [] })
    expect(parseScreenMarks(JSON.stringify({ action: 'ask', marks: [
      { shape: 'box', rect: { x: 1, y: 2, width: 3, height: 4 }, note: 'this' },
      { shape: 'oval', rect: { x: 1, y: 2, width: 3, height: 4 } },
      { shape: 'point', rect: { x: 'a', y: 2, width: 0, height: 0 } },
    ] }))).toEqual({ action: 'ask', marks: [{ shape: 'box', rect: { x: 1, y: 2, width: 3, height: 4 }, note: 'this' }] })
  })
})

describe.skipIf(executablePath === undefined)('marking on the real screen', () => {
  it('collects boxes and points drawn on the frozen screen, in screen points, with notes', async () => {
    const png = await screenPng()
    const shot: DesktopShot = { png, pixelWidth: 200, pixelHeight: 100, width: 1600, height: 800 }
    const result = await markOnScreen(shot, { headless: true, executablePath }, AbortSignal.timeout(30_000), (page) => {
      void (async () => {
        await page.fill('.note', 'this square')
        await page.mouse.move(600, 300)
        await page.mouse.down()
        await page.mouse.move(1000, 500, { steps: 4 })
        await page.mouse.up()
        await page.mouse.click(1200, 600)
        await page.click('.ask')
      })().catch(() => {}) // the marker closes the page once the marks are sent
    })
    expect(result).toEqual({ action: 'ask', marks: [
      { shape: 'box', rect: { x: 600, y: 300, width: 400, height: 200 }, note: 'this square' },
      { shape: 'point', rect: { x: 1200, y: 600, width: 0, height: 0 } },
    ] })
  }, 60_000)

  it('reports a cancelled marking when the user presses Escape', async () => {
    const shot: DesktopShot = { png: await screenPng(), pixelWidth: 200, pixelHeight: 100, width: 800, height: 400 }
    const result = await markOnScreen(shot, { headless: true, executablePath }, AbortSignal.timeout(30_000), (page) => {
      // The marker closes the page as soon as it handles Escape, so the press itself may reject.
      page.keyboard.press('Escape').catch(() => {})
    })
    expect(result).toEqual({ action: 'cancel', marks: [] })
  }, 60_000)
})

describe.skipIf(process.platform !== 'linux' || process.env.DISPLAY === undefined)('real Cua Driver runtime', () => {
  it('captures the display and crops a mark', async () => {
    const desktop = new SharedDesktop({ ...FRAMES, openDriver: openCuaDriver })
    try {
      const shot = await desktop.screenshot()
      expect(shot.width).toBeGreaterThan(0)
      const { crop } = await desktop.capture('point', { x: 10, y: 10, width: 0, height: 0 }, { x: 10, y: 10 }, 20, shot)
      expect((await sharp(crop).metadata()).width).toBeGreaterThan(0)
    } finally {
      await desktop.close()
    }
  }, 60_000)
})
