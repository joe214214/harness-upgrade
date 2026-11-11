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
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import { STORED_IMAGE_SCHEMA, imageBlock, routeAcceptsImages } from '@deepseek-ai/dsh-media-core'
import type { StoredImage } from '@deepseek-ai/dsh-media-core'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SharedBrowser } from './browser.ts'
import { SharedDesktop, openCuaDriver } from './desktop.ts'
import type { DesktopShot } from './desktop.ts'
import { markOnScreen } from './screen-marker.ts'
import type { Page } from 'playwright-core'
import type { OverlayMessage, OverlayState } from './overlay.ts'
import { marksMessage } from './marks.ts'
import type { CanvasControl, CanvasFrame, CanvasInput, CanvasMark, CanvasQuestion, CanvasState, MarkInput, ScreenMarkOutcome } from './types.ts'

export type * from './types.ts'
export { DISCUSS_LINE, describeMark, describeTarget, describeWindow, marksMessage } from './marks.ts'
export { SharedDesktop, markSvg, openCuaDriver, windowAt } from './desktop.ts'
export type { DesktopCapture, DesktopDriver, DesktopShot, DesktopToolResult, SharedDesktopOptions } from './desktop.ts'
export { SCREEN_MARKER_BINDING, markOnScreen, parseScreenMarks } from './screen-marker.ts'
export type { ScreenMarkResult, ScreenMarkerOptions } from './screen-marker.ts'
export { SharedBrowser, parseToolbarMessage } from './browser.ts'
export type { Capture, SharedBrowserOptions } from './browser.ts'
export { OVERLAY_SOURCE } from './overlay.ts'
export type { OverlayMessage, OverlayState } from './overlay.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live view, marks and control of the shared browser. */
    coCanvas: CoCanvas
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * User marks and control handbacks attached to a tool result by co-canvas.
     * Readers preserve this message without the producer, which never reads the kind back.
     * @persistenceAttribution
     */
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
  /** Viewport width in CSS pixels. */
  viewportWidth: number
  /** Viewport height in CSS pixels. */
  viewportHeight: number
  /** JPEG quality of live frames. */
  frameQuality: number
  /** Inject the marking toolbar into every page, for marking directly in the browser window. */
  pageToolbar: boolean
  /** Regular expression matching the agent's browser tool names; matching calls wait while the user holds control. */
  gatedTools: string
  /** Most marks listed in one delivery. */
  maxMarksPerMessage: number
  /** Most cropped screenshots attached to one delivery on image-capable routes; zero disables them. */
  maxCropsPerMessage: number
  /** Context pixels around a cropped mark. */
  cropMargin: number
  /** How long ask_user_to_mark waits for an answer. */
  askTimeoutMs: number
  /** Offer the primary display as a second surface: live view, marks, and marking on the real screen. */
  desktop: boolean
  /** Pause between live desktop frames. */
  desktopFrameIntervalMs: number
  /** Longest edge of a live desktop frame in pixels; larger screens are scaled down. */
  desktopMaxFrameEdge: number
  /** Regular expression matching the agent's desktop action tool names; matching calls wait while the user holds control. */
  gatedDesktopTools: string
}

/** Model-facing reason for a browser or desktop action that was chosen before the user's latest input. */
export const STALE_ACTION = 'This action was not run: the user acted on the screen after you chose it. Re-plan from their input below.'

/** Start of the refusal of a browser action while the shared browser is down; the launch error follows. */
export const BROWSER_DOWN = 'The shared browser failed to start, so browser tools cannot run. Do not start a browser yourself; tell the user it failed to start and show this error:'

/** Text of a delivery that only brings the crops of marks a refusal already described. */
export const CARRIED_CROPS = '<user_marks>\nScreenshots of the marks described in your refused browser action, each with the mark drawn in red.\n</user_marks>'

/** Result of one `ask_user_to_mark` call. */
export interface AskResult {
  readonly text: string
  readonly images: StoredImage[]
}

/** Default {@link Config.gatedDesktopTools}: Cua Driver tools that change the desktop, from either provider. */
export const DESKTOP_ACTIONS = '^(cua_driver_native__|mcp__cua-driver-mcp__)(click|double_click|right_click|drag|mouse_button_down|mouse_drag|mouse_button_up'
  + '|parallel_mouse_drag|type_text|press_key|hotkey|set_value|scroll|launch_app|kill_app|bring_to_front|set_window_frame|invoke_menu|move_cursor'
  + '|clipboard_write|replay_trajectory)$'

