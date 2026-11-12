/**
 * The task brief: what the agent is working on and where. Location comes from the agent's own
 * actions as they run; the goal comes from the user's request; a short progress line is
 * summarized now and then by the side-question model, off the agent's path.
 * @module @deepseek-ai/dsh-experimental-co-canvas/brief
 */
import type { TaskBrief } from './types.ts'

/** Longest goal kept, in characters. */
const GOAL_CHARS = 400

/** One recorded action as the brief sees it. */
export interface BriefAction {
  readonly tool: string
  readonly action: string
  readonly app: string
  readonly window: string
  readonly url: string
}

/**
 * Summarize the goal and progress from the user's requests and the agent's recent actions.
 * Returns undefined when no summary could be made.
 */
export type BriefSummarizer = (input: string, signal: AbortSignal) => Promise<{ goal?: string; progress?: string } | undefined>

/** Instructions of the brief summary request. */
export const BRIEF_SYSTEM = 'You keep a two-line brief of what a computer-use agent is doing for a user. '
  + 'Given the user\'s requests and the agent\'s recent actions, reply with JSON only: '
  + '{"goal": "<the task in one short sentence, in the user\'s language>", "progress": "<what is done and what is next, one short sentence>"}.'

/**
 * Parse a summary reply.
 * @param text - model output, possibly fenced.
 * @returns the goal and progress found, or undefined.
 */
export function parseBriefSummary(text: string): { goal?: string; progress?: string } | undefined {
  const match = /\{[\s\S]*\}/u.exec(text)
  if (match === null) return undefined
  try {
    const value = JSON.parse(match[0]) as { goal?: unknown; progress?: unknown }
    const goal = typeof value.goal === 'string' && value.goal.trim() !== '' ? value.goal.trim().slice(0, GOAL_CHARS) : undefined
    const progress = typeof value.progress === 'string' && value.progress.trim() !== '' ? value.progress.trim().slice(0, GOAL_CHARS) : undefined
    if (goal === undefined && progress === undefined) return undefined
    return { ...goal === undefined ? {} : { goal }, ...progress === undefined ? {} : { progress } }
  } catch (error) {
    // A malformed reply leaves the brief as it was.
    void error
    return undefined
  }
}

/** Keeps the brief of the conversation the user sees. */
export class TaskBriefTracker {
  private goal = ''
  private goalEdited = false
  private app = ''
  private window = ''
  private url = ''
  private progress = ''
  private steps = 0
  private readonly requests: string[] = []
  private readonly recent: BriefAction[] = []
  private summarizing = false
  private sinceSummary = 0

  /**
   * @param everySteps - actions between progress summaries.
   * @param summarize - summary request, or undefined when no model is available.
   * @param changed - called after every change.
   */
  constructor(
    private readonly everySteps: number,
    private readonly summarize: BriefSummarizer | undefined,
    private readonly changed: () => void,
  ) {}

  /**
   * Record a request the user sent to the agent.
   * @param text - the request text.
   */
  noteRequest(text: string): void {
    const request = text.trim()
    if (request === '') return
    this.requests.push(request.slice(0, GOAL_CHARS))
    if (this.requests.length > 3) this.requests.shift()
    // A short reply such as "yes, go on" is no new task, so a request becomes the goal only when
    // there is none yet; the summary decides from all recent requests.
    if (!this.goalEdited && this.goal === '') this.goal = request.slice(0, GOAL_CHARS)
    this.changed()
    this.refresh()
  }

  /**
   * Record one action of the agent and, every few actions, refresh the summary in the background.
   * @param action - the action and where it happened.
   */
  noteAction(action: BriefAction): void {
    if (action.app !== '') this.app = action.app
    if (action.window !== '') this.window = action.window
    if (action.url !== '') this.url = action.url
    this.steps++
    this.recent.push(action)
    if (this.recent.length > 12) this.recent.shift()
    this.sinceSummary++
    this.changed()
    if (this.steps === 1 || this.sinceSummary >= this.everySteps) this.refresh()
  }

  /**
   * Set the goal as the user wrote it; an empty goal returns to following the user's requests.
   * @param goal - the corrected goal.
   */
  edit(goal: string): void {
    const text = goal.trim().slice(0, GOAL_CHARS)
    this.goalEdited = text !== ''
    this.goal = text !== '' ? text : this.requests.at(-1) ?? ''
    this.changed()
  }

  /**
   * Read the brief for the panel.
   * @returns the brief, or null before the agent acted or was asked anything.
   */
  snapshot(): TaskBrief | null {
    if (this.goal === '' && this.steps === 0) return null
    const { goal, goalEdited, app, window, url, progress, steps } = this
    return { goal, goalEdited, app, window, url, progress, steps }
  }

  /**
   * Render the brief for a side question.
   * @returns the brief and the latest actions as model-facing text.
   */
  text(): string {
    const lines = ['<task_brief>']
    if (this.goal !== '') lines.push(`Task: ${this.goal}`)
    const where = [this.app, this.window, this.url].filter(part => part !== '')
    if (where.length > 0) lines.push(`Where: ${[...new Set(where)].join(' · ')}`)
    if (this.progress !== '') lines.push(`Progress: ${this.progress}`)
    if (this.recent.length > 0) {
      lines.push('Recent actions, oldest first:')
      for (const a of this.recent.slice(-8)) lines.push(`- ${a.tool} ${a.action}${a.window !== '' ? ` (in ${a.window})` : ''}`)
    }
    lines.push('</task_brief>')
    return lines.join('\n')
  }

  private refresh(): void {
    const summarize = this.summarize
    if (summarize === undefined || this.summarizing) return
    this.summarizing = true
    this.sinceSummary = 0
    const input = [
      'User requests, oldest first:', ...this.requests.map(r => `- ${r}`),
      'Agent actions, oldest first:', ...this.recent.map(a => `- ${a.tool} ${a.action}${a.window !== '' ? ` in ${a.window}` : ''}${a.url !== '' ? ` at ${a.url}` : ''}`),
    ].join('\n')
    summarize(input, AbortSignal.timeout(30_000)).then((summary) => {
      if (summary === undefined) return
      if (summary.goal !== undefined && !this.goalEdited) this.goal = summary.goal
      if (summary.progress !== undefined) this.progress = summary.progress
      this.changed()
    }, (error: unknown) => {
      // The brief is a convenience: a failed summary keeps the recorded goal and location.
      void error
    }).finally(() => { this.summarizing = false })
  }
}
