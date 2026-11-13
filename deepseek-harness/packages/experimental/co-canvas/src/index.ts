/**
 * Co-canvas: the user watches the agent's browser and desktop live, marks them,
 * and pauses or takes control. Marks reach the agent with its next tool result,
 * grounded to the element or window under each mark; the agent can also ask the
 * user to mark something with `ask_user_to_mark`. Side questions about the screen
 * are answered by a light model from a task brief, and every browser or desktop
 * action is kept on a timeline the user can go back to.
 * @module @deepseek-ai/dsh-experimental-co-canvas
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
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
import { describeMark, marksMessage } from './marks.ts'
import { BRIEF_SYSTEM, TaskBriefTracker, parseBriefSummary } from './brief.ts'
import { Timeline, describeArgs } from './timeline.ts'
import { askSide, listChoices, resolveChoice } from './sidecar.ts'
import type { SideModels } from './sidecar.ts'
import type {
  CanvasControl, CanvasFrame, CanvasInput, CanvasMark, CanvasQuestion, CanvasState, CanvasSurface, DesktopWindow, MarkInput, ModelChoice,
  ScreenMarkOutcome, SideAnswer, TimelineStep,
} from './types.ts'

export type * from './types.ts'
export { describeMark, describeTarget, describeWindow, marksMessage } from './marks.ts'
export { BRIEF_SYSTEM, TaskBriefTracker, parseBriefSummary } from './brief.ts'
export type { BriefAction, BriefSummarizer } from './brief.ts'
export { Timeline, cropFrame, describeArgs, looksIrreversible } from './timeline.ts'
export type { StepInput } from './timeline.ts'
export { SIDE_SYSTEM, askSide, listChoices, resolveChoice } from './sidecar.ts'
export type { SideModels, SideRequest } from './sidecar.ts'
export { SharedDesktop, actionWindow, markSvg, openCuaDriver, windowAt } from './desktop.ts'
export type { DesktopCapture, DesktopDriver, DesktopShot, DesktopToolResult, SharedDesktopOptions } from './desktop.ts'
export { SCREEN_MARKER_BINDING, markOnScreen, parseScreenMarks } from './screen-marker.ts'
export type { ScreenMarkResult, ScreenMarkerOptions } from './screen-marker.ts'
export { SharedBrowser, parseToolbarMessage, portInUse } from './browser.ts'
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
  /**
   * Regular expression for global tools hidden from every agent, such as the computer-use provider's
   * duplicate browser tools; empty hides nothing.
   */
  hiddenTools: string
  /**
   * Regular expression for windows never named as the target of a mark or action, matched against
   * title or application, such as invisible full-screen overlays; empty ignores none.
   */
  ignoredWindows: string
  /** Directory of the timeline's frames and of the panel's settings. */
  dataDir: string
  /** Provider of the side-question model; empty uses the first provider with credentials that offers it. */
  askProvider: string
  /** Model that answers side questions and summarizes the task brief, until the user picks another in the panel. */
  askModel: string
  /** Output token cap of one side answer. */
  askMaxTokens: number
  /** Deadline of one side answer. */
  sideTimeoutMs: number
  /** Most timeline steps kept; older frames are deleted. */
  timelineMaxSteps: number
  /** Wait after an action before its screen is recorded, so the screen has settled. */
  timelineSettleMs: number
  /** Actions between refreshes of the task brief's summary. */
  briefEverySteps: number
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

/**
 * Default {@link Config.ignoredWindows}: invisible windows that cover the screen on Windows, such as
 * the NVIDIA overlay, the desktop itself, and the input-method host.
 */
export const IGNORED_WINDOWS = '^(NVIDIA GeForce Overlay.*|Program Manager|Windows Input Experience|Microsoft Text Input Application'
  + '|Windows Shell Experience Host|Windows 输入体验|Windows Shell 体验主机)$'

/** Model-facing reason for a browser or desktop action refused because the user went back to an earlier step. */
export const REWOUND = 'This action was not run: the user went back to an earlier step of your work and marked what went wrong. '
  + 'Their message follows; re-plan from it.'

/** Settings the user changes in the panel, kept across restarts. */
interface PanelSettings {
  readonly askModel?: ModelChoice
  readonly pauseOnAsk?: boolean
}

