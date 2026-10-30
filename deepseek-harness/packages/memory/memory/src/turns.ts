/**
 * Projection of derived model history into the flat turns stored in episodic
 * memory and shown to the reflect pass.
 * @module @deepseek-ai/dsh-memory/turns
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Turn } from './episodic.ts'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: string }[]).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more chars]` : text
}

/**
 * Convert messages into turns. System prompts and runtime-context snapshots
 * are dropped (they repeat every request); tool calls become `[tool name] args`
 * lines; tool results are clipped, except media transcripts, which are the
 * content most worth recalling later.
 * @param messages - output of `session.deriveMessages()` for one turn.
 * @param maxToolChars - clip length for ordinary tool results.
 * @returns turns in order.
 */
export function toTurns(messages: readonly Message[], maxToolChars: number): Turn[] {
  const toolNames = new Map<string, string>()
  const turns: Turn[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.source.kind !== 'user') continue
      const text = textOf(message.content)
      if (text) turns.push({ role: 'user', text })
    } else if (message.role === 'assistant') {
      const parts: string[] = []
      const text = textOf(message.content)
      if (text) parts.push(text)
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        toolNames.set(block.id, block.name)
        parts.push(`[tool ${block.name}] ${clip(block.arguments, 500)}`)
      }
      if (parts.length) turns.push({ role: 'assistant', text: parts.join('\n') })
    } else if (message.role === 'tool') {
      const name = toolNames.get(message.toolCallId)
      const media = name === 'read_audio' || name === 'read_video'
      const text = textOf(message.content)
      turns.push({ role: 'tool', text: media ? text : clip(text, maxToolChars), ...name === undefined ? {} : { toolName: name } })
    }
  }
  return turns
}