/** Model-facing reason for a browser or desktop action refused while the user discusses marks. */
export const DISCUSS_HOLD = 'This action was not run: the user wants to discuss their marks with you first. '
  + 'Reply to them in text and do not operate the browser or the desktop until they reply.'

const optionalString = z.union([z.string().min(1), z.const(undefined)])

/** One undelivered mark with its crop, taken when it was drawn. */
interface PendingMark {
  readonly mark: CanvasMark
  readonly crop: Buffer | undefined
}

interface OpenQuestion extends CanvasQuestion {
  readonly settle: () => void
}

/**
 * The `ask_user_to_mark` tool definition.
 * @param ask - shows the question to the user and resolves with the marks as model-facing text and crops.
 * @returns the tool, ready to register.
 */
export function askUserToMarkTool(ask: (question: string, exec: ToolExecution) => Promise<AskResult>): ToolDefinition {
  return defineTool({
    name: 'ask_user_to_mark',
    description: 'Ask the user to point at something in the shared browser, and wait for their answer. '
      + 'They see your question beside the live page and answer by marking it; you get each marked element with a CSS selector. '
      + 'Use it when the target is ambiguous or you cannot find it, instead of guessing.',
    parameters: {
      question: { type: 'string', required: true, description: 'What the user should mark, e.g. "Which Submit button should I press?"' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true }, images: { type: 'array', items: { ...STORED_IMAGE_SCHEMA }, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }, ...value.images.map(image => imageBlock(image))],
    },
    execute: async (args, exec) => {
      const { text, images } = await ask(args.question, exec)
      return { text, images }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Ask the user to mark: ${args.question}`, kind: 'other' }
    },
  })
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
    pageToolbar: z.boolean().default(true),
    gatedTools: z.string().min(1).default('(^|__)browser_'),
    maxMarksPerMessage: z.natural().min(1).default(10),
    maxCropsPerMessage: z.natural().default(3),
    cropMargin: z.natural().default(120),
    askTimeoutMs: z.natural().min(1000).default(300_000),
    desktop: z.boolean().default(false),
    desktopFrameIntervalMs: z.natural().min(100).default(1000),
    desktopMaxFrameEdge: z.natural().min(320).default(1600),
    gatedDesktopTools: z.string().min(1).default(DESKTOP_ACTIONS),
  })

  /** The shared Chromium the agent's browser tools attach to. */
  readonly browser: SharedBrowser
  private control: CanvasControl = 'agent'
  /** Control the user held since the agent's last delivery. */
  private handback: CanvasControl | undefined
  private pending: PendingMark[] = []
  private question: OpenQuestion | undefined
  /** Crops of marks already described in a refusal, delivered with the next tool result. */
  private carried: PendingMark[] = []
  private readonly listeners = new Set<() => void>()
  /** Settles when the browser launch ends: undefined once it runs, else the launch error. */
  private launch: PromiseWithResolvers<string | undefined> | undefined
  private failure: string | undefined
  /** The primary display, when {@link Config.desktop} is on. */
  readonly desktop: SharedDesktop | undefined
  /** The user sent marks to discuss; gated actions are refused until the user replies or resumes. */
  private discussing = false
  /** Agent that most recently ran a tool or received a user message; discussions go to it. */
  private agent: Agent | undefined
  private screenMarking = false

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
      pageToolbar: config.pageToolbar,
    })
    this.browser.onToolbar = (page, message) => { void this.onToolbarMessage(page, message) }
    this.desktop = config.desktop
      ? new SharedDesktop({
        frameIntervalMs: config.desktopFrameIntervalMs,
        frameQuality: config.frameQuality,
        maxFrameEdge: config.desktopMaxFrameEdge,
        openDriver: openCuaDriver,
      })
      : undefined

    // MCP tools are registered as `mcp__<server>__<tool>`, so the default also matches a prefixed name.
    const gated = new RegExp(config.gatedTools, 'u')
    const gatedDesktop = new RegExp(config.gatedDesktopTools, 'u')
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent !== undefined) this.agent = exec.agent
      const browserTool = gated.test(exec.name)
      if (!browserTool && !gatedDesktop.test(exec.name)) return next()
      if (browserTool) {
        const down = await this.launchFailure(exec.signal)
        if (down !== undefined) return { kind: 'deny', reason: `${BROWSER_DOWN}\n${down}` }
      }
      if (this.control !== 'agent' && !this.discussing) await this.untilAgentControl(exec.signal)
      if (this.discussing) return { kind: 'deny', reason: DISCUSS_HOLD }
      // An action chosen before the user's latest marks, or before the user operated the screen, is not run.
      // A bare pause changes nothing on the screen, so the action runs and the handback follows its result.
      if (this.pending.length === 0 && this.handback !== 'human') return next()
      const taken = this.takePending()
      if (taken === undefined) return next()
      const marks = marksMessage(taken.pending.map(p => p.mark), taken.handback, this.config.maxMarksPerMessage)
      // A refusal carries text only; the crops follow with the next tool result.
      this.carried.push(...taken.pending.filter(p => p.crop !== undefined))
      return { kind: 'deny', reason: `${STALE_ACTION}\n${marks}` }
    })
    // The user's own reply ends a discussion: the agent may act on what they said.
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind !== 'user') return
      this.agent = agent
      if (!this.discussing) return
      this.discussing = false
      this.control = 'agent'
      this.changed()
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
        : 'The user watches your browser and desktop live and can mark things on them. Their marks arrive in <user_marks> after a tool result '
          + 'or as a message; they take priority over your plan. While the user holds control, your browser and desktop actions wait until it is handed back; '
          + 'an action chosen before the user\'s latest input is not run. When the user sends marks to discuss, answer in text before acting.',
    })

    ctx.tools.register(askUserToMarkTool((question, exec) => this.ask(question, exec)))
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.question?.settle()
      await this.desktop?.close()
      await this.browser.close()
    }
    // A failed or stalled launch must be visible on the console as well as to the agent.
    // Operator lines go to stderr with a tag, as the DeepSeek provider's do.
    const log = (message: string): void => { console.error('[co-canvas]', message) }
    const { executablePath, channel, debugPort, userDataDir } = this.config
    const launch = `${executablePath ?? channel ?? 'Playwright Chromium'}, port ${debugPort}, profile ${userDataDir}`
    const slow = setTimeout(() => { log(`the browser has not started after 30 s (${launch})`) }, 30_000)
    this.launch = Promise.withResolvers<string | undefined>()
    try {
      await this.browser.start()
      this.launch.resolve(undefined)
    } catch (error) {
      // The service stays up so its gate can refuse browser tools with this error;
      // disposing it would leave the agent's tools to fail with a bare refused connection.
      log(`could not start the browser (${launch}): ${String(error)}`)
      this.failure = `could not start ${launch}: ${String(error)}`
      this.launch.resolve(this.failure)
      this.changed()
      return
    } finally {
      clearTimeout(slow)
    }
    log(`browser ready; browser tools attach at ${this.browser.endpoint}`)
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
   * Stream JPEG frames of the primary display.
   * @param signal - Client observation lifetime.
   * @returns frames sized in screen points, one per configured interval.
   * @throws RemoteError when the desktop surface is disabled.
   */
  @Remote({ mode: 'stream' })
  desktopFrames(signal: AbortSignal): AsyncIterable<CanvasFrame> {
    return this.requireDesktop().frames(signal)
  }

  /**
   * Send the undelivered marks to the agent to discuss before it continues. The agent's
   * browser and desktop actions are refused until the user replies in the conversation or resumes.
   * @throws RemoteError when no agent has used co-canvas or received a message yet.
   */
  @Remote
  async discuss(): Promise<void> {
    // Without a tracked agent (e.g. after a restart), the most recently loaded root conversation is the one on screen.
    const agent = this.agent ?? this.ctx.get('agents')?.roots().at(-1)
    if (agent === undefined) throw new RemoteError('co-canvas/no-agent', 'Start a conversation with the agent first', {})
    const taken = this.takePending()
    if (taken === undefined || taken.pending.length === 0) return
    this.discussing = true
    if (this.control === 'agent') this.control = 'paused'
    this.changed()
    const text = marksMessage(taken.pending.map(p => p.mark), taken.handback, this.config.maxMarksPerMessage, true)
    const images = await this.saveCrops(taken.pending, agent, AbortSignal.timeout(30_000))
    const notes = taken.pending.map(p => p.mark.note).filter(note => note !== undefined && note !== '')
    const summary = boundContextSummary(`Marks to discuss (${taken.pending.length})${notes.length === 0 ? '' : `: ${notes.join('; ')}`}`)
    agent.steer(createUserMessage({ content: [{ type: 'text', text }, ...images.map(imageBlock)], source: { kind: 'dsh-co-canvas', form: 'notice', summary } }))
  }

  /**
   * Mark the real screen: after a delay, show a frozen screenshot full screen and collect marks on it.
   * @param delayMs - time to bring the screen to mark to the front.
   * @returns what the user chose and how many marks were recorded.
   * @throws RemoteError when the desktop surface is disabled.
   */
  @Remote
  async markScreen(delayMs: number): Promise<ScreenMarkOutcome> {
    const desktop = this.requireDesktop()
    if (this.screenMarking) return { action: 'cancel', marks: 0 }
    this.screenMarking = true
    try {
      await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(0, delayMs), 10_000)))
      const shot = await desktop.screenshot()
      // The marker is interactive by nature, so it always opens a window, even beside a headless shared browser.
      const result = await markOnScreen(shot, {
        headless: false,
        ...this.config.executablePath === undefined ? {} : { executablePath: this.config.executablePath },
        ...this.config.channel === undefined ? {} : { channel: this.config.channel },
      }, AbortSignal.timeout(this.config.askTimeoutMs))
      if (result.action === 'cancel') return { action: 'cancel', marks: 0 }
      for (const input of result.marks) await this.recordDesktop({ ...input, surface: 'desktop' }, shot)
      if (result.action === 'discuss') await this.discuss()
      else if (this.control === 'paused') this.setControl('agent')
      return { action: result.action, marks: result.marks.length }
    } finally {
      this.screenMarking = false
    }
  }

  /**
   * Record one mark, grounded to the element under its focus point.
   * @param input - shape, rectangle in page CSS pixels, optional note.
   * @returns the recorded mark.
   */
  @Remote
  mark(input: MarkInput): Promise<CanvasMark> {
    return input.surface === 'desktop' ? this.recordDesktop(input, undefined) : this.record(input, undefined)
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
    if (control === this.control && !(control === 'agent' && this.discussing)) return
    if (control === 'agent') {
      // Resuming after a discussion needs no handback note: the agent already answered the marks.
      if (!this.discussing) this.handback = this.control === 'human' || this.handback === 'human' ? 'human' : 'paused'
      this.discussing = false
    }
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

  private async record(input: MarkInput, page: Page | undefined): Promise<CanvasMark> {
    const margin = this.config.maxCropsPerMessage > 0 ? this.config.cropMargin : undefined
    const { target, crop } = await this.browser.capture(page, input.shape, input.rect, focusOf(input), margin)
    const where = await this.browser.describe(page)
    const mark: CanvasMark = {
      ...input, surface: 'browser', id: randomUUID(), url: where.url, title: where.title, at: Date.now(), ...target === undefined ? {} : { target },
    }
    this.pending.push({ mark, crop })
    this.changed()
    return mark
  }

  private async recordDesktop(input: MarkInput, shot: DesktopShot | undefined): Promise<CanvasMark> {
    const margin = this.config.maxCropsPerMessage > 0 ? this.config.cropMargin : undefined
    const { window, crop } = await this.requireDesktop().capture(input.shape, input.rect, focusOf(input), margin, shot)
    const mark: CanvasMark = {
      ...input, surface: 'desktop', id: randomUUID(), url: '', title: window?.title ?? '', at: Date.now(), ...window === undefined ? {} : { window },
    }
    this.pending.push({ mark, crop })
    this.changed()
    return mark
  }

  private async onToolbarMessage(page: Page, message: OverlayMessage): Promise<void> {
    switch (message.type) {
      case 'hello': this.browser.pushToolbarStateTo(page, this.toolbarState(page.url())); return
      case 'mark': await this.record({ shape: message.shape, rect: message.rect, ...message.note === '' ? {} : { note: message.note } }, page); return
      case 'control': this.setControl(message.control); return
      case 'answer': this.answer(message.questionId); return
      case 'discuss': await this.discuss(); return
    }
  }

  private toolbarState(url: string): OverlayState {
    return {
      control: this.control,
      discussing: this.discussing,
      pending: this.pending.length,
      question: this.question === undefined ? null : { id: this.question.id, text: this.question.text },
      marks: this.pending.filter(p => p.mark.surface === 'browser' && p.mark.url === url).map(p => ({ shape: p.mark.shape, rect: p.mark.rect })),
      url,
    }
  }

  private async state(): Promise<CanvasState> {
    const page = await this.browser.describe()
    return {
      connected: this.browser.page !== undefined,
      failure: this.failure ?? null,
      ...page,
      control: this.control,
      discussing: this.discussing,
      desktop: this.desktop !== undefined,
      question: this.question === undefined ? null : { id: this.question.id, text: this.question.text },
      pending: this.pending.map(p => p.mark),
      viewport: this.browser.viewport(),
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
    this.browser.pushToolbarState(url => this.toolbarState(url))
  }

  private requireDesktop(): SharedDesktop {
    if (this.desktop === undefined) throw new RemoteError('co-canvas/no-desktop', 'The desktop surface is disabled', {})
    return this.desktop
  }

  /**
   * Wait for the browser launch.
   * @param signal - The waiting tool call's abort signal.
   * @returns the launch error, or undefined when the browser runs or no launch has begun.
   */
  private launchFailure(signal: AbortSignal): Promise<string | undefined> {
    if (this.launch === undefined) return Promise.resolve(undefined)
    const { promise, reject } = Promise.withResolvers<undefined>()
    const abort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    return Promise.race([this.launch.promise, promise]).finally(() => { signal.removeEventListener('abort', abort) })
  }

  /** Wait until the agent holds control or the user starts a discussion. */
  private untilAgentControl(signal: AbortSignal): Promise<void> {
    const released = (): boolean => this.control === 'agent' || this.discussing
    if (released()) return Promise.resolve()
    const { promise, resolve, reject } = Promise.withResolvers<undefined>()
    const check = (): void => { if (released()) resolve(undefined) }
    const abort = (): void => { reject(signal.reason) }
    this.listeners.add(check)
    signal.addEventListener('abort', abort, { once: true })
    return promise.finally(() => {
      this.listeners.delete(check)
      signal.removeEventListener('abort', abort)
    }).then(() => {})
  }

  private async ask(text: string, exec: ToolExecution): Promise<AskResult> {
    const signal = exec.signal
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
    const answered = this.pending.splice(0)
    this.changed()
    if (answered.length === 0) return { text: 'The user did not mark anything. Ask in your reply, or continue with your best judgement.', images: [] }
    const marks = marksMessage(answered.map(p => p.mark), undefined, this.config.maxMarksPerMessage)
    return { text: marks, images: exec.agent === undefined ? [] : await this.saveCrops(answered, exec.agent, exec.signal) }
  }

  /** Persist the newest crops when the agent's route accepts images. */
  private async saveCrops(marks: readonly PendingMark[], agent: Agent, signal: AbortSignal): Promise<StoredImage[]> {
    const attachments = this.ctx.get('attachments')
    const crops = marks.filter(p => p.crop !== undefined).slice(-this.config.maxCropsPerMessage)
    if (crops.length === 0 || attachments === undefined || !await routeAcceptsImages(this.ctx, { agent, signal })) return []
    const saved: StoredImage[] = []
    for (const { mark, crop } of crops) {
      const ref = await attachments.saveImage({ data: crop as Buffer, mediaType: 'image/png', name: `mark ${mark.id.slice(0, 8)}.png` })
      saved.push({ attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height,
        ...ref.name === undefined ? {} : { name: ref.name } })
    }
    return saved
  }

  private takePending(): { pending: PendingMark[]; handback: CanvasControl | undefined } | undefined {
    if (this.pending.length === 0 && this.handback === undefined) return undefined
    const taken = { pending: this.pending.splice(0), handback: this.handback }
    this.handback = undefined
    this.changed()
    return taken
  }

  private async takeDelivery(exec: ToolExecution): Promise<UserMessage | undefined> {
    const taken = this.takePending()
    const carried = this.carried.splice(0)
    if (taken === undefined && carried.length === 0) return undefined
    const text = taken === undefined
      ? CARRIED_CROPS
      : marksMessage(taken.pending.map(p => p.mark), taken.handback, this.config.maxMarksPerMessage)
    const images = exec.agent === undefined ? [] : await this.saveCrops([...carried, ...taken?.pending ?? []], exec.agent, exec.signal)
    if (taken === undefined && images.length === 0) return undefined
    const content: ContentBlock[] = [{ type: 'text', text }, ...images.map(imageBlock)]
    return createUserMessage({ content, source: { kind: 'dsh-co-canvas' } })
  }
}

/** Point a mark refers to: a box's centre, an arrow's head, or the point itself. */
function focusOf(input: MarkInput): { x: number; y: number } {
  const { x, y, width, height } = input.rect
  return input.shape === 'box' ? { x: x + width / 2, y: y + height / 2 } : input.shape === 'arrow' ? { x: x + width, y: y + height } : { x, y }
}
