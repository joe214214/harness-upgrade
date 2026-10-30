/** Wire types shared by the co-canvas Host service and its Web panel. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Browser input was sent while the user did not hold control. */
    'co-canvas/not-in-control': { readonly control: CanvasControl }
  }
}

/** Who may operate the shared browser: the agent, nobody (paused), or the user. */
export type CanvasControl = 'agent' | 'paused' | 'human'

/** Rectangle in page CSS pixels of the shared browser's viewport. */
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
  readonly id: string
  readonly url: string
  readonly title: string
  /** Epoch milliseconds. */
  readonly at: number
  readonly target?: MarkTarget
}

/** A question from the agent that the user answers by marking the page. */
export interface CanvasQuestion {
  readonly id: string
  readonly text: string
}

/** Live state of the shared browser and the collaboration around it. */
export interface CanvasState {
  readonly connected: boolean
  readonly url: string
  readonly title: string
  readonly control: CanvasControl
  readonly question: CanvasQuestion | null
  /** Marks not yet delivered to the agent. */
  readonly pending: readonly CanvasMark[]
  readonly viewport: { readonly width: number; readonly height: number }
}

/** One JPEG frame of the active page. */
export interface CanvasFrame {
  /** Base64 JPEG bytes. */
  readonly data: string
  /** Page CSS width and height the frame depicts. */
  readonly width: number
  readonly height: number
}

/** User input forwarded to the shared browser while the user has control. */
export type CanvasInput =
  | { readonly type: 'click'; readonly x: number; readonly y: number }
  | { readonly type: 'scroll'; readonly x: number; readonly y: number; readonly deltaY: number }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'key'; readonly key: string }
