/**
 * The timeline: the screen after each browser or desktop action of the agent, kept on disk so the
 * user can go back to a step, mark it, and ask about it or send the agent back to it.
 * @module @deepseek-ai/dsh-experimental-co-canvas/timeline
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { markSvg } from './desktop.ts'
import type { CanvasFrame, CanvasRect, MarkInput, TimelineStep } from './types.ts'

/** Words in an action or its target that suggest it cannot be undone. */
const IRREVERSIBLE = new RegExp('\\b(submit|pay|payment|purchase|buy|checkout|order|place[_ ]order|send|post|publish|delete|remove|confirm|transfer|book)\\b'
  + '|提交|支付|付款|购买|下单|结算|发送|发布|删除|确认|转账|预订|预定', 'iu')

/**
 * Whether an action looks like one that cannot be undone.
 * @param tool - tool name.
 * @param action - description of its arguments.
 * @returns true for submitting, paying, sending, deleting and the like.
 */
export function looksIrreversible(tool: string, action: string): boolean {
  if (/key|hotkey|press/iu.test(tool) && /\benter\b|return/iu.test(action)) return true
  return IRREVERSIBLE.test(action)
}

/**
 * Describe tool arguments in one short line.
 * @param args - the tool call's arguments.
 * @param max - longest result in characters.
 * @returns `key=value` pairs, values shortened.
 */
export function describeArgs(args: Readonly<Record<string, unknown>>, max = 160): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    const text = typeof value === 'string' ? JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value) : JSON.stringify(value)
    parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`)
  }
  const line = parts.join(' ')
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** A step being recorded: everything but its id, index and frame. */
export type StepInput = Omit<TimelineStep, 'id' | 'index' | 'irreversible'>

interface StoredStep extends TimelineStep {
  readonly width: number
  readonly height: number
}

/** Steps kept in memory, frames on disk under one directory, oldest dropped past the limit. */
export class Timeline {
  private readonly steps: StoredStep[] = []
  private next = 1
  private ready: Promise<void> | undefined

  /**
   * @param dir - directory of the frames; emptied when the timeline starts.
   * @param maxSteps - most steps kept.
   */
  constructor(private readonly dir: string, private readonly maxSteps: number) {}

  private prepare(): Promise<void> {
    this.ready ??= rm(this.dir, { recursive: true, force: true }).then(() => mkdir(this.dir, { recursive: true })).then(() => {})
    return this.ready
  }

  /**
   * Record one step with the screen after it.
   * @param input - the action and where it happened.
   * @param frame - JPEG frame of the screen after the action.
   * @returns the recorded step.
   */
  async record(input: StepInput, frame: CanvasFrame): Promise<TimelineStep> {
    await this.prepare()
    const step: StoredStep = {
      ...input, id: randomUUID(), index: this.next++, irreversible: looksIrreversible(input.tool, input.action),
      width: frame.width, height: frame.height,
    }
    await writeFile(join(this.dir, `${step.id}.jpg`), Buffer.from(frame.data, 'base64'))
    this.steps.push(step)
    while (this.steps.length > this.maxSteps) {
      const dropped = this.steps.shift()
      if (dropped !== undefined) await rm(join(this.dir, `${dropped.id}.jpg`), { force: true })
    }
    return publicStep(step)
  }

  /**
   * List the steps for the panel.
   * @returns the steps kept, oldest first.
   */
  list(): TimelineStep[] {
    return this.steps.map(publicStep)
  }

  /**
   * Look up one step.
   * @param id - step id.
   * @returns the step, or undefined when it is no longer kept.
   */
  get(id: string): TimelineStep | undefined {
    const step = this.steps.find(s => s.id === id)
    return step === undefined ? undefined : publicStep(step)
  }

  /**
   * List what the agent did after a step.
   * @param id - step id.
   * @returns the steps recorded after it, oldest first.
   */
  after(id: string): TimelineStep[] {
    const at = this.steps.findIndex(s => s.id === id)
    return at < 0 ? [] : this.steps.slice(at + 1).map(publicStep)
  }

  /**
   * Read a step's frame from disk.
   * @param id - step id.
   * @returns the screen after that step, or undefined when it is no longer kept.
   */
  async frame(id: string): Promise<CanvasFrame | undefined> {
    const step = this.steps.find(s => s.id === id)
    if (step === undefined) return undefined
    const jpeg = await readFile(join(this.dir, `${step.id}.jpg`))
    return { data: jpeg.toString('base64'), width: step.width, height: step.height }
  }

  /**
   * Crop marks drawn on a step's frame, each with its mark in red.
   * @param id - step id.
   * @param marks - marks in the frame's coordinates.
   * @param margin - context around each mark, in the frame's coordinates.
   * @returns one PNG per mark; empty when the step is gone.
   */
  async crops(id: string, marks: readonly MarkInput[], margin: number): Promise<Buffer[]> {
    const frame = await this.frame(id)
    if (frame === undefined) return []
    return Promise.all(marks.map(mark => cropFrame(frame, mark.shape, mark.rect, margin)))
  }
}

function publicStep(step: StoredStep): TimelineStep {
  const { width: _width, height: _height, ...rest } = step
  return rest
}

/**
 * Cut the area around a mark out of a frame and draw the mark on it.
 * @param frame - JPEG frame and the size it depicts.
 * @param shape - mark kind.
 * @param rect - mark rectangle in the frame's coordinates.
 * @param margin - context around the mark, in the frame's coordinates.
 * @returns PNG bytes.
 */
export async function cropFrame(frame: CanvasFrame, shape: MarkInput['shape'], rect: CanvasRect, margin: number): Promise<Buffer> {
  const jpeg = Buffer.from(frame.data, 'base64')
  const meta = await sharp(jpeg).metadata()
  const pixelWidth = meta.width
  const pixelHeight = meta.height
  const sx = pixelWidth / frame.width
  const sy = pixelHeight / frame.height
  const left = Math.max(0, Math.floor((Math.min(rect.x, rect.x + rect.width) - margin) * sx))
  const top = Math.max(0, Math.floor((Math.min(rect.y, rect.y + rect.height) - margin) * sy))
  const right = Math.min(pixelWidth, Math.ceil((Math.max(rect.x, rect.x + rect.width) + margin) * sx))
  const bottom = Math.min(pixelHeight, Math.ceil((Math.max(rect.y, rect.y + rect.height) + margin) * sy))
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  const local: CanvasRect = { x: rect.x * sx - left, y: rect.y * sy - top, width: rect.width * sx, height: rect.height * sy }
  return sharp(jpeg)
    .extract({ left: Math.min(left, pixelWidth - 1), top: Math.min(top, pixelHeight - 1), width, height })
    .composite([{ input: Buffer.from(markSvg(shape, local, width, height)), top: 0, left: 0 }])
    .png()
    .toBuffer()
}
