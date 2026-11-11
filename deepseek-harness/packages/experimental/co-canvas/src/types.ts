/** Wire types shared by the co-canvas Host service and its Web panel. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Browser input was sent while the user did not hold control. */
    'co-canvas/not-in-control': { readonly control: CanvasControl }
    /** Marks were sent to discuss before any agent used co-canvas or sent a message. */
    'co-canvas/no-agent': Record<string, never>
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
  /** The user sent marks to discuss; the agent's actions stay refused until the user replies or resumes. */
  readonly discussing: boolean
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
  readonly action: 'send' | 'discuss' | 'cancel'
  readonly marks: number
}
