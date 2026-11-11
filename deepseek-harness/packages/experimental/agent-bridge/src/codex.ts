/**
 * Codex export through Codex's own external-agent session importer: the
 * `externalAgentConfig/import` request of `codex app-server`. Importing a Claude
 * Code transcript creates a Codex thread; importing it again after it grew
 * appends the new messages to the same thread while that thread is idle and
 * unchanged in Codex, and is deferred otherwise.
 * @module @deepseek-ai/dsh-experimental-agent-bridge/codex
 */

import { spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { createInterface } from 'node:readline'

/** Outcome of one import request. */
export interface CodexImportResult {
  /** Codex thread holding the session, when the import created or extended one. */
  readonly threadId: string | null
  /** Codex's account of what happened, for the panel. */
  readonly detail: string
}

/** How to run Codex. */
export interface CodexRunner {
  /** Codex executable. */
  readonly command: string
  /** Codex's data directory (`CODEX_HOME`). */
  readonly home: string
  /** Claude Code's data directory; Codex detects transcripts under `$HOME/.claude/projects`. */
  readonly claudeHome: string
  /** Longest wait for one import. */
  readonly timeoutMs: number
}

interface RpcMessage { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }

/**
 * Import a Claude Code transcript into Codex, or extend the thread an earlier import created.
 * @param runner - how to run Codex.
 * @param source - Claude Code transcript; Codex requires it under `~/.claude/projects`.
 * @param cwd - working directory of the session.
 * @param signal - abandons the import.
 * @returns the thread and Codex's account.
 * @throws Error when Codex cannot be started or rejects the request.
 */
export async function importIntoCodex(runner: CodexRunner, source: string, cwd: string, signal: AbortSignal): Promise<CodexImportResult> {
  // Codex imports only transcripts it detects under `$HOME/.claude`, so HOME follows a relocated Claude Code home.
  const home = basename(runner.claudeHome) === '.claude' ? { HOME: dirname(runner.claudeHome), USERPROFILE: dirname(runner.claudeHome) } : {}
  const child = spawn(runner.command, ['app-server'], {
    cwd, env: { ...process.env, ...home, CODEX_HOME: runner.home }, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000) })
  const pending = new Map<number, (message: RpcMessage) => void>()
  const completed = Promise.withResolvers<Record<string, unknown>>()
  const exited = new Promise<never>((_resolve, reject) => {
    child.on('error', (error) => { reject(new Error(`could not start Codex (${runner.command}): ${error.message}`)) })
    child.on('exit', (code) => { reject(new Error(`Codex exited with code ${String(code)}: ${stderr.trim().split('\n').slice(-3).join(' ')}`)) })
  })
  void exited.catch(() => {})
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch (error) {
      // Codex writes only JSON-RPC lines on stdout; anything else is ignored.
      void error
      return
    }
    const waiting = message.id === undefined ? undefined : pending.get(message.id)
    if (waiting !== undefined && message.id !== undefined) {
      waiting(message)
      pending.delete(message.id)
    } else if (message.method === 'externalAgentConfig/import/completed') {
      completed.resolve(message.params ?? {})
    }
  })
  let next = 0
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const id = ++next
    const answer = new Promise<RpcMessage>((resolve) => { pending.set(id, resolve) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const message = await Promise.race([answer, exited])
    if (message.error !== undefined) throw new Error(`Codex rejected ${method}: ${message.error.message ?? 'unknown error'}`)
    return message.result
  }
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(runner.timeoutMs)])
  const aborted = new Promise<never>((_resolve, reject) => {
    timeout.addEventListener('abort', () => { reject(new Error('Codex import timed out or was cancelled')) }, { once: true })
  })
  void aborted.catch(() => {})
  try {
    await Promise.race([request('initialize', { clientInfo: { title: 'DeepSeek Harness', name: 'dsh-agent-bridge', version: '1' }, capabilities: { experimentalApi: false } }), aborted])
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`)
    await Promise.race([request('externalAgentConfig/import', {
      migrationItems: [{
        itemType: 'SESSIONS', description: 'DeepSeek Harness session', cwd: null,
        details: { plugins: [], sessions: [{ path: source, cwd, title: null }], mcpServers: [], hooks: [], subagents: [], commands: [] },
      }],
    }), aborted])
    const params = await Promise.race([completed.promise, exited, aborted])
    return importOutcome(params)
  } finally {
    child.stdin.end()
    child.kill()
  }
}

/**
 * Read the outcome of an import from Codex's completion notification.
 * @param params - `externalAgentConfig/import/completed` parameters.
 * @returns the thread, or null with Codex's reason when it deferred or failed.
 */
export function importOutcome(params: Record<string, unknown>): CodexImportResult {
  const results = Array.isArray(params.itemTypeResults) ? params.itemTypeResults as Record<string, unknown>[] : []
  for (const result of results) {
    const success = (Array.isArray(result.successes) ? result.successes as Record<string, unknown>[] : [])[0]
    if (typeof success?.target === 'string') return { threadId: success.target, detail: 'synced' }
    const failure = (Array.isArray(result.failures) ? result.failures as Record<string, unknown>[] : [])[0]
    if (failure !== undefined) {
      const reason = typeof failure.message === 'string' ? failure.message : typeof failure.error === 'string' ? failure.error : JSON.stringify(failure)
      return { threadId: null, detail: reason }
    }
  }
  return { threadId: null, detail: 'Codex left the thread unchanged: it is open in Codex or was continued there' }
}