/** Most side answers kept for the panel. */
const MAX_ANSWERS = 50

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
    hiddenTools: z.string().default(''),
    ignoredWindows: z.string().default(IGNORED_WINDOWS),
    dataDir: z.string().min(1).default(join(homedir(), '.dsh-co-canvas')),
    askProvider: z.string().default(''),
    askModel: z.string().min(1).default('deepseek-flash'),
    askMaxTokens: z.natural().min(64).default(600),
    sideTimeoutMs: z.natural().min(1000).default(60_000),
    timelineMaxSteps: z.natural().min(1).default(300),
    timelineSettleMs: z.natural().default(400),
    briefEverySteps: z.natural().min(1).default(4),
  })

  /** The shared Chromium the agent's browser tools attach to. */
  readonly browser: SharedBrowser
  private control: CanvasControl = 'agent'
  /** Control the user held since the agent's last delivery. */
  private handback: CanvasControl | undefined
  /** Marks the user sent; delivered with the agent's next tool result. */
  private pending: PendingMark[] = []
  /** Marks drawn but not yet sent or asked about; the agent never sees them. */
  private drafts: PendingMark[] = []
  /** The top-level agent's turn is running. */
  private busy = false
  /** Window of the agent's latest desktop action, for side questions about nothing in particular. */
  private lastWindow: DesktopWindow | undefined
  private question: OpenQuestion | undefined
  /** Crops of marks already described in a refusal, delivered with the next tool result. */
  private carried: PendingMark[] = []
  private readonly listeners = new Set<() => void>()
  /** Settles when the browser launch ends: undefined once it runs, else the launch error. */
  private launch: PromiseWithResolvers<string | undefined> | undefined
  private failure: string | undefined
  /** The primary display, when {@link Config.desktop} is on. */
  readonly desktop: SharedDesktop | undefined
  /** Top-level agent that most recently ran a tool or received a user message; side answers and rewinds go to it. */
  private agent: Agent | undefined
  private screenMarking = false
  /** What the agent is doing and where. */
  readonly brief: TaskBriefTracker
  /** Screens after the agent's browser and desktop actions. */
  readonly timeline: Timeline
  private answers: SideAnswer[] = []
  /** The user's choice of side-question model; undefined uses the configured one. */
  private askChoice: ModelChoice | undefined
  private pauseOnAsk = false
  /** The user went back to an earlier step: the agent's next gated action is refused once. */
  private rewound = false
  /** Recording of the latest action's screen; the next gated action waits for it. */
  private capturing: Promise<void> = Promise.resolve()

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
        ...config.ignoredWindows === '' ? {} : { ignoredWindows: new RegExp(config.ignoredWindows, 'u') },
      })
      : undefined
    this.timeline = new Timeline(join(config.dataDir, 'timeline'), config.timelineMaxSteps)
    const summarize = (input: string, signal: AbortSignal): ReturnType<CoCanvas['summarizeBrief']> => this.summarizeBrief(input, signal)
    this.brief = new TaskBriefTracker(config.briefEverySteps, summarize, () => { this.changed() })

    // MCP tools are registered as `mcp__<server>__<tool>`, so the default also matches a prefixed name.
    const gated = new RegExp(config.gatedTools, 'u')
    const gatedDesktop = new RegExp(config.gatedDesktopTools, 'u')
    ctx.on('tools/pre-execute', async (exec, next) => {
      const root = this.isRoot(exec.agent)
      if (root && exec.agent !== undefined) {
        this.agent = exec.agent
        if (!this.busy) {
          this.busy = true
          this.changed()
        }
      }
      const browserTool = gated.test(exec.name)
      if (!browserTool && !gatedDesktop.test(exec.name)) return next()
      if (browserTool) {
        const down = await this.launchFailure(exec.signal)
        if (down !== undefined) return { kind: 'deny', reason: `${BROWSER_DOWN}\n${down}` }
      }
      if (this.control !== 'agent') await this.untilAgentControl(exec.signal)
      // Marks belong to the conversation the user sees; a subagent's action waits for control but takes none of them.
      if (!root) return next()
      // The previous action's screen is recorded before this one changes it.
      await this.capturing
      if (this.rewound) {
        this.rewound = false
        return { kind: 'deny', reason: REWOUND }
      }
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
    // The user's own request becomes part of the task brief.
    // Hidden tools are withdrawn per agent through the tool registry's own restriction, so their
    // definitions leave every request; the restriction ends with the agent.
    if (config.hiddenTools !== '') {
      const hidden = new RegExp(config.hiddenTools, 'u')
      ctx.on('agent/created', ({ agent }) => {
        const deny = ctx.tools.definitions().map(d => d.name).filter(name => hidden.test(name))
        if (deny.length > 0) agent.ctx.tools.restrict({ deny })
        return undefined
      })
    }
    ctx.on('agent/turn-stopping', ({ agent }) => {
      if (!this.isRoot(agent) || !this.busy) return
      this.busy = false
      const reply = agent.session.deriveMessages().findLast(m => m.role === 'assistant')
      this.brief.settle(reply === undefined ? '' : reply.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
      this.changed()
    })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind !== 'user' || !this.isRoot(agent)) return
      this.agent = agent
      this.busy = true
      this.brief.noteRequest(message.content.map(b => (b.type === 'text' ? b.text : '')).join('\n'))
    })
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const downstream = await next()
      if (!this.isRoot(exec.agent)) return downstream
      const surface: CanvasSurface | undefined = gated.test(exec.name) ? 'browser' : gatedDesktop.test(exec.name) ? 'desktop' : undefined
      if (surface !== undefined) {
        // Recorded after the result returns, while the model thinks; the next gated action waits for it.
        this.capturing = this.capturing.then(() => this.recordStep(exec, surface)).catch((error: unknown) => {
          console.error('[co-canvas]', `could not record a timeline step: ${String(error)}`)
        })
      }
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
          + 'an action chosen before the user\'s latest input is not run. The user may go back to an earlier step and mark what went wrong (<user_rewind>). '
          + 'Questions the user asks a separate assistant about the screen arrive as <user_side_question> for your information; do not answer them.',
    })

    ctx.tools.register(askUserToMarkTool((question, exec) => this.askUser(question, exec)))
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    await this.loadSettings()
    // Resolved in the background so the panel names the model before the first question.
    this.defaultChoice().catch((error: unknown) => { console.error('[co-canvas]', `could not resolve the side-question model: ${String(error)}`) })
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
    // A key added after startup makes the default side-question model resolvable now.
    if (this.defaultResolved === undefined) {
      this.defaultChoice().catch((error: unknown) => { console.error('[co-canvas]', `could not resolve the side-question model: ${String(error)}`) })
    }
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
   * @returns frames; slow readers receive only the newest. While the agent is paused the stream
   * holds its last frame, so the user marks a still view.
   */
  @Remote({ mode: 'stream' })
  frames(signal: AbortSignal): AsyncIterable<CanvasFrame> {
    return this.holdWhilePaused(this.browser.frames(signal), signal)
  }

  /**
   * Stream JPEG frames of the primary display.
   * @param signal - Client observation lifetime.
   * @returns frames sized in screen points, one per configured interval. While the agent is paused
   * no screenshot is taken, so the last frame stays on screen and desktop marks are cropped from it.
   * @throws RemoteError when the desktop surface is disabled.
   */
  @Remote({ mode: 'stream' })
  desktopFrames(signal: AbortSignal): AsyncIterable<CanvasFrame> {
    return this.holdWhilePaused(this.requireDesktop().frames(signal), signal)
  }

  /**
   * Ask a light model about the screen without stopping the agent. On the live view the draft marks
   * are the subject, and the agent never receives them as instructions; on a timeline step, the marks
   * drawn on that step's frame are. The question and answer are then left for the agent at its next
   * step, without waking it or asking it to reply.
   * @param question - the user's question.
   * @param step - timeline step the marks were drawn on; omitted for the live view.
   * @param marks - marks on that step's frame, in its coordinates.
   * @returns the answer's id; its text arrives through `follow`.
   */
  @Remote
  async ask(question: string, step?: string, marks?: readonly MarkInput[]): Promise<string> {
    const text = question.trim() === '' ? 'What is this?' : question.trim()
    const onStep = step === undefined ? undefined : this.timeline.get(step)
    if (step !== undefined && onStep === undefined) throw new RemoteError('co-canvas/no-step', 'That step is no longer kept', { step })
    const live = onStep === undefined ? this.drafts.splice(0) : []
    const subject = onStep === undefined ? live.map(p => p.mark) : marks ?? []
    const id = randomUUID()
    const choice = this.askChoice ?? await this.defaultChoice()
    const entry: SideAnswer = {
      id, question: text, answer: '', status: 'answering', model: choice === undefined ? '' : `${choice.provider}/${choice.model}`,
      at: Date.now(), marks: subject.length, ...onStep === undefined ? {} : { step: onStep.index },
    }
    this.answers = [...this.answers, entry].slice(-MAX_ANSWERS)
    if (this.pauseOnAsk && this.control === 'agent') this.control = 'paused'
    this.changed()
    void this.answer$(entry, choice, onStep, live, marks ?? [])
    return id
  }

  /**
   * List the models that can answer side questions: every model of every provider with credentials.
   * @returns models, image-capable ones first.
   */
  @Remote
  async askModels(): Promise<ModelChoice[]> {
    const llm = this.ctx.get('llm')
    return llm === undefined ? [] : listChoices(llm, AbortSignal.timeout(30_000))
  }

  /**
   * Choose the model that answers side questions and summarizes the task brief.
   * @param choice - the model, as listed by `askModels`.
   */
  @Remote
  async setAskModel(choice: ModelChoice): Promise<void> {
    this.askChoice = choice
    this.changed()
    await this.saveSettings()
  }

  /**
   * Pause the agent while a side question is answered, or let it keep working.
   * @param on - pause while answering.
   */
  @Remote
  async setPauseOnAsk(on: boolean): Promise<void> {
    this.pauseOnAsk = on
    this.changed()
    await this.saveSettings()
  }

  /**
   * Correct the task brief's goal; an empty goal returns to following the user's requests.
   * @param goal - the goal as the user wants it understood.
   */
  @Remote
  editGoal(goal: string): void {
    this.brief.edit(goal)
  }

  /**
   * The screen after one timeline step.
   * @param step - step id.
   * @returns the frame.
   * @throws RemoteError when the step is no longer kept.
   */
  @Remote
  async stepFrame(step: string): Promise<CanvasFrame> {
    const frame = await this.timeline.frame(step)
    if (frame === undefined) throw new RemoteError('co-canvas/no-step', 'That step is no longer kept', { step })
    return frame
  }

  /**
   * Send the agent back to an earlier step: its next browser or desktop action is refused, and it
   * receives the step's screen with the user's marks, the actions it took since, and the request to
   * return to that state before continuing. The agent resumes if it was paused.
   * @param step - step id.
   * @param marks - marks on that step's frame, in its coordinates.
   * @param note - what went wrong, in the user's words.
   * @throws RemoteError when the step is gone or no agent has acted yet.
   */
  @Remote
  async rewind(step: string, marks: readonly MarkInput[], note: string): Promise<void> {
    const target = this.timeline.get(step)
    if (target === undefined) throw new RemoteError('co-canvas/no-step', 'That step is no longer kept', { step })
    const agent = this.agent ?? this.ctx.get('agents')?.roots().at(-1)
    if (agent === undefined) throw new RemoteError('co-canvas/no-agent', 'Start a conversation with the agent first', {})
    const later = this.timeline.after(step)
    const lines = [`<user_rewind step="${target.index}">`,
      `The user went back to step ${target.index} of your work, after you ran ${target.tool} ${target.action}, and marked where it went wrong.`,
      `The screen then: ${[target.app, target.window, target.url].filter(x => x !== '').join(' · ') || 'unknown'}.`]
    if (note.trim() !== '') lines.push(`The user says: "${note.trim()}"`)
    for (const [i, mark] of marks.entries()) lines.push(`Mark ${i + 1}: ${mark.shape} at (${Math.round(mark.rect.x)}, ${Math.round(mark.rect.y)}) on that screen${mark.note === undefined || mark.note === '' ? '' : `, note: "${mark.note}"`}.`)
    if (later.length > 0) {
      lines.push('What you did after that step, oldest first:')
      for (const s of later) lines.push(`${s.index}. ${s.tool} ${s.action}${s.irreversible ? ' (may not be undoable)' : ''}`)
    }
    lines.push(`Return to the state of step ${target.index} before continuing: undo or navigate back where you can${target.url === '' ? '' : ` (the page then was ${target.url})`}. `
      + 'Actions such as submitting, paying, or sending cannot be undone; if you took one, tell the user instead of repeating it.')
    lines.push('</user_rewind>')
    const crops = await this.timeline.crops(step, marks, this.config.cropMargin)
    const accepts = crops.length > 0 && this.ctx.get('attachments') !== undefined
      && await routeAcceptsImages(this.ctx, { agent, signal: AbortSignal.timeout(30_000) })
    const images: ContentBlock[] = accepts ? (await this.storeImages(crops.slice(-this.config.maxCropsPerMessage))).map(attachment => ({ type: 'image', attachment })) : []
    if (note.trim() !== '') this.brief.noteRequest(note)
    this.rewound = true
    this.handback = undefined
    if (this.control !== 'agent') this.control = 'agent'
    this.changed()
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: lines.join('\n') }, ...images],
      source: { kind: 'dsh-co-canvas', form: 'notice', summary: boundContextSummary(`Back to step ${target.index}${note.trim() === '' ? '' : `: ${note.trim()}`}`) },
    }))
  }

  /**
   * Mark the real screen: after a delay, show a frozen screenshot full screen and collect marks on it.
   * @param delayMs - time to bring the screen to mark to the front.
   * @param locale - language of the marker's toolbar, the panel's own.
   * @param defaultQuestion - question asked when the user asks without writing a note, in that language.
   * @returns what the user chose and how many marks were recorded.
   * @throws RemoteError when the desktop surface is disabled.
   */
  @Remote
  async markScreen(delayMs: number, locale?: string, defaultQuestion?: string): Promise<ScreenMarkOutcome> {
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
        ...locale === undefined ? {} : { locale },
      }, AbortSignal.timeout(this.config.askTimeoutMs))
      if (result.action === 'cancel') return { action: 'cancel', marks: 0 }
      for (const input of result.marks) await this.recordDesktop({ ...input, surface: 'desktop' }, shot)
      if (result.action === 'ask') {
        const notes = result.marks.map(m => m.note ?? '').filter(n => n !== '').join('; ')
        await this.ask(notes === '' ? defaultQuestion ?? '' : notes)
      }
      else {
        if (this.control === 'paused') this.setControl('agent')
        await this.send()
      }
      return { action: result.action, marks: result.marks.length }
    } finally {
      this.screenMarking = false
    }
  }

  /**
   * Record one mark as a draft, grounded to the element or window under its focus point. A draft
   * reaches the agent only once the user sends it; asking about it never does.
   * @param input - shape, rectangle in page CSS pixels or screen points, optional note.
   * @returns the recorded mark.
   */
  @Remote
  mark(input: MarkInput): Promise<CanvasMark> {
    return input.surface === 'desktop' ? this.recordDesktop(input, undefined) : this.record(input, undefined)
  }

  /**
   * Withdraw a draft or an undelivered mark.
   * @param id - mark id.
   */
  @Remote
  removeMark(id: string): void {
    this.drafts = this.drafts.filter(p => p.mark.id !== id)
    this.pending = this.pending.filter(p => p.mark.id !== id)
    this.changed()
  }

  /**
   * Send the draft marks to the agent as instructions. A working agent receives them with its next
   * tool result, and an action it chose before them is refused; an idle agent takes no next step, so
   * the marks start a turn instead.
   * @param note - the user's instruction, attached to the last draft.
   */
  @Remote
  async send(note?: string): Promise<void> {
    if (this.drafts.length === 0) return
    const text = note?.trim() ?? ''
    const drafts = this.drafts.splice(0)
    const last = drafts.at(-1)
    if (last !== undefined && text !== '') {
      const joined = last.mark.note === undefined || last.mark.note === '' ? text : `${last.mark.note}; ${text}`
      drafts[drafts.length - 1] = { ...last, mark: { ...last.mark, note: joined.slice(0, 500) } }
    }
    this.pending.push(...drafts)
    this.changed()
    const agent = this.busy ? undefined : this.agent ?? this.ctx.get('agents')?.roots().at(-1)
    const taken = agent === undefined ? undefined : this.takePending()
    if (agent === undefined || taken === undefined) return
    const message = marksMessage(taken.pending.map(p => p.mark), taken.handback, this.config.maxMarksPerMessage)
    const images = await this.saveCrops(taken.pending, agent, AbortSignal.timeout(30_000))
    const notes = taken.pending.map(p => p.mark.note).filter(n => n !== undefined && n !== '')
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: message }, ...images.map(imageBlock)],
      source: { kind: 'dsh-co-canvas', form: 'notice', summary: boundContextSummary(`Marks (${taken.pending.length})${notes.length === 0 ? '' : `: ${notes.join('; ')}`}`) },
    }))
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

  private async record(input: MarkInput, page: Page | undefined): Promise<CanvasMark> {
    const margin = this.config.maxCropsPerMessage > 0 ? this.config.cropMargin : undefined
    const { target, crop } = await this.browser.capture(page, input.shape, input.rect, focusOf(input), margin)
    const where = await this.browser.describe(page)
    const mark: CanvasMark = {
      ...input, surface: 'browser', id: randomUUID(), url: where.url, title: where.title, at: Date.now(), ...target === undefined ? {} : { target },
    }
    this.drafts.push({ mark, crop })
    this.changed()
    return mark
  }

  private async recordDesktop(input: MarkInput, shot: DesktopShot | undefined): Promise<CanvasMark> {
    const margin = this.config.maxCropsPerMessage > 0 ? this.config.cropMargin : undefined
    const { window, crop } = await this.requireDesktop().capture(input.shape, input.rect, focusOf(input), margin, shot)
    const mark: CanvasMark = {
      ...input, surface: 'desktop', id: randomUUID(), url: '', title: window?.title ?? '', at: Date.now(), ...window === undefined ? {} : { window },
    }
    this.drafts.push({ mark, crop })
    this.changed()
    return mark
  }

  private async onToolbarMessage(page: Page, message: OverlayMessage): Promise<void> {
    switch (message.type) {
      case 'hello': this.browser.pushToolbarStateTo(page, this.toolbarState(page.url())); return
      case 'mark': await this.record({ shape: message.shape, rect: message.rect, ...message.note === '' ? {} : { note: message.note } }, page); return
      case 'control': this.setControl(message.control); return
      case 'answer': this.answer(message.questionId); return
      case 'ask': await this.ask(message.question); return
      case 'send': await this.send(message.note); return
    }
  }

  private toolbarState(url: string): OverlayState {
    return {
      control: this.control,
      answer: this.answers.at(-1)?.answer ?? null,
      pending: this.pending.length,
      drafts: this.drafts.length,
      question: this.question === undefined ? null : { id: this.question.id, text: this.question.text },
      marks: [...this.pending, ...this.drafts].filter(p => p.mark.surface === 'browser' && p.mark.url === url).map(p => ({ shape: p.mark.shape, rect: p.mark.rect })),
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
      brief: this.brief.snapshot(),
      answers: this.answers,
      askModel: this.askChoice ?? this.defaultResolved ?? null,
      pauseOnAsk: this.pauseOnAsk,
      timeline: this.timeline.list(),
      desktop: this.desktop !== undefined,
      question: this.question === undefined ? null : { id: this.question.id, text: this.question.text },
      pending: this.pending.map(p => p.mark),
      drafts: this.drafts.map(p => p.mark),
      busy: this.busy,
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

  /** Wait until the agent holds control. */
  /**
   * Pass frames through while the agent acts or the user holds control; while paused, stop reading
   * so the viewer keeps the last frame.
   * @param frames - the live source, read lazily.
   * @param signal - the observation lifetime.
   * @returns the frames shown to the viewer.
   */
  private async* holdWhilePaused(frames: AsyncIterable<CanvasFrame>, signal: AbortSignal): AsyncIterable<CanvasFrame> {
    const source = frames[Symbol.asyncIterator]()
    try {
      for (;;) {
        if (this.control === 'paused') await this.untilLive(signal)
        if (signal.aborted) return
        const next = await source.next()
        if (next.done === true) return
        yield next.value
      }
    } finally {
      await source.return?.()
    }
  }

  private untilLive(signal: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<undefined>()
    const check = (): void => { if (this.control !== 'paused' || signal.aborted) resolve(undefined) }
    this.listeners.add(check)
    signal.addEventListener('abort', check, { once: true })
    return promise.finally(() => {
      this.listeners.delete(check)
      signal.removeEventListener('abort', check)
    }).then(() => {})
  }

  private untilAgentControl(signal: AbortSignal): Promise<void> {
    const released = (): boolean => this.control === 'agent'
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

  private async askUser(text: string, exec: ToolExecution): Promise<AskResult> {
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
    const answered = [...this.pending.splice(0), ...this.drafts.splice(0)]
    this.changed()
    if (answered.length === 0) return { text: 'The user did not mark anything. Ask in your reply, or continue with your best judgement.', images: [] }
    const marks = marksMessage(answered.map(p => p.mark), undefined, this.config.maxMarksPerMessage)
    return { text: marks, images: exec.agent === undefined ? [] : await this.saveCrops(answered, exec.agent, exec.signal) }
  }

  /** Persist the newest crops when the agent's route accepts images. */
  private async answer$(entry: SideAnswer, choice: ModelChoice | undefined, step: TimelineStep | undefined,
    live: readonly PendingMark[], stepMarks: readonly MarkInput[]): Promise<void> {
    const update = (patch: Partial<SideAnswer>): void => {
      this.answers = this.answers.map(a => (a.id === entry.id ? { ...a, ...patch } : a))
    }
    const llm = this.ctx.get('llm')
    if (llm === undefined || choice === undefined) {
      update({ status: 'failed', answer: `No model can answer: ${this.config.askModel} is not offered by any provider with an API key. Pick a model above, or add a key in Settings > Models.` })
      this.changed()
      return
    }
    const context = [this.brief.text()]
    if (step === undefined) {
      for (const [i, p] of live.entries()) context.push(`Mark ${i + 1}: ${describeMark(p.mark)}`)
      if (live.length === 0) {
        context.push(this.lastWindow === undefined || this.brief.snapshot()?.url !== ''
          ? 'The user marked nothing; the screenshot shows the whole screen.'
          : `The user marked nothing; the screenshot shows the window the agent last acted in: "${this.lastWindow.title}".`)
      }
    } else {
      context.push(`The question is about step ${step.index} of the agent's work, after it ran ${step.tool} ${step.action}; `
        + `the screen then: ${[step.app, step.window, step.url].filter(x => x !== '').join(' · ') || 'unknown'}.`)
      for (const [i, m] of stepMarks.entries()) context.push(`Mark ${i + 1}: ${m.shape}${m.note === undefined || m.note === '' ? '' : `, note: "${m.note}"`}`)
    }
    let last = 0
    try {
      const pngs = !choice.image ? [] : await this.subjectImages(step, live, stepMarks)
      const images = await this.storeImages(pngs)
      const answer = await askSide(llm, {
        choice, context: context.join('\n'), question: `Question: ${entry.question}`, images, maxTokens: this.config.askMaxTokens,
        signal: AbortSignal.timeout(this.config.sideTimeoutMs),
      }, (text) => {
        update({ answer: text })
        if (Date.now() - last > 120) {
          last = Date.now()
          this.changed()
        }
      })
      update({ answer, status: 'done' })
      this.changed()
      this.shareAnswer(entry, answer, context.slice(1))
    } catch (error) {
      update({ status: 'failed', answer: `The answer failed: ${error instanceof Error ? error.message : String(error)}` })
      this.changed()
    }
  }

  /** The marks' crops, or the whole screen when nothing was marked. */
  private async subjectImages(
    step: TimelineStep | undefined, live: readonly PendingMark[], stepMarks: readonly MarkInput[],
  ): Promise<Buffer[]> {
    const max = Math.max(1, this.config.maxCropsPerMessage)
    if (step !== undefined) {
      if (stepMarks.length > 0) return (await this.timeline.crops(step.id, stepMarks, this.config.cropMargin)).slice(-max)
      const frame = await this.timeline.frame(step.id)
      return frame === undefined ? [] : [Buffer.from(frame.data, 'base64')]
    }
    const crops = live.flatMap(p => (p.crop === undefined ? [] : [p.crop])).slice(-max)
    if (live.length > 0) return crops
    // Nothing marked: the window the agent last acted in, so the panel and the rest of the screen do not distract the answer.
    if (this.desktop !== undefined && this.brief.snapshot()?.url === '') {
      return [await this.desktop.windowImage(this.lastWindow?.bounds)]
    }
    const frame = await this.browserFrame()
    return frame === undefined ? [] : [Buffer.from(frame.data, 'base64')]
  }

  private async browserFrame(): Promise<CanvasFrame | undefined> {
    const page = this.browser.page
    if (page === undefined) return undefined
    const jpeg = await page.screenshot({ type: 'jpeg', quality: this.config.frameQuality })
    const { width, height } = this.browser.viewport()
    return { data: jpeg.toString('base64'), width, height }
  }

  /** Leave the question and answer for the agent at its next step, without waking it. */
  private shareAnswer(entry: SideAnswer, answer: string, about: readonly string[]): void {
    const agent = this.agent ?? this.ctx.get('agents')?.roots().at(-1)
    if (agent === undefined) return
    const text = [`<user_side_question${entry.step === undefined ? '' : ` step="${entry.step}"`}>`,
      'The user asked a separate assistant about the screen while you worked. This is for your information; do not answer it, '
        + 'and change your plan only if it shows you misunderstood the task.',
      `Question: ${entry.question}`, ...about, `Answer (${entry.model}): ${answer}`, '</user_side_question>'].join('\n')
    agent.send(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-co-canvas', form: 'notice', summary: boundContextSummary(`Side question: ${entry.question}`) },
    }), 'next-step', false)
  }

  private defaultResolved: ModelChoice | undefined

  /** The configured side-question model, resolved to a provider with credentials. */
  private async defaultChoice(): Promise<ModelChoice | undefined> {
    const llm = this.ctx.get('llm')
    if (this.defaultResolved !== undefined || llm === undefined) return this.defaultResolved
    this.defaultResolved = await resolveChoice(llm, this.config.askProvider, this.config.askModel, AbortSignal.timeout(30_000))
    if (this.defaultResolved !== undefined && this.askChoice === undefined) this.changed()
    return this.defaultResolved
  }

  private async summarizeBrief(input: string, signal: AbortSignal): Promise<{ goal?: string; progress?: string } | undefined> {
    const llm: SideModels | undefined = this.ctx.get('llm')
    const choice = this.askChoice ?? await this.defaultChoice()
    if (llm === undefined || choice === undefined) return undefined
    const text = await askSide(llm, { choice: { ...choice, image: false }, context: input, question: 'Write the brief.', images: [], maxTokens: 200, signal, system: BRIEF_SYSTEM }, () => {})
    return parseBriefSummary(text)
  }

  /** Record the screen after one browser or desktop action, and note the action in the brief. */
  private async recordStep(exec: ToolExecution, surface: CanvasSurface): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.config.timelineSettleMs))
    const args = typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments as Record<string, unknown> : {}
    const tool = exec.name.replace(/^(mcp__.+?__|cua_driver_native__)/u, '')
    const action = describeArgs(args)
    let frame: CanvasFrame | undefined
    let app = ''
    let window = ''
    let url = ''
    if (surface === 'browser') {
      frame = await this.browserFrame()
      const page = await this.browser.describe()
      window = page.title
      url = page.url
    } else if (this.desktop !== undefined) {
      frame = await this.desktop.toFrame(await this.desktop.screenshot())
      const pid = typeof args.pid === 'number' ? args.pid : undefined
      const windowId = typeof args.window_id === 'number' || typeof args.window_id === 'string' ? String(args.window_id) : undefined
      try {
        const found = await this.desktop.window(pid, windowId)
        if (found !== undefined) this.lastWindow = found
        app = found?.app ?? ''
        window = found?.title ?? ''
      } catch (error) {
        // The step is kept without its window when the runtime cannot list windows.
        void error
      }
    }
    if (frame === undefined) return
    await this.timeline.record({ at: Date.now(), surface, tool, action, app, window, url }, frame)
    this.brief.noteAction({ tool, action, app, window, url })
  }

  /** Store PNGs as attachments for a model request. */
  private async storeImages(pngs: readonly Buffer[]): Promise<ImageAttachmentRef[]> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) return []
    const refs: ImageAttachmentRef[] = []
    for (const [i, png] of pngs.entries()) refs.push(await attachments.saveImage({ data: png, mediaType: png[0] === 0xff ? 'image/jpeg' : 'image/png', name: `co-canvas ${i + 1}` }))
    return refs
  }

  private async loadSettings(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(join(this.config.dataDir, 'settings.json'), 'utf8')) as Partial<Record<keyof PanelSettings, unknown>>
      const model = saved.askModel as Partial<Record<keyof ModelChoice, unknown>> | undefined
      if (typeof model?.provider === 'string' && typeof model.model === 'string') {
        this.askChoice = { provider: model.provider, model: model.model, name: typeof model.name === 'string' ? model.name : model.model, image: model.image === true }
      }
      this.pauseOnAsk = saved.pauseOnAsk === true
    } catch (error) {
      // No saved settings yet: the configured defaults apply.
      void error
    }
  }

  private async saveSettings(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true })
    const settings: PanelSettings = { ...this.askChoice === undefined ? {} : { askModel: this.askChoice }, pauseOnAsk: this.pauseOnAsk }
    await writeFile(join(this.config.dataDir, 'settings.json'), JSON.stringify(settings, null, 2))
  }

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

  /**
   * Whether an agent is a top-level conversation rather than a subagent; executions without an agent count as top-level.
   * @param agent - the executing or receiving agent.
   * @returns false only for an agent owned by another agent.
   */
  private isRoot(agent: Agent | undefined): boolean {
    const agents = this.ctx.get('agents')
    return agent === undefined || agents === undefined || agents.roots().includes(agent)
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
