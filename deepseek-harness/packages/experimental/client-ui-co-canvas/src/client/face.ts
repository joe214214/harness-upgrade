/** Injected co-canvas actions and observable state. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasControl, CanvasFrame, CanvasInput, CanvasMark, CanvasState, MarkInput } from '@deepseek-ai/dsh-experimental-co-canvas/types'

/** Host actions and live sources for one co-canvas tab. */
export interface CanvasInjected {
  readonly hooks: {
    readonly canvas: HostObservable<CanvasState | null>
    readonly frame: HostObservable<CanvasFrame | null>
  }
  readonly mark: (input: MarkInput) => Promise<CanvasMark>
  readonly removeMark: (id: string) => Promise<void>
  readonly setControl: (control: CanvasControl) => Promise<void>
  readonly input: (input: CanvasInput) => Promise<void>
  readonly answer: (questionId: string) => Promise<void>
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The single co-canvas view of the shared browser. */
    'co-canvas': Record<string, never>
  }
}
