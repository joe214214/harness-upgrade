/**
 * Cross-Session long-term memory for DeepSeek Harness, built on three
 * documented extension points and no agent-loop change:
 *
 * - `ctx.systemPrompt.context` places MEMORY.md in every request;
 * - `ctx.tools` registers memory_read / memory_write / memory_replace /
 *   memory_rewrite and recall;
 * - `agent/turn-stopping` stores the finished turn in episodic memory and
 *   runs the reflect pass, which files durable facts without the model
 *   having to remember to save them.
 * @module @deepseek-ai/dsh-memory
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { EpisodicMemory } from './episodic.ts'
import { LongTermMemory, MemoryFullError } from './longterm.ts'
import { REFLECT_SYSTEM, SECTIONS, parseFacts, reflectInput } from './reflect.ts'
import { toTurns } from './turns.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-memory-reflect': { kind: 'dsh-memory-reflect' } & ContextFormed
  }
}

export { EpisodicMemory, ftsQuery } from './episodic.ts'
export type { RecallHit, Turn } from './episodic.ts'
export { LongTermMemory, MemoryFullError } from './longterm.ts'
export { REFLECT_SYSTEM, parseFacts, reflectInput } from './reflect.ts'
export type { Fact } from './reflect.ts'
export { toTurns } from './turns.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory'

/** Required services; the reflect pass also uses `llm` when it is mounted. */
export const inject = ['tools', 'systemPrompt']

/** Plugin config; every field has a validated default. */
export interface Config {
  /** Directory holding MEMORY.md and episodic.db. */
  root?: string
  /** MEMORY.md byte cap. */
  capBytes?: number
  /** Run the reflect pass after each turn. */
  reflect?: boolean
  /** Output token cap of one reflect request. */
  reflectMaxTokens?: number
  /** Deadline of one reflect request. */
  reflectTimeoutMs?: number
  /** Hits returned by one recall. */
  recallLimit?: number
  /** Clip length for ordinary tool results stored in episodic memory. */
  maxToolChars?: number
}

export const Config: z<Config> = z.object({
  root: z.string().default(join(homedir(), '.dsh-memory')),
  capBytes: z.natural().min(512).default(8000),
  reflect: z.boolean().default(true),
  reflectMaxTokens: z.natural().min(64).default(1024),
  reflectTimeoutMs: z.natural().min(1000).default(60_000),
  recallLimit: z.natural().min(1).max(50).default(8),
  maxToolChars: z.natural().min(100).default(1500),
})

type ResolvedConfig = Required<Config>

const GUIDE = `You have a long-term memory that persists across sessions.
- Facts in <memory> were saved in earlier sessions; rely on them.
- When the user states a durable preference, convention or decision, save it with memory_write.
- If memory_write reports memory is full, consolidate with memory_rewrite, then retry.
- When the user refers to earlier work, recordings or documents that are not in <memory>, search past sessions with recall.`

/**
 * Run a synchronous tool body (file and SQLite work) as a promise, turning a
 * throw into the rejection the tool executor reports.
 * @param body - synchronous tool body.
 * @returns the settled value.
 */
function settle<T>(body: () => T): Promise<T> {
  try {
    return Promise.resolve(body())
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Run one reflect request on the calling agent's route.
 * @param ctx - context with `llm`.
 * @param agent - agent whose turn ended.
 * @param input - reflect user message.
 * @param cfg - resolved config.
 * @param signal - turn cancellation.
 * @returns the model's text answer.
 */
async function askReflect(ctx: Context, agent: Agent, input: string, cfg: ResolvedConfig, signal: AbortSignal): Promise<string> {
  const llm = ctx.get('llm')
  const routed = agent.session.requestHeader()?.config
  const provider = routed?.provider ?? agent.options.provider
  const model = routed?.model ?? agent.options.model
  if (llm === undefined || provider === undefined || model === undefined) return ''
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(cfg.reflectTimeoutMs)])
  const call = await llm.prepareCall({ provider, model, maxTokens: cfg.reflectMaxTokens }, deadline)
  const options: GenerateOptions = {
    ...call.config,
    messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'dsh-memory-reflect' } })],
    system: REFLECT_SYSTEM,
    sessionId: agent.session.header.id,
    signal: deadline,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream(options)) assembler.push(chunk)
  return assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('')
}

