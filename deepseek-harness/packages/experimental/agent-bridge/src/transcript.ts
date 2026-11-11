/**
 * The agent-neutral transcript every reader produces and every writer takes:
 * user, assistant, and tool-result messages as text, with tool calls and
 * results written as tagged notes the way Codex imports foreign sessions.
 * @module @deepseek-ai/dsh-experimental-agent-bridge/transcript
 */

import { createHash } from 'node:crypto'
import type { ExternalAgent } from './types.ts'

/** One model-visible message of an external or exported session. */
export interface BridgeMessage {
  /** Stable identity within its session file: a record id, or a line number for formats without one. */
  readonly key: string
  readonly role: 'user' | 'assistant' | 'tool'
  readonly text: string
  /** ISO timestamp, when the source records one. */
  readonly at?: string
}

/** A session file read into transcript form. */
export interface ParsedSession {
  readonly id: string
  readonly cwd: string | null
  readonly title: string | null
  readonly messages: readonly BridgeMessage[]
}

/** Display name of each agent. */
export const AGENT_NAMES: Readonly<Record<ExternalAgent, string>> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }

const NOTE_MAX = 2000

/**
 * Shorten text to a limit, marking the cut.
 * @param text - any text.
 * @param max - most characters kept.
 * @returns the text, or its head with a marker.
 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`
}

/**
 * A tool call as a tagged note.
 * @param name - tool name.
 * @param input - call arguments.
 * @returns the note.
 */
export function toolCallNote(name: string, input: unknown): string {
  const lines = [`[tool call: ${name}]`]
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const fields = input as Record<string, unknown>
    for (const key of ['description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query']) {
      const value = fields[key]
      if (typeof value === 'string' || (Array.isArray(value) && value.every(v => typeof v === 'string'))) {
        lines.push(`${key}: ${clip(Array.isArray(value) ? value.join(' ') : value, NOTE_MAX)}`)
      }
    }
    if (lines.length === 1) lines.push(`input: ${clip(JSON.stringify(input), NOTE_MAX)}`)
  } else if (input !== undefined) {
    lines.push(`input: ${clip(typeof input === 'string' ? input : JSON.stringify(input), NOTE_MAX)}`)
  }
  return lines.join('\n')
}

/**
 * A tool result as a tagged note.
 * @param output - result text.
 * @param error - whether the tool failed.
 * @returns the note.
 */
export function toolResultNote(output: string, error = false): string {
  return `[tool result${error ? ': error' : ''}]\n${clip(output.trim(), NOTE_MAX)}`
}

/**
 * Plain text of a content value: a string, or text found in an array of blocks or parts.
 * @param content - string, block array, or other JSON.
 * @returns the text, possibly empty.
 */
export function plainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (part !== null && typeof part === 'object') {
        const record = part as Record<string, unknown>
        if (typeof record.text === 'string') return record.text
        if (record.content !== undefined) return plainText(record.content)
      }
      return ''
    }).filter(Boolean).join('\n')
  }
  if (content !== null && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.output === 'string') return record.output
    return JSON.stringify(content)
  }
  return typeof content === 'number' || typeof content === 'boolean' ? String(content) : ''
}

/**
 * Fingerprint of a message's role and text, used to recognise messages the bridge wrote itself.
 * @param message - a transcript message.
 * @returns a short hash.
 */
export function fingerprint(message: Pick<BridgeMessage, 'role' | 'text'>): string {
  const role = message.role === 'tool' ? 'assistant' : message.role
  return createHash('sha256').update(`${role}\n${message.text.trim()}`).digest('hex').slice(0, 24)
}

/** How a re-read transcript relates to the messages already delivered. */
export interface TranscriptChange {
  /** Messages after the shared prefix, to deliver. */
  readonly added: readonly BridgeMessage[]
  /** Delivered messages that are no longer in the transcript (a rewind or edit). */
  readonly dropped: number
}

/**
 * Compare a re-read transcript with the keys already delivered.
 * @param delivered - keys delivered so far, in order.
 * @param current - the transcript as it is now.
 * @returns the new suffix and how many delivered messages were dropped.
 */
export function changeSince(delivered: readonly string[], current: readonly BridgeMessage[]): TranscriptChange {
  let shared = 0
  while (shared < delivered.length && shared < current.length && delivered[shared] === current[shared]?.key) shared++
  return { added: current.slice(shared), dropped: delivered.length - shared }
}

/**
 * Render messages for the model, newest last, within a character budget.
 * @param messages - messages to render.
 * @param agent - agent that wrote them.
 * @param budget - most characters of message text; older messages beyond it are counted, not shown.
 * @returns the rendered lines and how many messages were left out.
 */
export function renderMessages(
  messages: readonly BridgeMessage[], agent: ExternalAgent, budget: number,
): { text: string; omitted: number } {
  const speaker = (m: BridgeMessage): string => (m.role === 'user' ? 'User' : m.role === 'tool' ? 'Tool' : AGENT_NAMES[agent])
  const blocks: string[] = []
  let used = 0
  let index = messages.length - 1
  for (; index >= 0; index--) {
    const m = messages[index]
    if (m === undefined) break
    const block = `${speaker(m)}${m.at === undefined ? '' : ` (${m.at})`}:\n${m.text.trim()}`
    if (used + block.length > budget && blocks.length > 0) break
    blocks.unshift(clip(block, budget))
    used += block.length
  }
  return { text: blocks.join('\n\n'), omitted: index + 1 }
}
