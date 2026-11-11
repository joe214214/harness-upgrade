/**
 * Readers for the session files of Claude Code, Codex, and Gemini CLI. Each
 * keeps only model-visible conversation: harness-injected context, reasoning,
 * and sidechains are left out, and tool calls and results become notes.
 * @module @deepseek-ai/dsh-experimental-agent-bridge/sources
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { plainText, toolCallNote, toolResultNote } from './transcript.ts'
import type { BridgeMessage, ParsedSession } from './transcript.ts'
import type { ExternalAgent, ExternalSessionInfo } from './types.ts'

/** Where each agent keeps its data. */
export interface AgentHomes {
  readonly claude: string
  readonly codex: string
  readonly gemini: string
}

/** Marker field on records the bridge writes, so readers can tell its own records apart. */
export const OWN_MARKER = 'dshAgentBridge'

/**
 * Read a text file, decompressing `.zst` files.
 * @param path - file path.
 * @returns the text.
 */
export function readText(path: string): string {
  const bytes = readFileSync(path)
  return (path.endsWith('.zst') ? zstdDecompressSync(bytes) : bytes).toString('utf8')
}

function jsonLines(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) records.push(value as Record<string, unknown>)
    } catch (error) {
      // A torn final line is normal while the agent is still writing; it is read on the next poll.
      void error
    }
  }
  return records
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined)
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** Text the harness of an agent injects into user turns, which is not something the user wrote. */
function injected(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('<system-reminder>') || t.startsWith('<local-command') || t.startsWith('<command-') || t.startsWith('Caveat:')
    || t.startsWith('<environment_context>') || t.startsWith('<user_instructions>') || t.startsWith('# AGENTS.md instructions')
    || t.startsWith('<permissions instructions>') || t.startsWith('<turn_aborted>') || t.startsWith('<user_shell_command>')
}

// ---------------------------------------------------------------- Claude Code

/**
 * Claude Code's project directory name for a working directory.
 * @param cwd - absolute working directory.
 * @returns every character other than a letter or digit replaced by `-`.
 */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-')
}

/**
 * Parse a Claude Code transcript (`~/.claude/projects/<project>/<session>.jsonl`), following
 * `continued-in` records to the continuation file, which repeats the history and extends it.
 * @param path - transcript path.
 * @param own - also keep records the bridge wrote.
 * @returns the transcript.
 */
export function parseClaude(path: string, own = false): ParsedSession {
  let current = path
  const seen = new Set<string>()
  for (;;) {
    seen.add(current)
    const records = jsonLines(readText(current))
    const next = records.findLast(r => r.type === 'continued-in' && typeof r.continuedInSessionId === 'string')
    const target = next === undefined ? undefined : join(dirname(current), `${String(next.continuedInSessionId)}.jsonl`)
    if (target === undefined || seen.has(target) || !exists(target)) return claudeRecords(basename(path, '.jsonl'), records, own)
    current = target
  }
}

function claudeRecords(id: string, records: readonly Record<string, unknown>[], own: boolean): ParsedSession {
  let cwd: string | null = null
  let title: string | null = null
  const messages: BridgeMessage[] = []
  for (const r of records) {
    cwd ??= str(r.cwd) ?? null
    const named = r.type === 'custom-title' ? str(r.customTitle) : undefined
    const generated = r.type === 'ai-title' ? str(r.aiTitle) : r.type === 'summary' ? str(r.summary) : undefined
    if (named !== undefined && named !== '') title = named
    else if (generated !== undefined && generated !== '' && title === null) title = generated
    if (r.type !== 'user' && r.type !== 'assistant') continue
    if (r.isMeta === true || r.isSidechain === true || (r[OWN_MARKER] === true && !own)) continue
    const message = record(r.message)
    const key = str(r.uuid) ?? `line-${messages.length}`
    const at = str(r.timestamp)
    const content = message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.map(record).filter(b => b !== undefined) : []
    const parts: string[] = []
    let toolOnly = blocks.length > 0
    for (const block of blocks) {
      if (block.type === 'text' && str(block.text)) {
        if (r.type === 'user' && injected(block.text as string)) continue
        parts.push(block.text as string)
        toolOnly = false
      } else if (block.type === 'tool_use') {
        parts.push(toolCallNote(str(block.name) ?? 'tool', block.input))
        toolOnly = false
      } else if (block.type === 'tool_result') {
        parts.push(toolResultNote(plainText(block.content), block.is_error === true))
      }
    }
    const text = parts.join('\n\n').trim()
    if (text === '') continue
    const role = r.type === 'assistant' ? 'assistant' : toolOnly ? 'tool' : 'user'
    messages.push({ key, role, text, ...at === undefined ? {} : { at } })
  }
  return { id, cwd, title: title ?? firstPrompt(messages), messages }
}

