/**
 * relay-memory: a DeepSeek Harness plugin that gives every session a
 * self-curated long-term memory.
 *
 * The plugin is a thin bridge. All memory logic lives in the Python server
 * (`python -m relay_memory serve`), reached over newline-delimited JSON-RPC
 * on stdio. The plugin uses three dsh extension points:
 *
 *   ctx.systemPrompt.context  MEMORY.md is placed in every request's context
 *   ctx.tools.register        memory_read / memory_write / memory_replace /
 *                             memory_rewrite / recall, as listed by the server
 *   agent/turn-stopping       the finished turn is stored in episodic memory
 *                             and the reflect pass extracts durable facts
 *
 * Config (cordis.yml `config:`):
 *   python     interpreter command               default 'python3'
 *   root       memory directory                  default $RELAY_MEMORY_ROOT or ~/.relay-memory
 *   reflect    run the reflect pass after turns  default true
 *   capBytes   MEMORY.md size cap                default 8000
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const name = 'relay-memory'
export const inject = ['tools', 'systemPrompt']

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const TOOL_TEXT_LIMIT = 1500

const GUIDE = `You have a long-term memory that persists across sessions.
- Facts in <memory> below were saved in earlier sessions; rely on them.
- When the user states a durable preference, convention or decision, save it with memory_write.
- If memory_write reports memory is full, consolidate with memory_rewrite, then retry.
- When the user refers to earlier work that is not in <memory>, search past sessions with recall.`

/** Resolve plugin config into explicit values; no defaults are applied later. */
export function resolveConfig(config = {}) {
  return {
    python: config.python ?? 'python3',
    root: config.root ?? process.env.RELAY_MEMORY_ROOT ?? join(homedir(), '.relay-memory'),
    reflect: config.reflect ?? true,
    capBytes: config.capBytes ?? 8000,
  }
}

/** JSON-RPC client over a child process's stdio. */
export class RpcClient {
  constructor(command, args, env) {
    this.proc = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'inherit'] })
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.#onLine(line))
    this.proc.on('exit', (code) => this.#failAll(new Error(`relay-memory server exited (code ${code})`)))
    this.proc.on('error', (err) => this.#failAll(err))
  }

  /**
   * Send one request.
   * @param {string} method - JSON-RPC method name.
   * @param {object} params - request params.
   * @returns {Promise<any>} the result, or a rejection carrying the server error.
   */
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('relay-memory server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.proc.stdin.end()
  }

  #onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch (error) {
      // The server only writes JSON-RPC lines; anything else is a server bug worth surfacing.
      process.stderr.write(`[relay-memory] unparseable server line: ${line}\n`)
      return
    }
    const waiter = this.pending.get(msg.id)
    if (!waiter) return
    this.pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message))
    else waiter.resolve(msg.result)
  }

  #failAll(error) {
    this.closed = true
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }
}

/** Text of the content blocks of one type. */
function blockText(content, type = 'text') {
  if (typeof content === 'string') return content
  return (content ?? []).filter((b) => b.type === type).map((b) => b.text).join('\n')
}

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more chars]` : text
}

/**
 * Convert dsh model history into the server's flat turn format. System
 * prompts and runtime-context snapshots are dropped: they are regenerated
 * every request and would drown real content in the episodic index.
 * @param {object[]} messages - output of `session.deriveMessages()`.
 * @returns {{role: string, text: string, tool_name?: string}[]}
 */
export function toTurns(messages) {
  const toolNames = new Map()
  const out = []
  for (const m of messages) {
    if (m.role === 'user' && m.source?.kind === 'user') {
      const text = blockText(m.content)
      if (text) out.push({ role: 'user', text })
    } else if (m.role === 'assistant') {
      const parts = []
      const text = blockText(m.content)
      if (text) parts.push(text)
      for (const b of m.content ?? []) {
        if (b.type !== 'tool-call') continue
        toolNames.set(b.id, b.name)
        parts.push(`[tool ${b.name}] ${clip(String(b.arguments ?? ''), 500)}`)
      }
      if (parts.length) out.push({ role: 'assistant', text: parts.join('\n') })
    } else if (m.role === 'tool') {
      const name = toolNames.get(m.toolCallId)
      out.push({ role: 'tool', text: clip(blockText(m.content), TOOL_TEXT_LIMIT), ...(name ? { tool_name: name } : {}) })
    }
  }
  return out
}

export async function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const args = ['-m', 'relay_memory', 'serve', '--root', cfg.root, '--cap-bytes', String(cfg.capBytes)]
  if (!cfg.reflect) args.push('--no-reflect')
  const env = { ...process.env, PYTHONPATH: [PACKAGE_DIR, process.env.PYTHONPATH].filter(Boolean).join(':') }
  const rpc = new RpcClient(cfg.python, args, env)
  ctx.effect(() => () => rpc.close())

  await rpc.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'dsh-relay-memory' } })
  let memoryText = (await rpc.request('relay/context')).text
  const refresh = async () => { memoryText = (await rpc.request('relay/context')).text }

  ctx.systemPrompt.context({
    name: 'relay-memory',
    order: 900,
    interpolate: false,
    text: () => `${GUIDE}\n\n${memoryText || '<memory>(empty)</memory>'}`,
  })

  const { tools } = await rpc.request('tools/list')
  for (const tool of tools) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(toolArgs, exec) {
        const sessionId = exec?.agent?.session?.header?.id ?? ''
        const result = await rpc.request('tools/call', { name: tool.name, arguments: toolArgs, _meta: { session_id: sessionId } })
        if (tool.name.startsWith('memory_')) await refresh()
        const text = blockText(result.content)
        if (result.isError) throw new Error(text)
        return text
      },
    })
  }

  // Number of derived messages already ingested, per session.
  const ingested = new Map()

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const session = agent.session
    const sessionId = session.header.id
    try {
      const messages = await session.deriveMessages()
      const fresh = toTurns(messages.slice(ingested.get(sessionId) ?? 0))
      ingested.set(sessionId, messages.length)
      if (!fresh.length) return
      const result = await rpc.request('relay/ingest', {
        session_id: sessionId,
        cwd: session.header.cwd ?? process.cwd(),
        messages: fresh,
        reflect: cfg.reflect,
      })
      if (result.error) ctx.logger?.warn?.(`relay-memory: ${result.error}`)
      await refresh()
    } catch (error) {
      // Memory is best-effort: a failed ingest must not fail the user's turn.
      ctx.logger?.warn?.(`relay-memory: ingest failed for ${sessionId}: ${error}`)
    }
  })
}
