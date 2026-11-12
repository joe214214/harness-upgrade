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
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { chromium } from 'playwright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import CoCanvas, { REWOUND, SIDE_SYSTEM, SharedBrowser, describeTarget, marksMessage } from '../src/index.ts'
import type { CanvasFrame, CanvasMark, CanvasState } from '../src/types.ts'
import type { Page } from 'playwright-core'

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
  id: 'm1', surface: 'browser', shape: 'box', rect: { x: 10, y: 20, width: 100, height: 30 }, url: 'https://shop.test/', title: 'Shop', at: 0, ...over,
})

describe('model-facing text', () => {
  it('describes a desktop mark by the window under it, in window and screen coordinates', () => {
    const window = { app: 'Notepad', title: 'notes.txt - Notepad', pid: 42, windowId: '7', bounds: { x: 100, y: 50, width: 800, height: 600 } }
    const text = marksMessage([mark({ surface: 'desktop', url: '', title: window.title, window, note: 'this line' })], undefined, 10)
    expect(text).toContain('The user marked the desktop (coordinates in screen points)')
    expect(text).toContain('1. box at (10, 20), 100×30 on the desktop (screen points): window "notes.txt - Notepad" of Notepad (pid 42, window_id 7), at (-40, -15) inside it — note: "this line"')
  })


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
    expect(text).toContain('operated the browser or desktop themselves')
    expect(text).toContain('(1 older marks omitted)')
    expect(text).toContain('2. point at (10, 20)')
  })
})

/**
 * Centre of an element inside the toolbar's closed shadow root, found through CDP, which pierces shadow roots.
 * Tests then click it with the real mouse, as a user would.
 */