function claudeFiles(home: string): string[] {
  const root = join(home, 'projects')
  return dirEntries(root).flatMap(project => dirEntries(join(root, project))
    .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
    .map(file => join(root, project, file)))
}

// ---------------------------------------------------------------- Codex

/**
 * Parse a Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`).
 * @param path - rollout path.
 * @returns the transcript; message keys are line numbers, since rollouts are append-only.
 */
export function parseCodex(path: string): ParsedSession {
  const records = jsonLines(readText(path))
  let id = basename(path).replace(/\.jsonl(\.zst)?$/u, '').replace(/^rollout-[\dT:-]+-/u, '')
  let cwd: string | null = null
  const messages: BridgeMessage[] = []
  records.forEach((r, line) => {
    const payload = record(r.payload)
    if (payload === undefined) return
    if (r.type === 'session_meta') {
      id = str(payload.id) ?? id
      cwd = str(payload.cwd) ?? cwd
      return
    }
    if (r.type !== 'response_item') return
    const at = str(r.timestamp)
    const push = (role: BridgeMessage['role'], text: string): void => {
      if (text.trim() !== '') messages.push({ key: `line-${line}`, role, text: text.trim(), ...at === undefined ? {} : { at } })
    }
    switch (payload.type) {
      case 'message': {
        if (payload.role !== 'user' && payload.role !== 'assistant') return
        const text = plainText(payload.content)
        if (payload.role === 'user' && injected(text)) return
        push(payload.role, text)
        return
      }
      case 'function_call':
      case 'custom_tool_call':
        push('assistant', toolCallNote(str(payload.name) ?? 'tool', parseMaybeJson(payload.arguments ?? payload.input)))
        return
      case 'local_shell_call':
        push('assistant', toolCallNote('shell', record(payload.action)?.command ?? payload.action))
        return
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const output = record(payload.output)
        push('tool', toolResultNote(output === undefined ? plainText(payload.output) : plainText(output.content ?? output)))
        return
      }
      case 'web_search_call':
        push('assistant', toolCallNote('web_search', record(payload.action)?.query ?? payload.action))
        return
      default:
    }
  })
  return { id, cwd, title: firstPrompt(messages), messages }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (error) {
    // Free-form tool input is shown as written.
    void error
    return value
  }
}

/**
 * Codex thread names by thread id, from Codex's thread-name index.
 * @param home - Codex's data directory (`CODEX_HOME`).
 * @returns names; empty when Codex has named no thread.
 */
export function codexThreadNames(home: string): Map<string, string> {
  const names = new Map<string, string>()
  try {
    for (const r of jsonLines(readText(join(home, 'session_index.jsonl')))) {
      const id = str(r.id)
      const name = str(r.thread_name)
      if (id !== undefined && name !== undefined && name !== '') names.set(id, name)
    }
  } catch (error) {
    // No thread names yet: sessions are titled by their first prompt.
    void error
  }
  return names
}

