/**
 * Co-canvas: the user watches the agent's browser live, marks elements on it,
 * and pauses or takes control. Marks reach the agent with its next tool result,
 * grounded to the element under each mark; the agent can also ask the user to
 * mark something with `ask_user_to_mark`.
 * @module @deepseek-ai/dsh-experimental-co-canvas
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import { routeAcceptsImages } from '@deepseek-ai/dsh-media-core'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SharedBrowser } from './browser.ts'
import { marksMessage } from './marks.ts'
import type { CanvasControl, CanvasFrame, CanvasInput, CanvasMark, CanvasQuestion, CanvasState, MarkInput } from './types.ts'

export type * from './types.ts'
export { describeMark, describeTarget, marksMessage } from './marks.ts'
export { SharedBrowser } from './browser.ts'
export type { SharedBrowserOptions } from './browser.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live view, marks and control of the shared browser. */
    coCanvas: CoCanvas
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-co-canvas': { kind: 'dsh-co-canvas' } & ContextFormed
  }
}

/** Deployment settings of the shared browser and of mark delivery. */
export interface Config {
  /** CDP port the agent's browser tools attach to. */
  debugPort: number
  /** Run the browser without a window; the Web panel shows it either way. */
  headless: boolean
  /** Chromium executable; omission uses `channel` or Playwright's browser. */
  executablePath?: string | undefined
  /** Installed browser channel, e.g. `chrome` or `msedge`. */
  channel?: string | undefined
  /** Browser profile directory. */
  userDataDir: string
  /** Page opened at launch. */
  startUrl: string
  viewportWidth: number
  viewportHeight: number
  /** JPEG quality of live frames. */
  frameQuality: number
  /** Tool-name prefix of the agent's browser tools, which wait while the user holds control. */
  gatedToolPrefix: string
  /** Most marks listed in one delivery. */
  maxMarksPerMessage: number
  /** Most cropped screenshots attached to one delivery on image-capable routes; zero disables them. */
  maxCropsPerMessage: number
  /** Context pixels around a cropped mark. */
  cropMargin: number
  /** How long ask_user_to_mark waits for an answer. */
  askTimeoutMs: number
}

const optionalString = z.union([z.string().min(1), z.const(undefined)])

/** One undelivered mark with its crop, taken when it was drawn. */
interface PendingMark {
  readonly mark: CanvasMark
  readonly crop: Buffer | undefined
}

interface OpenQuestion extends CanvasQuestion {
  readonly settle: () => void
}

/** Owner of the shared browser and of the user's marks and control. */
export default class CoCanvas extends TypertRemoteService {
  static inject = ['tools', 'systemPrompt', 'typert']
  static Config: z<Partial<Config>, Config> = z.object({
    debugPort: z.natural().min(1).max(65535).default(9333),
    headless: z.boolean().default(true),
    executablePath: optionalString,
    channel: optionalString,
    userDataDir: z.string().min(1).default(join(tmpdir(), 'dsh-co-canvas-profile')),
    startUrl: z.string().min(1).default('about:blank'),
    viewportWidth: z.natural().min(320).default(1280),
    viewportHeight: z.natural().min(240).default(800),
    frameQuality: z.natural().min(10).max(100).default(60),
    gatedToolPrefix: z.string().min(1).default('browser_'),
    maxMarksPerMessage: z.natural().min(1).default(10),
    maxCropsPerMessage: z.natural().default(3),
    cropMargin: z.natural().default(40),
    askTimeoutMs: z.natural().min(1000).default(300_000),
  })