/**
 * Mount memory.
 * @param ctx - plugin context with `tools` and `systemPrompt`.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = config as ResolvedConfig
  const longterm = new LongTermMemory(join(cfg.root, 'MEMORY.md'), cfg.capBytes)
  const episodic = new EpisodicMemory(join(cfg.root, 'episodic.db'))
  ctx.effect(() => () => { episodic.close() })

  ctx.systemPrompt.context({
    name: 'memory',
    order: 900,
    interpolate: false,
    text: () => `${GUIDE}\n\n${longterm.renderForPrompt() || '<memory>(empty)</memory>'}`,
  })

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read the whole long-term memory file (MEMORY.md), including source tags.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve(longterm.read() || '(memory is empty)'),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: 'Save one durable fact to long-term memory: a user preference, project convention or decision that should still hold in future sessions. '
      + 'Fails when memory is full; then consolidate with memory_rewrite first.',
    parameters: {
      section: { type: 'string', required: true, enum: [...SECTIONS] },
      fact: { type: 'string', required: true, description: 'One self-contained line.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args, exec) => settle(() => {
      const changed = longterm.append(args.section, args.fact, exec.agent?.session.header.id ?? '')
      return changed ? `saved (${longterm.size()}/${cfg.capBytes} bytes)` : 'already in memory'
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_replace',
    description: 'Replace one exact, unique substring of MEMORY.md to fix or update a fact; an empty replacement deletes it.',
    parameters: {
      old: { type: 'string', required: true },
      new: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => settle(() => {
      if (!longterm.replace(args.old, args.new)) throw new Error('"old" must occur exactly once in MEMORY.md; read it with memory_read')
      return `replaced (${longterm.size()}/${cfg.capBytes} bytes)`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_rewrite',
    description: 'Replace the whole MEMORY.md to consolidate it: merge duplicates, drop stale facts, compress details. Keep the "## section" / "- fact" format.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => settle(() => {
      longterm.rewrite(args.text)
      return `rewritten (${longterm.size()}/${cfg.capBytes} bytes)`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'recall',
    description: 'Search earlier sessions\' conversations, tool results and media transcripts by keywords. '
      + 'Use when the user refers to previous work that is not in long-term memory.',
    parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute: (args, exec) => settle(() => {
      const hits = episodic.search(args.query, cfg.recallLimit, exec.agent?.session.header.id)
      if (hits.length === 0) return 'no matches in past sessions'
      return hits.map(h => `[${h.sessionId.slice(0, 20)} · ${h.role}${h.toolName ? ` ${h.toolName}` : ''}] ${h.content.slice(0, 1200)}`).join('\n\n')
    }),
  }))

  // Derived messages already stored, per Session.
  const stored = new Map<string, number>()

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const session = agent.session
    const sessionId = session.header.id
    try {
      const messages = session.deriveMessages()
      const fresh = toTurns(messages.slice(stored.get(sessionId) ?? 0), cfg.maxToolChars)
      stored.set(sessionId, messages.length)
      if (fresh.length === 0) return
      episodic.append(sessionId, session.header.cwd ?? '', fresh)
      if (!cfg.reflect) return
      const facts = parseFacts(await askReflect(ctx, agent, reflectInput(longterm.read(), fresh), cfg, signal))
      for (const fact of facts) longterm.append(fact.section, fact.fact, sessionId)
    } catch (error: unknown) {
      // Memory is best-effort: a full memory or a failed reflect request must not fail the user's turn.
      if (!(error instanceof MemoryFullError)) ctx.logger('memory').warn(`memory: turn ingest failed for ${sessionId}: ${String(error)}`)
    }
  })
}