function codexFiles(home: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    for (const entry of dirEntries(dir)) {
      const path = join(dir, entry)
      if (depth < 3) walk(path, depth + 1)
      else if (/^rollout-.*\.jsonl(\.zst)?$/u.test(entry)) found.push(path)
    }
  }
  walk(join(home, 'sessions'), 0)
  return found
}

// ---------------------------------------------------------------- Gemini CLI

/**
 * Parse a Gemini CLI chat (`~/.gemini/tmp/<project>/chats/session-*.jsonl`, or a legacy `.json`
 * whole-conversation file), replaying `$set`, `$patch`, and `$rewindTo` records as Gemini does.
 * @param path - chat file path.
 * @param own - also keep messages the bridge wrote.
 * @returns the transcript; message keys are Gemini's message ids.
 */
export function parseGemini(path: string, own = false): ParsedSession {
  const text = readText(path)
  let meta: Record<string, unknown> = {}
  const messages = new Map<string, Record<string, unknown>>()
  const put = (m: Record<string, unknown>): void => {
    const id = str(m.id)
    if (id !== undefined) messages.set(id, { ...messages.get(id), ...m })
  }
  if (path.endsWith('.json')) {
    const whole = record(JSON.parse(text)) ?? {}
    meta = whole
    for (const m of Array.isArray(whole.messages) ? whole.messages : []) if (record(m)) put(m as Record<string, unknown>)
  } else {
    for (const r of jsonLines(text)) {
      if (typeof r.$rewindTo === 'string') {
        let found = false
        for (const id of [...messages.keys()]) {
          if (id === r.$rewindTo) found = true
          if (found) messages.delete(id)
        }
        if (!found) messages.clear()
      } else if (record(r.$patch)) {
        const patch = r.$patch as Record<string, unknown>
        const updates: unknown[] = Array.isArray(patch.updates) ? patch.updates : []
        for (const p of [patch, ...updates]) {
          const id = str(record(p)?.id)
          const existing = id === undefined ? undefined : messages.get(id)
          if (existing === undefined) continue
          const update = p as Record<string, unknown>
          if (update.content !== undefined) existing.content = update.content
          if (Array.isArray(update.toolCalls) && Array.isArray(existing.toolCalls)) {
            for (const tc of update.toolCalls as Record<string, unknown>[]) {
              const target = (existing.toolCalls as Record<string, unknown>[]).find(t => t.id === tc.id)
              if (target !== undefined && 'result' in tc) target.result = tc.result
            }
          }
        }
        for (const id of Array.isArray(patch.removeIds) ? patch.removeIds : []) messages.delete(String(id))
      } else if (record(r.$set)) {
        meta = { ...meta, ...r.$set as Record<string, unknown> }
      } else if (typeof r.id === 'string' && typeof r.type === 'string') {
        put(r)
      } else if (typeof r.sessionId === 'string') {
        meta = { ...meta, ...r }
      }
    }
  }
  const out: BridgeMessage[] = []
  for (const [key, m] of messages) {
    if (m[OWN_MARKER] === true && !own) continue
    const at = str(m.timestamp)
    const stamp = at === undefined ? {} : { at }
    if (m.type === 'user') {
      const body = geminiText(m.content)
      if (body !== '' && !injected(body)) out.push({ key, role: 'user', text: body, ...stamp })
    } else if (m.type === 'gemini') {
      const parts = [geminiText(m.content)]
      const results: string[] = []
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls as Record<string, unknown>[] : []) {
        parts.push(toolCallNote(str(tc.name) ?? 'tool', tc.args))
        if (tc.result !== undefined && tc.result !== null) results.push(toolResultNote(geminiResult(tc.result), tc.status === 'error'))
      }
      const body = parts.filter(Boolean).join('\n\n').trim()
      if (body !== '') out.push({ key, role: 'assistant', text: body, ...stamp })
      if (results.length > 0) out.push({ key: `${key}#results`, role: 'tool', text: results.join('\n\n'), ...stamp })
    }
  }
  const id = str(meta.sessionId) ?? basename(path).replace(/\.jsonl?$/u, '')
  return { id, cwd: geminiProjectRoot(dirname(dirname(path))), title: str(meta.summary) ?? firstPrompt(out), messages: out }
}

