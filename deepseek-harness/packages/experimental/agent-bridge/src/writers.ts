/**
 * Writers that turn a DeepSeek Harness conversation into native session files:
 * a Claude Code transcript (`claude --resume <id>`) and a Gemini CLI chat
 * (`gemini --resume <id>`). Both are append-only, and every record carries the
 * bridge's marker so the readers can skip it when following the file.
 * @module @deepseek-ai/dsh-experimental-agent-bridge/writers
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { OWN_MARKER, claudeProjectKey, geminiProjectRoot } from './sources.ts'
import type { BridgeMessage } from './transcript.ts'

/** Version string written into exported Claude Code records. */
export const WRITER_VERSION = 'dsh-agent-bridge'

/**
 * A UUID derived from a name, so the same message always gets the same record id.
 * @param name - any stable text.
 * @returns a UUID-formatted string.
 */
export function stableUuid(name: string): string {
  const h = createHash('sha1').update(name).digest('hex')
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Where an exported Claude Code session lives. */
export interface ClaudeExport {
  readonly id: string
  readonly path: string
}

/**
 * Path of the Claude Code transcript for an exported session.
 * @param home - Claude Code's data directory.
 * @param cwd - working directory of the session.
 * @param id - Claude Code session id.
 * @returns the transcript location.
 */
export function claudeExport(home: string, cwd: string, id: string): ClaudeExport {
  return { id, path: join(home, 'projects', claudeProjectKey(cwd), `${id}.jsonl`) }
}

/**
 * Append messages to an exported Claude Code transcript, creating it with a title record.
 * @param target - transcript location.
 * @param cwd - working directory recorded on each record.
 * @param title - session title shown in Claude Code's resume picker.
 * @param messages - messages not written yet, oldest first.
 * @param parent - uuid of the last record written, or null for a new transcript.
 * @returns the uuid of the last record written.
 */
export function appendClaude(
  target: ClaudeExport, cwd: string, title: string, messages: readonly BridgeMessage[], parent: string | null,
): string | null {
  mkdirSync(dirname(target.path), { recursive: true })
  const lines: string[] = []
  if (parent === null && !existsSync(target.path)) {
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: target.id, [OWN_MARKER]: true }))
  }
  let last = parent
  for (const m of messages) {
    const uuid = stableUuid(`${target.id}:${m.key}`)
    const base = {
      parentUuid: last, isSidechain: false, userType: 'external', cwd, sessionId: target.id, version: WRITER_VERSION,
      uuid, timestamp: m.at ?? new Date().toISOString(), [OWN_MARKER]: true,
    }
    lines.push(JSON.stringify(m.role === 'user'
      ? { type: 'user', ...base, message: { role: 'user', content: m.text } }
      : {
        type: 'assistant', ...base,
        message: { id: `msg_${uuid.replaceAll('-', '')}`, type: 'message', role: 'assistant', model: 'deepseek', content: [{ type: 'text', text: m.text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }))
    last = uuid
  }
  if (lines.length > 0) appendFileSync(target.path, `${lines.join('\n')}\n`)
  return last
}

// ---------------------------------------------------------------- Gemini CLI

function normalizeRoot(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '') || 'project'
}

/**
 * Gemini CLI's per-project directory for a working directory, registering the project the way
 * Gemini CLI does when it has not seen it: a slug of the folder name in `projects.json`, with a
 * `.project_root` marker naming its owner.
 * @param home - Gemini CLI's data directory.
 * @param cwd - working directory.
 * @returns `~/.gemini/tmp/<slug>`.
 */
export function geminiProjectDir(home: string, cwd: string): string {
  const tmp = join(home, 'tmp')
  const registryPath = join(home, 'projects.json')
  const root = normalizeRoot(cwd)
  let registry: { projects: Record<string, string> } = { projects: {} }
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as { projects?: Record<string, string> }
    if (parsed.projects !== undefined && typeof parsed.projects === 'object') registry = { projects: parsed.projects }
  } catch (error) {
    // No registry yet: Gemini CLI has not run here, so this export creates it.
    void error
  }
  const owned = (slug: string): boolean => {
    const owner = geminiProjectRoot(join(tmp, slug))
    return owner === null || normalizeRoot(owner) === root
  }
  let slug = registry.projects[root]
  if (slug === undefined || !owned(slug)) {
    slug = undefined
    for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) {
      const owner = geminiProjectRoot(join(tmp, entry))
      if (owner !== null && normalizeRoot(owner) === root) slug = entry
    }
    if (slug === undefined) {
      const base = slugify(basename(root))
      const taken = new Set(Object.values(registry.projects))
      for (let n = 0; slug === undefined; n++) {
        const candidate = n === 0 ? base : `${base}-${n}`
        if (!taken.has(candidate) && geminiProjectRoot(join(tmp, candidate)) === null) slug = candidate
      }
    }
    registry.projects[root] = slug
    const temp = `${registryPath}.${randomUUID()}.tmp`
    mkdirSync(home, { recursive: true })
    writeFileSync(temp, JSON.stringify(registry, null, 2))
    renameSync(temp, registryPath)
  }
  const dir = join(tmp, slug)
  mkdirSync(join(dir, 'chats'), { recursive: true })
  if (geminiProjectRoot(dir) === null) writeFileSync(join(dir, '.project_root'), root)
  return dir
}

/**
 * Path of a new Gemini CLI chat file for an exported session.
 * @param projectDir - Gemini CLI's project directory.
 * @param id - Gemini session id.
 * @returns the chat file path, named as Gemini CLI names its own.
 */
export function geminiChatPath(projectDir: string, id: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/:/gu, '-')
  return join(projectDir, 'chats', `session-${stamp}-${id.slice(0, 8)}.jsonl`)
}

/**
 * Append messages to an exported Gemini CLI chat, creating it with its metadata record.
 * @param path - chat file.
 * @param id - Gemini session id.
 * @param cwd - project root.
 * @param messages - messages not written yet, oldest first.
 */
export function appendGemini(path: string, id: string, cwd: string, messages: readonly BridgeMessage[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const lines: string[] = []
  const now = new Date().toISOString()
  if (!existsSync(path)) {
    lines.push(JSON.stringify({
      sessionId: id, projectHash: createHash('sha256').update(cwd).digest('hex'), startTime: now, lastUpdated: now, kind: 'main', [OWN_MARKER]: true,
    }))
  }
  for (const m of messages) {
    lines.push(JSON.stringify({
      id: stableUuid(`${id}:${m.key}`), timestamp: m.at ?? now, type: m.role === 'user' ? 'user' : 'gemini',
      content: [{ text: m.text }], [OWN_MARKER]: true,
    }))
  }
  if (messages.length > 0) lines.push(JSON.stringify({ $set: { lastUpdated: now } }))
  if (lines.length > 0) appendFileSync(path, `${lines.join('\n')}\n`)
}
