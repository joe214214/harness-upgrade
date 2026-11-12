/** Wire types shared by the co-canvas Host service and its Web panel. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Browser input was sent while the user did not hold control. */
    'co-canvas/not-in-control': { readonly control: CanvasControl }
    /** Marks were sent back to a past step before any agent used co-canvas or sent a message. */
    'co-canvas/no-agent': Record<string, never>
    /** A timeline step is no longer kept. */
    'co-canvas/no-step': { readonly step: string }
    /** No configured model provider offers the model chosen for side questions. */
    'co-canvas/no-model': { readonly model: string }
    /** The desktop surface is disabled in this composition. */
    'co-canvas/no-desktop': Record<string, never>
  }
}

/** Where a mark was drawn: the shared browser's page or the primary display. */
export type CanvasSurface = 'browser' | 'desktop'

/** The desktop window under a desktop mark. Bounds are screen points. */
export interface DesktopWindow {
  /** Application name, empty when the platform does not report one. */
  readonly app: string
  readonly title: string
  readonly pid?: number
  /** Platform window id as decimal text. */
  readonly windowId?: string
  readonly bounds: CanvasRect
}

/** Who may operate the shared browser: the agent, nobody (paused), or the user. */
export type CanvasControl = 'agent' | 'paused' | 'human'

/** Rectangle in page CSS pixels of the shared browser's viewport, or in screen points on the desktop. */
export interface CanvasRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Mark kinds; an arrow points from its rectangle's origin to the opposite corner. */
export type MarkShape = 'box' | 'arrow' | 'point'

/** One mark drawn by the user on the live view. */
export interface MarkInput {
  /** Surface the rectangle refers to; omission means the browser. */
  readonly surface?: CanvasSurface
  readonly shape: MarkShape
  readonly rect: CanvasRect
  /** Free-text instruction attached to the mark. */
  readonly note?: string
}

/** The page element under a mark's focus point. */
export interface MarkTarget {
  /** Lower-case tag name. */
  readonly tag: string
  /** Visible text, trimmed and shortened. */
  readonly text: string
  /** Explicit or implicit ARIA role, when known. */
  readonly role?: string
  /** aria-label, title, placeholder, or alt text, when present. */
  readonly label?: string
  /** CSS selector that matches this element. */
  readonly selector: string
  /** 1-based position among elements with the same tag and text. */
  readonly nth: number
  /** Number of elements with the same tag and text. */
  readonly sameCount: number
}

/** A recorded mark with the page it was drawn on and its grounded element. */
export interface CanvasMark extends MarkInput {
  readonly surface: CanvasSurface
  readonly id: string
  readonly url: string
  readonly title: string
  /** Epoch milliseconds. */
  readonly at: number
  readonly target?: MarkTarget
  /** Window under a desktop mark's focus point. */
  readonly window?: DesktopWindow
}

/** A question from the agent that the user answers by marking the page. */
export interface CanvasQuestion {
  readonly id: string
  readonly text: string
}

/** Live state of the shared browser and the collaboration around it. */
export interface CanvasState {
  readonly connected: boolean
  /** Why the shared browser could not start; null while it runs or is starting. */
  readonly failure: string | null
  readonly url: string
  readonly title: string
  readonly control: CanvasControl
  /** What the agent is doing and where, kept for side questions; null before the agent acts. */
  readonly brief: TaskBrief | null
  /** Side questions and their answers, oldest first. */
  readonly answers: readonly SideAnswer[]
  /** Model that answers side questions; null when none is resolved yet. */
  readonly askModel: ModelChoice | null
  /** Pause the agent while a side question is answered. */
  readonly pauseOnAsk: boolean
  /** The agent's recorded browser and desktop actions, oldest first. */
  readonly timeline: readonly TimelineStep[]
  /** Whether the desktop surface is enabled. */
  readonly desktop: boolean
  readonly question: CanvasQuestion | null
  /** Marks not yet delivered to the agent. */
  readonly pending: readonly CanvasMark[]
  readonly viewport: { readonly width: number; readonly height: number }
}

/** One JPEG frame of the active page or of the primary display. */
export interface CanvasFrame {
  /** Base64 JPEG bytes. */
  readonly data: string
  /** Page CSS width and height, or screen points, the frame depicts. */
  readonly width: number
  readonly height: number
}

/** User input forwarded to the shared browser while the user has control. */
export type CanvasInput =
  | { readonly type: 'click'; readonly x: number; readonly y: number }
  | { readonly type: 'scroll'; readonly x: number; readonly y: number; readonly deltaY: number }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'key'; readonly key: string }

/** What the user did when marking the real screen, and how many marks were recorded. */
export interface ScreenMarkOutcome {
  readonly action: 'send' | 'ask' | 'cancel'
  readonly marks: number
}

/** What the agent is working on and where, recorded while it acts. */
export interface TaskBrief {
  /** The user's request, as the agent was given it or as the user corrected it. */
  readonly goal: string
  /** The user edited the goal; later requests do not replace it. */
  readonly goalEdited: boolean
  /** Application of the window the agent last acted in. */
  readonly app: string
  /** Title of that window, or of the shared browser's page. */
  readonly window: string
  /** Address of the shared browser's page when the agent last used it. */
  readonly url: string
  /** One-line summary of what is done and what is next; empty until summarized. */
  readonly progress: string
  /** Browser and desktop actions recorded in this run of the service. */
  readonly steps: number
}

/** A model that can answer side questions. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
  /** Display name. */
  readonly name: string
  /** The model accepts images, so it sees the marked screenshots. */
  readonly image: boolean
}

/** One side question about the screen and its answer. */
export interface SideAnswer {
  readonly id: string
  readonly question: string
  /** Answer text so far. */
  readonly answer: string
  readonly status: 'answering' | 'done' | 'failed'
  /** Model that answered, as provider/model. */
  readonly model: string
  /** Epoch milliseconds. */
  readonly at: number
  /** Timeline step the question was asked on; absent for the live view. */
  readonly step?: number
  /** Number of marks the question referred to. */
  readonly marks: number
}

/** One recorded browser or desktop action of the agent, with the screen after it. */
export interface TimelineStep {
  readonly id: string
  /** 1-based position in the timeline. */
  readonly index: number
  /** Epoch milliseconds. */
  readonly at: number
  readonly surface: CanvasSurface
  /** Tool name. */
  readonly tool: string
  /** Short description of the action's arguments. */
  readonly action: string
  readonly app: string
  readonly window: string
  readonly url: string
  /** The action looks like one that cannot be undone, such as submitting, paying, sending, or deleting. */
  readonly irreversible: boolean
}
