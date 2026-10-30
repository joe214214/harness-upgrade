/**
 * co-canvas against a real Chromium and the real tool executor: marks are
 * grounded to elements and delivered with the next tool result, browser tools
 * wait while the user holds control, ask_user_to_mark returns the user's marks,
 * and user input is refused unless the user holds control.
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { chromium } from 'playwright-core'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import CoCanvas, { describeTarget, marksMessage } from '../src/index.ts'
import type { CanvasFrame, CanvasMark, CanvasState } from '../src/types.ts'

/** Playwright's own Chromium, or any build under PLAYWRIGHT_BROWSERS_PATH. */
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

const mark = (over: Partial<CanvasMark> = {}): CanvasMark => ({
  id: 'm1', shape: 'box', rect: { x: 10, y: 20, width: 100, height: 30 }, url: 'https://shop.test/', title: 'Shop', at: 0, ...over,
})

describe('model-facing text', () => {
  it('describes the element, its position among look-alikes, and the note', () => {
    const target = { tag: 'button', role: 'button', text: 'Submit', selector: 'div:nth-of-type(3) > button', nth: 2, sameCount: 2 }
    expect(describeTarget(target)).toBe('button "Submit" (2nd of 2 button elements with this text), selector `div:nth-of-type(3) > button`')
    const text = marksMessage([mark({ target, note: 'this one' })], undefined, 10)
    expect(text).toContain('1. box at (10, 20), 100×30 on "Shop" (https://shop.test/): button "Submit" (2nd of 2')
    expect(text).toContain('note: "this one"')
  })

  it('reports handbacks and omits marks beyond the limit', () => {
    const marks = [mark({ id: 'a' }), mark({ id: 'b' }), mark({ id: 'c', shape: 'point' })]
    const text = marksMessage(marks, 'human', 2)
    expect(text).toContain('operated the browser themselves')
    expect(text).toContain('(1 older marks omitted)')
    expect(text).toContain('2. point at (10, 20)')
  })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

describe.skipIf(executablePath === undefined)('shared browser', () => {
  let dir: string
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'dsh-co-canvas-'))
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(TypertRegistry)
    const clicks: number[] = []
    const plain = (name: string, run: () => void) => defineTool({
      name, description: `test ${name}`, parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: name }] },
      execute: () => { run(); return Promise.resolve({}) },
    })
    ctx.tools.register(plain('browser_click', () => { clicks.push(Date.now()) }))
    ctx.tools.register(plain('mcp__playwright-mcp__browser_navigate', () => { clicks.push(Date.now()) }))
    ctx.tools.register(plain('read', () => {}))
    await ctx.plugin(CoCanvas, { executablePath, userDataDir: dir, debugPort: await freePort(), viewportWidth: 600, viewportHeight: 400 })
    const canvas = ctx.get('coCanvas')!
    await canvas.browser.page!.setContent(`<div><button>Save</button></div>
      <div style="margin-top:40px"><button id=a>Submit</button></div><div style="margin-top:40px"><button>Submit</button></div>`)
    let n = 0
    const call = (name: string, args: Record<string, unknown> = {}) => executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId(`c${++n}`), name, arguments: args,
    })
    return { ctx, canvas, clicks, call }
  }
  const text = (result: ToolExecutionResult): string =>
    (result.additionalContexts ?? []).flatMap(m => m.content).map(b => (b.type === 'text' ? b.text : '')).join('\n')

  it('grounds a box to the second look-alike button and delivers it once with the next tool result', async () => {
    const { canvas, call } = await setup()
    const box = (await canvas.browser.page!.locator('button').nth(2).boundingBox())!
    const recorded = await canvas.mark({ shape: 'box', rect: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 }, note: 'press this one' })
    expect(recorded.target).toMatchObject({ tag: 'button', text: 'Submit', nth: 2, sameCount: 2 })
    const first = await call('read')
    expect(text(first)).toContain('button "Submit" (2nd of 2 button elements with this text)')
    expect(text(first)).toContain('note: "press this one"')
    expect(text(await call('read'))).toBe('')
  }, 60_000)

  it('holds browser tools while paused, then refuses the stale action with the handback', async () => {
    const { canvas, clicks, call } = await setup()
    canvas.setControl('paused')
    const bare = call('browser_click')
    const prefixed = call('mcp__playwright-mcp__browser_navigate')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await call('read')).isError).toBe(false)
    expect(clicks).toHaveLength(0)
    canvas.setControl('agent')
    const [first, second] = await Promise.all([bare, prefixed])
    expect([first.isError, second.isError].filter(Boolean)).toHaveLength(1)
    const refused = first.isError ? first : second
    const refusal = refused.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(refusal).toContain('was not run')
    expect(refusal).toContain('paused you and resumed')
    expect(clicks).toHaveLength(1)
  }, 60_000)

  it('refuses a browser action chosen before a new mark and runs the next one', async () => {
    const { canvas, clicks, call } = await setup()
    await canvas.mark({ shape: 'point', rect: { x: 5, y: 5, width: 0, height: 0 }, note: 'stop' })
    const refused = await call('browser_click')
    expect(refused.isError).toBe(true)
    expect(refused.content.map(b => (b.type === 'text' ? b.text : '')).join('')).toContain('note: "stop"')
    expect((await call('browser_click')).isError).toBe(false)
    expect(clicks).toHaveLength(1)
  }, 60_000)

  it('refuses user input unless the user holds control, then replays it', async () => {
    const { canvas } = await setup()
    await expect(canvas.input({ type: 'text', text: 'x' })).rejects.toThrow('Take control')
    const page = canvas.browser.page!
    await page.evaluate(() => { document.querySelector('#a')!.addEventListener('click', () => { document.title = 'pressed' }) })
    const box = (await page.locator('#a').boundingBox())!
    canvas.setControl('human')
    await canvas.input({ type: 'click', x: box.x + 5, y: box.y + 5 })
    await expect.poll(() => page.title()).toBe('pressed')
  }, 60_000)

  it('answers ask_user_to_mark with the marks drawn while the question is open', async () => {
    const { canvas, call } = await setup()
    const states = canvas.follow(new AbortController().signal)[Symbol.asyncIterator]()
    const answer = call('ask_user_to_mark', { question: 'Which Submit?' })
    let state: CanvasState
    do state = (await states.next()).value as CanvasState
    while (state.question === null)
    expect(state.question.text).toBe('Which Submit?')
    const box = (await canvas.browser.page!.locator('#a').boundingBox())!
    await canvas.mark({ shape: 'point', rect: { x: box.x + 5, y: box.y + 5, width: 0, height: 0 } })
    canvas.answer(state.question.id)
    const result = await answer
    expect(result.content.map(b => (b.type === 'text' ? b.text : '')).join('')).toContain('1st of 2 button elements')
  }, 60_000)

  it('streams frames and closes the browser on disposal', async () => {
    const { ctx, canvas } = await setup()
    const lifetime = new AbortController()
    const next = await canvas.frames(lifetime.signal)[Symbol.asyncIterator]().next()
    const frame = next.value as CanvasFrame | undefined
    lifetime.abort()
    expect(frame).toMatchObject({ width: 600, height: 400 })
    expect(Buffer.from(frame!.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    const endpoint = canvas.browser.endpoint
    await ctx.fiber.dispose()
    await expect(fetch(`${endpoint}/json/version`)).rejects.toThrow()
  }, 60_000)
})