function geminiText(content: unknown): string {
  if (Array.isArray(content)) return content.map(p => (record(p)?.thought === true ? '' : plainText([p]))).filter(Boolean).join('\n').trim()
  return plainText(content).trim()
}

function geminiResult(result: unknown): string {
  const parts = Array.isArray(result) ? result : [result]
  return parts.map((p) => {
    const response = record(record(p)?.functionResponse)?.response
    return response === undefined ? plainText(p) : plainText(record(response)?.output ?? response)
  }).join('\n')
}

/**
 * The project root a Gemini CLI project directory belongs to.
 * @param projectDir - `~/.gemini/tmp/<project>`.
 * @returns the root from its `.project_root` marker, or null.
 */
export function geminiProjectRoot(projectDir: string): string | null {
  try {
    return readFileSync(join(projectDir, '.project_root'), 'utf8').trim() || null
  } catch (error) {
    // Older Gemini CLI versions named project directories by hash and wrote no marker.
    void error
    return null
  }
}

function geminiFiles(home: string): string[] {
  const root = join(home, 'tmp')
  return dirEntries(root).flatMap(project => dirEntries(join(root, project, 'chats'))
    .filter(file => /^session-.*\.jsonl?$/u.test(file))
    .map(file => join(root, project, 'chats', file)))
}

// ---------------------------------------------------------------- shared

/** Readers by agent; `own` also keeps records the bridge wrote. */
export const PARSERS: Readonly<Record<ExternalAgent, (path: string, own?: boolean) => ParsedSession>> = {
  claude: parseClaude,
  codex: path => parseCodex(path),
  gemini: parseGemini,
}

/**
 * Every session file of every agent.
 * @param homes - each agent's data directory.
 * @returns agent and path of each file.
 */
export function sessionFiles(homes: AgentHomes): { agent: ExternalAgent; path: string }[] {
  return [
    ...claudeFiles(homes.claude).map(path => ({ agent: 'claude' as const, path })),
    ...codexFiles(homes.codex).map(path => ({ agent: 'codex' as const, path })),
    ...geminiFiles(homes.gemini).map(path => ({ agent: 'gemini' as const, path })),
  ]
}

/**
 * Summarise one session file for listing.
 * @param agent - agent that wrote it.
 * @param path - session file.
 * @param codexNames - Codex thread names, used as Codex titles.
 * @returns the listing entry; an unreadable file is listed by its file name.
 */
export function summarize(agent: ExternalAgent, path: string, codexNames: ReadonlyMap<string, string>): ExternalSessionInfo {
  const stat = statSync(path)
  let parsed: ParsedSession | undefined
  let exported = false
  try {
    parsed = PARSERS[agent](path, true)
    exported = readText(path).includes(`"${OWN_MARKER}":true`)
  } catch (error) {
    // An unreadable file is still listed, by name, so the user can see it exists.
    void error
  }
  const id = parsed?.id ?? basename(path).replace(/\.jsonl?(\.zst)?$/u, '')
  const title = (agent === 'codex' ? codexNames.get(id) : undefined) ?? parsed?.title ?? basename(path)
  const oneLine = title.replace(/\s+/gu, ' ').trim()
  return { agent, id, path, cwd: parsed?.cwd ?? null, title: oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine, updatedAt: stat.mtimeMs, exported }
}

function firstPrompt(messages: readonly BridgeMessage[]): string | null {
  const first = messages.find(m => m.role === 'user')
  return first === undefined ? null : first.text.replace(/\s+/gu, ' ').trim()
}

function dirEntries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch (error) {
    // The agent is not installed, or has not written this directory yet.
    void error
    return []
  }
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    // A continuation that was never written leaves the original as the whole session.
    void error
    return false
  }
}
