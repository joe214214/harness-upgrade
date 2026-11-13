/** Injected co-canvas actions and observable state. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasControl, CanvasFrame, CanvasInput, CanvasMark, CanvasState, MarkInput, ModelChoice } from '@deepseek-ai/dsh-experimental-co-canvas/types'

/** Host actions and live sources for one co-canvas tab. */
export interface CanvasInjected {
  readonly hooks: {
    readonly canvas: HostObservable<CanvasState | null>
    readonly frame: HostObservable<CanvasFrame | null>
    readonly desktopFrame: HostObservable<CanvasFrame | null>
  }
  readonly mark: (input: MarkInput) => Promise<CanvasMark>
  readonly removeMark: (id: string) => Promise<void>
  readonly setControl: (control: CanvasControl) => Promise<void>
  readonly input: (input: CanvasInput) => Promise<void>
  readonly answer: (questionId: string) => Promise<void>
  /** Send the draft marks to the agent as instructions, with the user's text attached. */
  readonly send: (note: string) => Promise<void>
  /** Ask the side-question model about the undelivered marks, or about marks on a timeline step. */
  readonly ask: (question: string, step?: string, marks?: readonly MarkInput[]) => Promise<string>
  /** Models that can answer side questions. */
  readonly askModels: () => Promise<ModelChoice[]>
  readonly setAskModel: (choice: ModelChoice) => Promise<void>
  readonly setPauseOnAsk: (on: boolean) => Promise<void>
  /** Correct the task brief's goal; empty returns to following the user's requests. */
  readonly editGoal: (goal: string) => Promise<void>
  /** The screen after one timeline step. */
  readonly stepFrame: (step: string) => Promise<CanvasFrame>
  /** Send the agent back to a timeline step with marks and a note. */
  readonly rewind: (step: string, marks: readonly MarkInput[], note: string) => Promise<void>
  /** After a delay, freeze the screen full screen and mark on it. */
  readonly markScreen: (delayMs: number, locale: string, defaultQuestion: string) => Promise<unknown>
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The single co-canvas view of the shared browser. */
    'co-canvas': Record<string, never>
  }
}