  readonly browser: SharedBrowser
  private control: CanvasControl = 'agent'
  /** Control the user held since the agent's last delivery. */
  private handback: CanvasControl | undefined
  private pending: PendingMark[] = []
  private question: OpenQuestion | undefined
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'coCanvas', { namespace: 'coCanvas' })
    this.browser = new SharedBrowser({
      userDataDir: config.userDataDir,
      debugPort: config.debugPort,
      headless: config.headless,
      ...config.executablePath === undefined ? {} : { executablePath: config.executablePath },
      ...config.channel === undefined ? {} : { channel: config.channel },
      viewport: { width: config.viewportWidth, height: config.viewportHeight },
      startUrl: config.startUrl,
      frameQuality: config.frameQuality,
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name.startsWith(config.gatedToolPrefix) && this.control !== 'agent') await this.untilAgentControl(exec.signal)
      return next()
    })
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const downstream = await next()
      const context = await this.takeDelivery(exec)
      if (context === undefined) return downstream
      return { ...downstream, additionalContexts: [...downstream.additionalContexts ?? [], context] }
    })

    ctx.systemPrompt.section({
      name: 'tool:ask_user_to_mark',
      order: ctx.systemPrompt.getSectionOrder('TOOL_ASK_USER_TO_MARK'),
      interpolate: false,
      text: ({ scope }) => ctx.tools.get('ask_user_to_mark', scope) === undefined
        ? ''
        : 'The user watches your browser live and can mark elements on it. Their marks arrive in <user_marks> after a tool result; '
          + 'they take priority over your plan. While the user holds control, your browser actions wait until it is handed back.',
    })

    ctx.tools.register(defineTool({
      name: 'ask_user_to_mark',
      description: 'Ask the user to point at something in the shared browser, and wait for their answer. '
        + 'They see your question beside the live page and answer by marking it; you get each marked element with a CSS selector. '
        + 'Use it when the target is ambiguous or you cannot find it, instead of guessing.',
      parameters: {
        question: { type: 'string', required: true, description: 'What the user should mark, e.g. "Which Submit button should I press?"' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => ({ text: await this.ask(args.question, exec.signal) }),
      presentCall(args): GenericCallView {
        return { card: 'generic', title: `Ask the user to mark: ${args.question}`, kind: 'other' }
      },
    }))
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.question?.settle()
      await this.browser.close()
    }
    await this.browser.start()
    yield this.browser.subscribe(() => { this.changed() })
  }

  /**
   * Follow the browser and collaboration state.
   * @param signal - Client observation lifetime.
   * @returns the current state, then each change.
   */
  @Remote({ mode: 'stream' })
  async* follow(signal: AbortSignal): AsyncIterable<CanvasState> {
    let wake = Promise.withResolvers<undefined>()
    const notify = (): void => { wake.resolve(undefined) }
    this.listeners.add(notify)
    signal.addEventListener('abort', notify, { once: true })
    try {
      while (!signal.aborted) {
        yield await this.state()
        await wake.promise
        wake = Promise.withResolvers<undefined>()
      }
    } finally {
      this.listeners.delete(notify)
      signal.removeEventListener('abort', notify)
    }
  }

  /**
   * Stream JPEG frames of the active page.
   * @param signal - Client observation lifetime.
   * @returns frames; slow readers receive only the newest.
   */
  @Remote({ mode: 'stream' })
  frames(signal: AbortSignal): AsyncIterable<CanvasFrame> {
    return this.browser.frames(signal)
  }

  /**
   * Record one mark, grounded to the element under its focus point.
   * @param input - shape, rectangle in page CSS pixels, optional note.
   * @returns the recorded mark.
   */
  @Remote
  async mark(input: MarkInput): Promise<CanvasMark> {
    const { x, y, width, height } = input.rect
    const focus = input.shape === 'box' ? { x: x + width / 2, y: y + height / 2 } : input.shape === 'arrow' ? { x: x + width, y: y + height } : { x, y }
    const [target, page, crop] = await Promise.all([
      this.browser.hitTest(focus.x, focus.y),
      this.browser.describe(),
      this.config.maxCropsPerMessage > 0 ? this.browser.crop(input.rect, this.config.cropMargin) : Promise.resolve(undefined),
    ])
    const mark: CanvasMark = {
      ...input, id: randomUUID(), url: page.url, title: page.title, at: Date.now(), ...target === undefined ? {} : { target },
    }
    this.pending.push({ mark, crop })
    this.changed()
    return mark
  }

  /**
   * Withdraw an undelivered mark.
   * @param id - mark id.
   */
  @Remote
  removeMark(id: string): void {
    this.pending = this.pending.filter(p => p.mark.id !== id)
    this.changed()
  }

  /**
   * Give the browser to the agent, pause it, or take it.
   * @param control - new holder.
   */
  @Remote
  setControl(control: CanvasControl): void {
    if (control === this.control) return
    if (control === 'agent') this.handback = this.control === 'human' || this.handback === 'human' ? 'human' : 'paused'
    this.control = control
    this.changed()
  }

  /**
   * Replay the user's input on the shared browser.
   * @param input - click, scroll, text, or key press.
   * @throws RemoteError unless the user holds control.
   */
  @Remote
  async input(input: CanvasInput): Promise<void> {
    if (this.control !== 'human') throw new RemoteError('co-canvas/not-in-control', 'Take control before operating the browser', { control: this.control })
    await this.browser.input(input)
  }

  /**
   * Answer the open question with the marks drawn so far.
   * @param questionId - the question being answered.
   */
  @Remote
  answer(questionId: string): void {
    if (this.question?.id === questionId) this.question.settle()
  }

  private async state(): Promise<CanvasState> {
    const page = await this.browser.describe()
    return {
      connected: this.browser.page !== undefined,
      ...page,
      control: this.control,
      question: this.question === undefined ? null : { id: this.question.id, text: this.question.text },
      pending: this.pending.map(p => p.mark),
      viewport: this.browser.viewport(),
    }
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  private untilAgentControl(signal: AbortSignal): Promise<void> {
    if (this.control === 'agent') return Promise.resolve()
    const { promise, resolve, reject } = Promise.withResolvers<undefined>()
    const check = (): void => { if (this.control === 'agent') resolve(undefined) }
    const abort = (): void => { reject(signal.reason) }
    this.listeners.add(check)
    signal.addEventListener('abort', abort, { once: true })
    return promise.finally(() => {
      this.listeners.delete(check)
      signal.removeEventListener('abort', abort)
    }).then(() => {})
  }

  private async ask(text: string, signal: AbortSignal): Promise<string> {
    if (this.question !== undefined) throw new Error('another ask_user_to_mark question is still open')
    const { promise, resolve } = Promise.withResolvers<undefined>()
    const question: OpenQuestion = { id: randomUUID(), text, settle: () => { resolve(undefined) } }
    this.question = question
    this.changed()
    const timer = setTimeout(question.settle, this.config.askTimeoutMs)
    signal.addEventListener('abort', question.settle, { once: true })
    try {
      await promise
      signal.throwIfAborted()
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', question.settle)
      this.question = undefined
      this.changed()
    }
    const marks = this.pending.splice(0).map(p => p.mark)
    this.changed()
    if (marks.length === 0) return 'The user did not mark anything. Ask in your reply, or continue with your best judgement.'
    return marksMessage(marks, undefined, this.config.maxMarksPerMessage)
  }

  private async takeDelivery(exec: ToolExecution): Promise<UserMessage | undefined> {
    if (this.pending.length === 0 && this.handback === undefined) return undefined
    const pending = this.pending.splice(0)
    const handback = this.handback
    this.handback = undefined
    this.changed()
    const content: ContentBlock[] = [{ type: 'text', text: marksMessage(pending.map(p => p.mark), handback, this.config.maxMarksPerMessage) }]
    const attachments = this.ctx.get('attachments')
    const crops = pending.filter(p => p.crop !== undefined).slice(-this.config.maxCropsPerMessage)
    if (crops.length > 0 && attachments !== undefined && await routeAcceptsImages(this.ctx, exec)) {
      for (const { mark, crop } of crops) {
        const ref = await attachments.saveImage({ data: crop as Buffer, mediaType: 'image/png', name: `mark ${mark.id.slice(0, 8)}.png` })
        content.push({ type: 'image', attachment: ref })
      }
    }
    return createUserMessage({ content, source: { kind: 'dsh-co-canvas' } })
  }
}
