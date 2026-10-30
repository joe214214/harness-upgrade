/**
 * Reflect pass: after a turn, an auxiliary model request extracts facts worth
 * keeping across Sessions. The bar is high (durable preferences, conventions,
 * decisions), and anything other than a clean JSON array is discarded, so a
 * refusal or chatty reply never lands in MEMORY.md.
 * @module @deepseek-ai/dsh-memory/reflect
 */

import type { Turn } from './episodic.ts'

/** Sections a fact may be filed under. */
export const SECTIONS = ['user', 'project', 'decisions', 'general'] as const

/** One extracted fact. */
export interface Fact {
  readonly section: (typeof SECTIONS)[number]
  readonly fact: string
}

/** System prompt of the reflect request. */
export const REFLECT_SYSTEM = `Extract facts worth remembering across future sessions from the conversation the user sends.

Include ONLY things that are durable (still true in a month) and stated by the user or established by a decision:
- user preferences and working style ("prefers X", "always do Y")
- project facts: architecture, conventions, key file locations, constraints
- decisions and their reasons, including decisions taken from meeting recordings or documents
Exclude: transient task state, the assistant's own suggestions the user did not adopt, anything already in <existing_memory>.

Return a JSON array and nothing else. Each item: {"section": "user"|"project"|"decisions", "fact": "<one self-contained line>"}.
Return [] if nothing qualifies.`

/**
 * Build the reflect request's user message.
 * @param existing - current MEMORY.md.
 * @param turns - the turn to reflect on.
 * @returns the message text.
 */
export function reflectInput(existing: string, turns: readonly Turn[]): string {
  const transcript = turns.map(t => `${t.role.toUpperCase()}${t.toolName ? ` (${t.toolName})` : ''}: ${t.text}`).join('\n\n')
  return `<existing_memory>\n${existing || '(empty)'}\n</existing_memory>\n\n<conversation>\n${transcript}\n</conversation>`
}

/**
 * Parse the model's answer strictly. The first JSON array in the text is
 * used, which tolerates a markdown fence; malformed items are dropped.
 * @param text - model output.
 * @returns at most 20 facts.
 */
export function parseFacts(text: string): Fact[] {
  const match = /\[[\s\S]*\]/u.exec(text)
  if (match === null) return []
  let data: unknown
  try {
    data = JSON.parse(match[0])
  } catch (error: unknown) {
    // Not JSON: the answer is discarded by design.
    void error
    return []
  }
  if (!Array.isArray(data)) return []
  const facts: Fact[] = []
  for (const item of data as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const { section, fact } = item as { section?: unknown; fact?: unknown }
    if (typeof fact !== 'string' || !fact.trim()) continue
    const name = typeof section === 'string' ? section.trim().toLowerCase() : 'general'
    const known = (SECTIONS as readonly string[]).includes(name) ? name as Fact['section'] : 'general'
    facts.push({ section: known, fact: fact.trim().slice(0, 300) })
  }
  return facts.slice(0, 20)
}