async function toolbarPoint(page: Page, className: string): Promise<{ x: number; y: number }> {
  const cdp = await page.context().newCDPSession(page)
  try {
    interface DomNode { nodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] }
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: DomNode }
    const find = (node: DomNode): DomNode | undefined => {
      const attrs = node.attributes ?? []
      const cls = attrs[attrs.indexOf('class') + 1] ?? ''
      if (attrs.includes('class') && cls.split(' ').includes(className)) return node
      for (const child of [...node.shadowRoots ?? [], ...node.children ?? []]) {
        const hit = find(child)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    const node = find(root)
    if (node === undefined) throw new Error(`toolbar element .${className} not found`)
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId })
    const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content
    return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 }
  } finally {
    await cdp.detach()
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

describe.skipIf(executablePath === undefined)('shared browser', () => {

  async function setup(llm?: object) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-co-canvas-'))
    const ctx = new Context()
    // One hook, in order: the browser must be gone before its profile directory is removed.
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
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
    ctx.tools.register(plain('cua_driver_native__click', () => { clicks.push(Date.now()) }))
    ctx.tools.register(plain('read', () => {}))
    if (llm !== undefined) ctx.provide('llm', llm)
    await ctx.plugin(CoCanvas, {
      executablePath, userDataDir: dir, dataDir: join(dir, 'data'), debugPort: await freePort(), viewportWidth: 600, viewportHeight: 400, timelineSettleMs: 0,
    })
    const canvas = ctx.get('coCanvas')!
    await canvas.browser.page!.setContent(`<div><button>Save</button></div>
      <div style="margin-top:40px"><button id=a>Submit</button></div><div style="margin-top:40px"><button>Submit</button></div>`)
    let n = 0
    const call = (name: string, args: Record<string, unknown> = {}, agent?: Agent) => executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId(`c${++n}`), name, arguments: args, ...agent === undefined ? {} : { agent },
    })
    return { ctx, canvas, clicks, call }
  }
  /** An agent that records the messages steered to it, registered in a scope of its own. */
  function steeredAgent(ctx: Context, name = 'sess-co-canvas'): { agent: Agent; steered: UserMessage[]; sent: UserMessage[] } {
    const steered: UserMessage[] = []
    const sent: UserMessage[] = []
    const id = SessionId(name)
    const agent = {
      id, ctx: ctx.plugin(() => {}).ctx, status: 'idle',
      steer: (message: UserMessage) => { steered.push(message) },
      send: (message: UserMessage, _when: string, wake: boolean) => { if (!wake) sent.push(message) },
    } as unknown as Agent
    return { agent, steered, sent }
  }
  /** A model service whose one model answers with a fixed text, streamed in two pieces. */
  function scriptedLlm(reply: (system: string, prompt: string) => string, calls: string[] = []) {
    const info = { provider: 'fast', id: 'deepseek-flash', name: 'Flash', inputModalities: ['text' as const] }
    return {
      calls,
      listProviders: () => [{ id: 'fast', name: 'Fast' }],
      listModels: () => Promise.resolve([info]),
      resolveModelInfo: () => Promise.resolve(info),
      prepareCall: () => Promise.resolve({
        config: { provider: 'fast', model: 'deepseek-flash' },
        async* stream(options: { system?: string; messages: readonly UserMessage[] }) {
          const prompt = options.messages.flatMap(m => m.content).map(b => (b.type === 'text' ? b.text : '')).join('')
          calls.push(prompt)
          const text = reply(options.system ?? '', prompt)
          yield { type: 'text-delta', index: 0, text: text.slice(0, 4) }
          await new Promise(resolve => setTimeout(resolve, 20))
          yield { type: 'text-delta', index: 0, text: text.slice(4) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    }
  }
  const settled = async (canvas: CoCanvas, done: (state: CanvasState) => boolean): Promise<CanvasState> => {
    const lifetime = new AbortController()
    try {
      for await (const state of canvas.follow(lifetime.signal)) if (done(state)) return state
    } finally {
      lifetime.abort()
    }
    throw new Error('follow ended')
  }
  const reason = (result: ToolExecutionResult): string => result.content.map(b => (b.type === 'text' ? b.text : '')).join('')
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

  it('holds browser tools while paused, then runs them and reports the pause with the result', async () => {
    const { canvas, clicks, call } = await setup()
    canvas.setControl('paused')
    const bare = call('browser_click')
    const prefixed = call('mcp__playwright-mcp__browser_navigate')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await call('read')).isError).toBe(false)
    expect(clicks).toHaveLength(0)
    canvas.setControl('agent')
    const [first, second] = await Promise.all([bare, prefixed])
    expect([first.isError, second.isError]).toEqual([false, false])
    expect(clicks).toHaveLength(2)
    expect([text(first), text(second)].join('\n')).toContain('paused you and resumed')
  }, 60_000)

  it('refuses a browser action chosen before the user operated the page', async () => {
    const { canvas, clicks, call } = await setup()
    canvas.setControl('human')
    const pending = call('browser_click')
    canvas.setControl('agent')
    const refused = await pending
    expect(refused.isError).toBe(true)
    expect(refused.content.map(b => (b.type === 'text' ? b.text : '')).join('')).toContain('operated the browser or desktop themselves')
    expect(clicks).toHaveLength(0)
  }, 60_000)

  it('fails fast with the reason when the debugging port is already taken', async () => {
    const server = createServer()
    const port = await freePort()
    await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve) })
    onTestFinished(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
    const dir = await mkdtemp(join(tmpdir(), 'dsh-co-canvas-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const started = Date.now()
    const browser = new SharedBrowser({
      userDataDir: dir, debugPort: port, headless: true, ...executablePath === undefined ? {} : { executablePath }, viewport: { width: 600, height: 400 }, startUrl: 'about:blank', frameQuality: 60, pageToolbar: false,
    })
    await expect(browser.start()).rejects.toThrow(`port ${port} is already in use`)
    expect(Date.now() - started).toBeLessThan(5000)
  }, 30_000)

  it('refuses browser tools with the launch error when the browser cannot start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-co-canvas-'))
    const ctx = new Context()
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(TypertRegistry)
    ctx.tools.register(defineTool({
      name: 'browser_click', description: 'test browser_click', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'clicked' }] },
      execute: () => Promise.resolve({}),
    }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    await ctx.plugin(CoCanvas, { executablePath: join(dir, 'missing-browser'), userDataDir: dir, debugPort: await freePort() })
    expect(error).toHaveBeenCalledWith('[co-canvas]', expect.stringContaining('could not start the browser'))
    const refused = await executeToolFixture(ctx, { signal: new AbortController().signal, callId: ToolCallId('c1'), name: 'browser_click', arguments: {} })
    expect(refused.isError).toBe(true)
    const reason = refused.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(reason).toContain('failed to start')
    expect(reason).toContain('missing-browser')
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

  it('records a mark drawn on the page itself through the toolbar', async () => {
    const { canvas, call } = await setup()
    const page = canvas.browser.page!
    await expect.poll(() => toolbarPoint(page, 'mark').then(() => true, () => false)).toBe(true)
    const note = await toolbarPoint(page, 'note')
    await page.mouse.click(note.x, note.y)
    await page.keyboard.type('this one')
    const button = await toolbarPoint(page, 'mark')
    await page.mouse.click(button.x, button.y)
    const box = (await page.locator('button').nth(2).boundingBox())!
    await page.mouse.move(box.x - 6, box.y - 6)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width + 6, box.y + box.height + 6, { steps: 5 })
    await page.mouse.up()
    const pendingCount = async (): Promise<number | undefined> => {
      const next = await canvas.follow(new AbortController().signal)[Symbol.asyncIterator]().next()
      return (next.value as CanvasState | undefined)?.pending.length
    }
    await expect.poll(pendingCount).toBe(1)
    const delivered = text(await call('read'))
    expect(delivered).toContain('button "Submit" (2nd of 2 button elements with this text)')
    expect(delivered).toContain('note: "this one"')
    // The preview drawn for the crop is gone and the toolbar is visible again.
    expect(await page.evaluate(() => document.getElementById('__dsh_co_canvas_preview'))).toBeNull()
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('dsh-co-canvas')?.style.visibility)).toBe('visible')
  }, 60_000)

  it('keeps the toolbar away from page scripts and accessibility snapshots', async () => {
    const { canvas } = await setup()
    const page = canvas.browser.page!
    await expect.poll(() => toolbarPoint(page, 'mark').then(() => true, () => false)).toBe(true)
    expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).__dshCoCanvas)).toBe('undefined')
    // A script-dispatched click is not trusted, so it cannot start a mark.
    await page.evaluate(() => { document.querySelector('dsh-co-canvas')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const snapshot = await page.locator('body').ariaSnapshot()
    expect(snapshot).toContain('Submit')
    expect(snapshot).not.toMatch(/Pause agent|Mark|Send marks/u)
  }, 60_000)

  it('injects the toolbar into pages the agent navigates or opens through its own CDP connection', async () => {
    const { canvas } = await setup()
    const agent = await chromium.connectOverCDP(canvas.browser.endpoint)
    onTestFinished(async () => { await agent.close() })
    const hasToolbar = (page: Page) => page.evaluate(() => document.querySelector('dsh-co-canvas') !== null)
    const navigated = agent.contexts()[0]!.pages()[0]!
    await navigated.goto('data:text/html,<button>Next</button>')
    await expect.poll(() => hasToolbar(navigated)).toBe(true)
    const opened = await agent.contexts()[0]!.newPage()
    await opened.goto('data:text/html,<button>Other</button>')
    await expect.poll(() => hasToolbar(opened)).toBe(true)
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

  it('holds the last frame while the agent is paused and streams again when it resumes', async () => {
    const { canvas } = await setup()
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort() })
    const stream = canvas.frames(lifetime.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ width: 600, height: 400 })
    canvas.setControl('paused')
    const next = stream.next()
    let arrived = false
    void next.then(() => { arrived = true })
    await canvas.browser.page!.setContent('<body style="background:#c00"><h1>changed while paused</h1></body>')
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(arrived).toBe(false)
    canvas.setControl('agent')
    expect((await next).value).toMatchObject({ width: 600, height: 400 })
  }, 60_000)

  it('refuses a desktop action chosen before a new mark, like a browser action', async () => {
    const { canvas, clicks, call } = await setup()
    await canvas.mark({ shape: 'point', rect: { x: 5, y: 5, width: 0, height: 0 }, note: 'not that window' })
    const refused = await call('cua_driver_native__click')
    expect(refused.isError).toBe(true)
    expect(reason(refused)).toContain('not that window')
    expect(clicks).toHaveLength(0)
  }, 60_000)

  it('answers a side question from a light model without stopping the agent, then leaves it for the agent', async () => {
    const llm = scriptedLlm(system => (system === SIDE_SYSTEM ? 'That is the Plan B submit button.' : '{"goal":"Submit plan B","progress":"on the form"}'))
    const { ctx, canvas, clicks, call } = await setup(llm)
    const { agent, sent, steered } = steeredAgent(ctx)
    await call('read', {}, agent)
    const box = (await canvas.browser.page!.locator('button').nth(2).boundingBox())!
    await canvas.mark({ shape: 'box', rect: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 } })
    const id = await canvas.ask('What does this button do?')
    const state = await settled(canvas, s => s.answers.some(a => a.id === id && a.status === 'done'))
    expect(state.answers.at(-1)).toMatchObject({ question: 'What does this button do?', answer: 'That is the Plan B submit button.', model: 'fast/deepseek-flash', marks: 1 })
    expect(state.control).toBe('agent')
    expect(state.pending).toHaveLength(0)
    expect(llm.calls.at(-1)).toContain('button "Submit" (2nd of 2 button elements with this text)')
    expect(llm.calls.at(-1)).toContain('Question: What does this button do?')
    // The asked mark is no instruction: the agent's next action runs.
    expect((await call('browser_click', {}, agent)).isError).toBe(false)
    expect(clicks).toHaveLength(1)
    expect(steered).toHaveLength(0)
    expect(sent).toHaveLength(1)
    const shared = sent[0]!.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(shared).toContain('<user_side_question>')
    expect(shared).toContain('do not answer it')
    expect(shared).toContain('Answer (fast/deepseek-flash): That is the Plan B submit button.')
  }, 60_000)

  it('pauses the agent while answering when the user asks for it, and keeps the choice', async () => {
    const llm = scriptedLlm(() => 'ok')
    const { canvas } = await setup(llm)
    await canvas.setPauseOnAsk(true)
    await canvas.ask('Is this right?')
    const state = await settled(canvas, s => s.answers.at(-1)?.status === 'done')
    expect(state).toMatchObject({ control: 'paused', pauseOnAsk: true })
  }, 60_000)

  it('reports a failed side question when no provider offers the model', async () => {
    const { canvas } = await setup()
    await canvas.ask('What is this?')
    const state = await settled(canvas, s => s.answers.at(-1)?.status === 'failed')
    expect(state.answers.at(-1)!.answer).toContain('Settings > Models')
  }, 60_000)

  it('records each browser action with the screen after it, flags actions that cannot be undone, and keeps a task brief', async () => {
    const llm = scriptedLlm(system => (system === SIDE_SYSTEM ? 'ok' : '{"goal":"Order plan B","progress":"plan chosen, about to submit"}'))
    const { ctx, canvas, call } = await setup(llm)
    const { agent } = steeredAgent(ctx)
    emitAgentEvent(ctx, agent, 'agent/inbox/inserted', { message: createUserMessage({ content: [{ type: 'text', text: 'Order plan B for me' }], source: { kind: 'user' } }) })
    await call('mcp__playwright-mcp__browser_navigate', { url: 'https://shop.test/plans' }, agent)
    await call('browser_click', { element: 'Submit order button', ref: 'e12' }, agent)
    await call('read', {}, agent)
    const state = await settled(canvas, s => s.timeline.length === 2 && s.brief?.progress !== '')
    expect(state.timeline.map(s => [s.index, s.tool, s.irreversible])).toEqual([[1, 'browser_navigate', false], [2, 'browser_click', true]])
    expect(state.timeline[1]!.action).toBe('element="Submit order button" ref="e12"')
    expect(state.brief).toMatchObject({ goal: 'Order plan B', progress: 'plan chosen, about to submit', steps: 2 })
    const frame = await canvas.stepFrame(state.timeline[0]!.id)
    expect(frame).toMatchObject({ width: 600, height: 400 })
    expect(Buffer.from(frame.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    canvas.editGoal('Order plan A instead')
    expect((await settled(canvas, () => true)).brief).toMatchObject({ goal: 'Order plan A instead', goalEdited: true })
  }, 60_000)

  it('answers about a past step from its recorded screen', async () => {
    const llm = scriptedLlm(system => (system === SIDE_SYSTEM ? 'That was the plans page.' : '{}'))
    const { ctx, canvas, call } = await setup(llm)
    const { agent } = steeredAgent(ctx)
    await call('browser_click', { element: 'Plans' }, agent)
    await call('read', {}, agent)
    const step = (await settled(canvas, s => s.timeline.length === 1)).timeline[0]!
    await canvas.ask('What page was this?', step.id, [{ shape: 'box', rect: { x: 10, y: 10, width: 50, height: 20 }, note: 'here' }])
    const state = await settled(canvas, s => s.answers.at(-1)?.status === 'done')
    expect(state.answers.at(-1)).toMatchObject({ step: 1, marks: 1, answer: 'That was the plans page.' })
    expect(llm.calls.at(-1)).toContain('The question is about step 1 of the agent\'s work, after it ran browser_click element="Plans"')
  }, 60_000)

  it('sends the agent back to a past step: its next action is refused and it gets the step, the marks, and what it did since', async () => {
    const { ctx, canvas, clicks, call } = await setup()
    const { agent, steered } = steeredAgent(ctx)
    await call('browser_click', { element: 'Plan A' }, agent)
    await call('browser_click', { element: 'Submit order' }, agent)
    await call('read', {}, agent)
    const steps = (await settled(canvas, s => s.timeline.length === 2)).timeline
    canvas.setControl('paused')
    await canvas.rewind(steps[0]!.id, [{ shape: 'point', rect: { x: 40, y: 30, width: 0, height: 0 } }], 'I wanted Plan B, not A')
    expect((await settled(canvas, () => true)).control).toBe('agent')
    const refused = await call('browser_click', {}, agent)
    expect(reason(refused)).toContain(REWOUND)
    expect((await call('browser_click', {}, agent)).isError).toBe(false)
    expect(clicks).toHaveLength(3)
    expect(steered).toHaveLength(1)
    const body = steered[0]!.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(body).toContain('<user_rewind step="1">')
    expect(body).toContain('The user says: "I wanted Plan B, not A"')
    expect(body).toContain('2. browser_click element="Submit order" (may not be undoable)')
    expect(steered[0]!.source).toMatchObject({ kind: 'dsh-co-canvas', summary: 'Back to step 1: I wanted Plan B, not A' })
  }, 60_000)

  it('keeps marks, side answers and the timeline for the top-level conversation while a subagent works the browser', async () => {
    const llm = scriptedLlm(() => 'ok')
    const { ctx, canvas, clicks, call } = await setup(llm)
    const parent = steeredAgent(ctx, 'sess-parent')
    const child = steeredAgent(ctx, 'sess-child')
    ctx.provide('agents', { roots: () => [parent.agent] })
    await call('read', {}, parent.agent)
    await canvas.mark({ shape: 'point', rect: { x: 5, y: 5, width: 0, height: 0 }, note: 'use the second form' })
    const childClick = await call('browser_click', {}, child.agent)
    expect(childClick.isError).toBe(false)
    expect(text(childClick)).toBe('')
    expect(text(await call('read', {}, child.agent))).toBe('')
    expect(clicks).toHaveLength(1)
    expect((await settled(canvas, () => true)).timeline).toHaveLength(0)
    await canvas.ask('What is this?')
    await settled(canvas, s => s.answers.at(-1)?.status === 'done')
    expect(child.sent).toHaveLength(0)
    expect(parent.sent).toHaveLength(1)
  }, 60_000)

  it('refuses to rewind before any agent has used co-canvas or to a step no longer kept', async () => {
    const { canvas } = await setup()
    await expect(canvas.rewind('gone', [], '')).rejects.toThrow('no longer kept')
  }, 60_000)
})

describe.skipIf(executablePath === undefined)('hidden tools', () => {
  it('withdraws matching global tools from every agent through the tool registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-co-canvas-'))
    const ctx = new Context()
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TypertRegistry)
    const plain = (name: string) => defineTool({
      name, description: `test ${name}`, parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: name }] },
      execute: () => Promise.resolve({}),
    })
    for (const name of ['cua_driver_native__click', 'cua_driver_native__browser_navigate', 'cua_driver_native__start_recording']) ctx.tools.register(plain(name))
    await ctx.plugin(CoCanvas, {
      executablePath, userDataDir: dir, debugPort: await freePort(), hiddenTools: '^cua_driver_native__(browser_\\w+|start_recording)$',
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('session-hidden-tools'))
    const visible = ctx.tools.schemas(agent).map(t => t.name)
    expect(visible).toContain('cua_driver_native__click')
    expect(visible).not.toContain('cua_driver_native__browser_navigate')
    expect(visible).not.toContain('cua_driver_native__start_recording')
    expect(ctx.tools.schemas().map(t => t.name)).toContain('cua_driver_native__browser_navigate')
  }, 60_000)
})
