/**
 * Agent bridge: sessions and memory shared live between DeepSeek Harness and
 * Claude Code, Codex, and Gemini CLI on the same machine.
 *
 * - Open: an external session is delivered into a DeepSeek Harness Session as
 *   relayed context, then followed: each message the other agent adds is relayed
 *   at the next step boundary, without waking the agent.
 * - Share: a DeepSeek Harness Session is written live as a native Claude Code
 *   transcript and Gemini CLI chat, and imported into Codex through Codex's own
 *   importer; whatever the other agent then adds is relayed back.
 * - Memory: the other agents' memory is offered to the model with the agent and path of each file,
 *   and DeepSeek Harness's MEMORY.md is written into theirs.
 * @module @deepseek-ai/dsh-experimental-agent-bridge
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { importIntoCodex } from './codex.ts'
import { agentBridgeTools } from './tools.ts'
import {
  memoryContext, memoryFiles, memorySources, parseMemoryFacts, planMemory, readSource, removeCodexExtension, sessionDirectories, writeBlock,
  writeCodexExtension,
} from './memory.ts'
import { PARSERS, codexFiles, codexThreadNames, sessionFiles, summarize } from './sources.ts'
import type { AgentHomes } from './sources.ts'
import { AGENT_NAMES, changeSince, clip, fingerprint, renderMessages, toolCallNote, toolResultNote } from './transcript.ts'
import type { BridgeMessage } from './transcript.ts'
import { appendClaude, appendGemini, claudeExport, geminiChatPath, geminiProjectDir, stableUuid } from './writers.ts'
import type { BridgeState, ExportState, ExternalAgent, ExternalSessionInfo, FollowState, MemoryExportState } from './types.ts'

export type * from './types.ts'
export { AGENT_NAMES, changeSince, fingerprint, renderMessages } from './transcript.ts'
export type { BridgeMessage, ParsedSession } from './transcript.ts'
export { OWN_MARKER, claudeProjectKey, parseClaude, parseCodex, parseGemini } from './sources.ts'
export type { AgentHomes } from './sources.ts'
export { appendClaude, appendGemini, claudeExport, geminiProjectDir, stableUuid } from './writers.ts'
export { BLOCK_END, BLOCK_START, PROJECT_SECTIONS, factsBlock, memoryFiles, memorySources, parseMemoryFacts, planMemory, stripBlock } from './memory.ts'
export type { Fact, MemoryPlan } from './memory.ts'
export { importIntoCodex, importOutcome } from './codex.ts'
export { agentBridgeTools } from './tools.ts'
export type { BridgeToolOps } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Sessions and memory shared with other coding agents. */
    agentBridge: AgentBridge
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Messages of another agent's session, relayed into this Session by agent-bridge.
     * `senderSessionId` names the agent and session for the relay row.
     * Readers preserve this message without the producer, which never reads the kind back.
     * @persistenceAttribution
     */
    'dsh-agent-bridge': { kind: 'dsh-agent-bridge'; senderSessionId: string } & ContextFormed
  }
}

/** Deployment settings: where each agent keeps its data, budgets, and what to share. */
export interface Config {
  /** Claude Code's data directory; omission uses `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeHome?: string | undefined
  /** Codex's data directory; omission uses `CODEX_HOME` or `~/.codex`. */
  codexHome?: string | undefined
  /** Gemini CLI's data directory; omission uses `~/.gemini`. */
  geminiHome?: string | undefined
  /** Where the bridge keeps what it follows and shares. */
  stateDir: string
  /** DeepSeek Harness's long-term memory file to share; empty disables memory sharing. */
  memoryFile: string
  /** Write DeepSeek Harness memory into each agent. */
  shareMemoryWith: ExternalAgent[]
  /** Codex executable used for Codex export. */
  codexCommand: string
  /** Longest wait for one Codex import. */
  codexTimeoutMs: number
  /** How often followed sessions and the memory file are checked. */
  pollMs: number
  /** Most sessions listed. */
  listLimit: number
  /** Characters of transcript delivered when a session is opened. */
  openChars: number
  /** Characters of new messages delivered in one update. */
  updateChars: number
  /** Characters of external memory previews in the runtime context. */
  memoryContextChars: number
}

const AGENTS = ['claude', 'codex', 'gemini'] as const
const optionalString = z.union([z.string().min(1), z.const(undefined)])

/** Persisted follow of an external session file into a Session. */
interface FollowRecord {
  sessionId: string
  agent: ExternalAgent
  id: string
  path: string
  title: string
  /** Keys of the messages already delivered, in order. */
  delivered: string[]
  stamp: string
  status: FollowState['status']
  error: string | null
}

/** Persisted live export of a Session to one agent. */
interface ExportRecord {
  sessionId: string
  agent: ExternalAgent
  cwd: string
  /** The agent's session id: Claude Code and Gemini ids are derived from the Session id; Codex's is its thread id. */
  id: string | null
  path: string | null
  /** Claude Code: uuid of the last record written. */
  parent: string | null
  /** Keys of the Session messages written. */
  written: string[]
  status: ExportState['status']
  detail: string | null
  updatedAt: number
}

interface Persisted {
  follows: FollowRecord[]
  exports: ExportRecord[]
  /** Fingerprints of messages written by exports, per Session, so followers skip them. */
  own: Record<string, string[]>
  /** Files holding a memory block the bridge wrote, so stale blocks can be removed. */
  memoryPaths: string[]
}

/** Resolve each agent's data directory from config and the environment. */
function resolveHomes(config: Config): AgentHomes {
  return {
    claude: config.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    codex: config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    gemini: config.geminiHome ?? join(homedir(), '.gemini'),
  }
}

/** Command that continues a shared session in its agent. */
function resumeCommand(agent: ExternalAgent, id: string | null): string | null {
  if (id === null) return null
  return agent === 'claude' ? `claude --resume ${id}` : agent === 'codex' ? `codex resume ${id}` : `gemini --resume ${id}`
}

/** Owner of followed and shared sessions and of memory sharing. */
export default class AgentBridge extends TypertRemoteService {
  static inject = ['tools', 'systemPrompt', 'typert']
  static Config: z<Partial<Config>, Config> = z.object({
    claudeHome: optionalString,
    codexHome: optionalString,
    geminiHome: optionalString,
    stateDir: z.string().min(1).default(join(homedir(), '.dsh-agent-bridge')),
    memoryFile: z.string().default(join(homedir(), '.dsh-memory', 'MEMORY.md')),
    shareMemoryWith: z.array(z.union([z.const('claude'), z.const('codex'), z.const('gemini')])).default([...AGENTS]),
    codexCommand: z.string().min(1).default('codex'),
    codexTimeoutMs: z.natural().min(1000).default(120_000),
    pollMs: z.natural().min(200).default(1500),
    listLimit: z.natural().min(1).default(40),
    openChars: z.natural().min(1000).default(30_000),
    updateChars: z.natural().min(500).default(12_000),
    memoryContextChars: z.natural().default(2000),
  })

  /** Data directories of Claude Code, Codex, and Gemini CLI that the bridge reads and writes. */
  readonly homes: AgentHomes
  private state: Persisted = { follows: [], exports: [], own: {}, memoryPaths: [] }
  private readonly summaries = new Map<string, { stamp: string; info: ExternalSessionInfo }>()
  private memoryStamp = ''
  private memoryPlan = ''
  private memoryExports: MemoryExportState[] = []
  private readonly listeners = new Set<() => void>()
  private busy: Promise<void> = Promise.resolve()
  private ticks = 0
  private readonly exporting = new Map<string, Promise<void>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'agentBridge', { namespace: 'agentBridge' })
    this.homes = resolveHomes(config)

    ctx.systemPrompt.section({
      name: 'tool:agent_bridge',
      order: ctx.systemPrompt.getSectionOrder('TOOL_AGENT_BRIDGE'),
      interpolate: false,
      text: ({ scope }) => ctx.tools.get('open_external_session', scope) === undefined
        ? ''
        : 'Claude Code, Codex, and Gemini CLI on this machine keep their own sessions and memory. When the user refers to work done in one of them, '
          + 'find it with external_sessions and open it with open_external_session; while it is followed, messages the other agent adds arrive as '
          + '<external_session_update>. To continue this conversation in another agent, use share_session and give the user its resume command.',
    })
    ctx.systemPrompt.context({
      name: 'agent-bridge:memory',
      order: ctx.systemPrompt.getContextOrder('EXTERNAL_AGENT_MEMORY'),
      interpolate: false,
      text: ({ agent }) => memoryContext(memorySources(this.homes, agent?.session.header.cwd ?? null), config.memoryContextChars),
    })

    for (const tool of this.tools()) ctx.tools.register(tool)

    // Each finished turn is written to the agents this Session is shared with.
    ctx.on('agent/turn-stopping', ({ agent }) => {
      if (this.state.exports.some(e => e.sessionId === agent.session.header.id)) void this.exportSession(agent)
    })
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    await this.load()
    const timer = setInterval(() => { this.tick() }, this.config.pollMs)
    yield async () => {
      clearInterval(timer)
      await this.busy
      await Promise.all(this.exporting.values())
    }
    this.tick()
  }

  // ------------------------------------------------------------- Remote API

  /**
   * Follow the bridge's state: sessions found, follows, exports, and memory.
   * @param signal - Client observation lifetime.
   * @returns the current state, then each change.
   */
  @Remote({ mode: 'stream' })
  async* follow(signal: AbortSignal): AsyncIterable<BridgeState> {
    let wake = Promise.withResolvers<undefined>()
    const notify = (): void => { wake.resolve(undefined) }
    this.listeners.add(notify)
    signal.addEventListener('abort', notify, { once: true })
    try {
      while (!signal.aborted) {
        yield this.snapshot()
        await wake.promise
        wake = Promise.withResolvers<undefined>()
      }
    } finally {
      this.listeners.delete(notify)
      signal.removeEventListener('abort', notify)
    }
  }

  /** Rescan the agents' session directories. */
  @Remote
  refresh(): void {
    this.changed()
  }

  /**
   * Open an external session in a Session and follow it. The agent is asked to summarise where it stands.
   * @param sessionId - DeepSeek Harness Session.
   * @param agent - external agent.
   * @param id - the agent's session id.
   * @throws RemoteError when the Session is not loaded or the external session is not found.
   */
  @Remote
  open(sessionId: string, agent: ExternalAgent, id: string): void {
    const target = this.ctx.get('agents')?.get(SessionId(sessionId))
    if (target === undefined) throw new RemoteError('agent-bridge/no-session', 'Open the conversation first', { sessionId })
    const info = this.find(agent, id)
    if (info === undefined) throw new RemoteError('agent-bridge/not-found', `No ${AGENT_NAMES[agent]} session ${id}`, { agent, id })
    const text = this.openText(info, sessionId)
    target.steer(createUserMessage({
      content: [{ type: 'text', text: `${text}\n\nThe user opened this ${AGENT_NAMES[agent]} session here. Briefly summarise where it stands and what was being worked on; do not act until the user asks.` }],
      source: this.relaySource(info),
    }))
  }

  /**
   * Stop following an external session.
   * @param sessionId - DeepSeek Harness Session.
   * @param agent - external agent.
   * @param id - the agent's session id.
   */
  @Remote
  unfollow(sessionId: string, agent: ExternalAgent, id: string): void {
    this.state.follows = this.state.follows.filter(f => !(f.sessionId === sessionId && f.agent === agent && f.id === id))
    this.save()
    this.changed()
  }

  /**
   * Share a Session live with one agent, or stop sharing it.
   * @param sessionId - DeepSeek Harness Session.
   * @param agent - external agent.
   * @param enabled - whether to share.
   * @throws RemoteError when enabling for a Session that is not loaded.
   */
  @Remote
  async share(sessionId: string, agent: ExternalAgent, enabled: boolean): Promise<void> {
    if (!enabled) {
      const record = this.state.exports.find(e => e.sessionId === sessionId && e.agent === agent)
      this.state.exports = this.state.exports.filter(e => e !== record)
      if (record?.path != null) this.state.follows = this.state.follows.filter(f => !(f.sessionId === sessionId && f.path === record.path))
      this.save()
      this.changed()
      return
    }
    const target = this.ctx.get('agents')?.get(SessionId(sessionId))
    if (target === undefined) throw new RemoteError('agent-bridge/no-session', 'Open the conversation first', { sessionId })
    this.enableExport(target, agent)
    await this.exportSession(target)
  }

  /** Write DeepSeek Harness memory into the other agents now. */
  @Remote
  syncMemory(): void {
    this.memoryStamp = ''
    this.shareMemory()
  }

  // ------------------------------------------------------------- tools

  private tools(): ToolDefinition[] {
    return agentBridgeTools({
      list: (agent, query, cwd) => this.listText(agent, query, cwd),
      open: (agent, id, sessionId) => {
        const info = this.find(agent, id)
        if (info === undefined) throw new Error(`no ${agent} session ${id}; list them with external_sessions`)
        return this.openText(info, sessionId)
      },
      read: (agent, id, start, count) => {
        const info = this.find(agent, id)
        if (info === undefined) throw new Error(`no ${agent} session ${id}`)
        const messages = PARSERS[info.agent](info.path).messages
        const slice = messages.slice(start, start + count)
        const { text: body } = renderMessages(slice, info.agent, this.config.openChars)
        return `Messages ${start}–${start + slice.length - 1} of ${messages.length}:\n\n${body}`
      },
      share: async (agent, targets) => {
        for (const name of targets) this.enableExport(agent, name)
        await this.exportSession(agent)
        return this.state.exports.filter(e => e.sessionId === agent.session.header.id).map((e) => {
          const resume = resumeCommand(e.agent, e.id)
          const usable = resume !== null && e.status !== 'unavailable' && e.status !== 'error'
          return `${AGENT_NAMES[e.agent]}: ${e.status}${usable ? ` — continue with \`${resume}\` in ${e.cwd}` : ''}${e.detail === null ? '' : ` (${e.detail})`}`
        }).join('\n')
      },
      memory: (path, cwd) => {
        const sources = memorySources(this.homes, cwd)
        if (path === undefined) return sources.map(s => `${AGENT_NAMES[s.agent]} ${s.scope} ${s.kind}: ${s.path}`).join('\n') || 'no external memory found'
        const source = sources.find(s => s.path === path)
        if (source === undefined) throw new Error('not an external memory file; list them with external_memory without a path')
        return readSource(source, 60_000)
      },
    })
  }

  // ------------------------------------------------------------- sessions

  /** All external sessions, newest first, from a cache refreshed by file size and time. */
  private sessions(): ExternalSessionInfo[] {
    const names = codexThreadNames(this.homes.codex)
    const seen = new Set<string>()
    const out: ExternalSessionInfo[] = []
    for (const { agent, path } of sessionFiles(this.homes)) {
      seen.add(path)
      const stamp = fileStamp(path)
      let cached = this.summaries.get(path)
      if (cached?.stamp !== stamp) {
        const info = summarize(agent, path, names)
        if (info === undefined) continue
        cached = { stamp, info }
        this.summaries.set(path, cached)
      }
      out.push(cached.info)
    }
    for (const path of this.summaries.keys()) if (!seen.has(path)) this.summaries.delete(path)
    // Codex rollouts carry no bridge marker; an export's own record names them.
    const shared = new Set(this.state.exports.map(e => e.path))
    return out.map(s => (shared.has(s.path) ? { ...s, exported: true } : s)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private find(agent: ExternalAgent, id: string): ExternalSessionInfo | undefined {
    const all = this.sessions().filter(s => s.agent === agent)
    return all.find(s => s.id === id) ?? all.find(s => s.id.startsWith(id))
  }

  private listText(agent: ExternalAgent | undefined, query: string | undefined, cwd: string | null): string {
    const words = (query ?? '').toLowerCase().split(/\s+/u).filter(Boolean)
    // Sessions matching more query words come first, then those of the current workspace, then the newest.
    const score = (s: ExternalSessionInfo): number => words.filter(w => `${s.title} ${s.cwd ?? ''}`.toLowerCase().includes(w)).length
    const matching = this.sessions()
      .filter(s => agent === undefined || s.agent === agent)
      .map(s => ({ s, score: score(s) }))
      .filter(m => words.length === 0 || m.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.s.cwd === cwd) - Number(a.s.cwd === cwd) || b.s.updatedAt - a.s.updatedAt)
      .slice(0, this.config.listLimit)
      .map(m => m.s)
    if (matching.length === 0) return 'no sessions found'
    return matching.map(s => `${s.agent} ${s.id} — "${s.title}" — ${s.cwd ?? 'unknown directory'} — updated ${new Date(s.updatedAt).toISOString().slice(0, 16)}`
      + (s.exported ? ' (shared from DeepSeek Harness)' : '')).join('\n')
  }

  private relaySource(info: Pick<ExternalSessionInfo, 'agent' | 'title'>): { kind: 'dsh-agent-bridge'; form: 'relay'; senderSessionId: string } {
    return { kind: 'dsh-agent-bridge', form: 'relay', senderSessionId: `${AGENT_NAMES[info.agent]} · ${info.title}` }
  }

  /**
   * The transcript delivered when a session is opened; registers the follow when a Session is given.
   * @param info - the external session.
   * @param sessionId - Session to follow it into, or null to read only.
   * @returns model-facing text.
   */
  private openText(info: ExternalSessionInfo, sessionId: string | null): string {
    const parsed = PARSERS[info.agent](info.path)
    const messages = this.withoutOwn(parsed.messages, sessionId)
    const { text, omitted } = renderMessages(messages, info.agent, this.config.openChars)
    if (sessionId !== null) {
      this.state.follows = this.state.follows.filter(f => !(f.sessionId === sessionId && f.path === info.path))
      this.state.follows.push({
        sessionId, agent: info.agent, id: info.id, path: info.path, title: info.title,
        delivered: messages.map(m => m.key), stamp: fileStamp(info.path), status: 'following', error: null,
      })
      this.save()
      this.changed()
    }
    return [
      `<external_session agent="${AGENT_NAMES[info.agent]}" id="${info.id}" title="${info.title}" cwd="${info.cwd ?? ''}" messages="${messages.length}">`,
      omitted > 0 ? `(${omitted} earlier messages not shown; read them with read_external_session)` : '',
      text,
      '</external_session>',
      sessionId === null ? '' : `Following: new messages in this ${AGENT_NAMES[info.agent]} session will be relayed here.`,
    ].filter(Boolean).join('\n')
  }

  private withoutOwn(messages: readonly BridgeMessage[], sessionId: string | null): BridgeMessage[] {
    const own = new Set(sessionId === null ? [] : this.state.own[sessionId] ?? [])
    return own.size === 0 ? [...messages] : messages.filter(m => !own.has(fingerprint(m)))
  }

  // ------------------------------------------------------------- polling

  private tick(): void {
    // An open panel sees new and changed sessions of the other agents every few polls.
    if (this.listeners.size > 0 && ++this.ticks % 4 === 0) this.changed()
    this.busy = this.busy.then(() => {
      this.pollFollows()
      this.shareMemory()
    }).catch((error: unknown) => {
      this.ctx.logger('agent-bridge').warn(`agent-bridge: poll failed: ${String(error)}`)
    })
  }

  private pollFollows(): void {
    let dirty = false
    for (const follow of this.state.follows) {
      const stamp = fileStamp(follow.path)
      if (stamp === '') {
        if (follow.status !== 'missing') { follow.status = 'missing'; dirty = true }
        continue
      }
      const agent = this.ctx.get('agents')?.get(SessionId(follow.sessionId))
      if (stamp === follow.stamp && (agent === undefined) === (follow.status === 'waiting')) continue
      if (agent === undefined) {
        if (follow.status !== 'waiting') { follow.status = 'waiting'; dirty = true }
        continue
      }
      try {
        const messages = this.withoutOwn(PARSERS[follow.agent](follow.path).messages, follow.sessionId)
        const change = changeSince(follow.delivered, messages)
        if (change.added.length > 0 || change.dropped > 0) agent.send(this.updateMessage(follow, change.added, change.dropped), 'next-step', false)
        follow.delivered = messages.map(m => m.key)
        follow.stamp = stamp
        follow.status = 'following'
        follow.error = null
      } catch (error) {
        // Retried when the file changes again, not on every poll.
        follow.error = String(error)
        follow.stamp = stamp
      }
      dirty = true
    }
    if (dirty) {
      this.save()
      this.changed()
    }
  }

  private updateMessage(follow: FollowRecord, added: readonly BridgeMessage[], dropped: number): ReturnType<typeof createUserMessage> {
    const { text, omitted } = renderMessages(added, follow.agent, this.config.updateChars)
    const body = [
      `<external_session_update agent="${AGENT_NAMES[follow.agent]}" id="${follow.id}" title="${follow.title}">`,
      dropped > 0 ? `The session was rewound or edited there: ${dropped} message(s) you saw earlier are no longer in it.` : '',
      added.length > 0 ? `New messages since the last update${omitted > 0 ? ` (${omitted} older new messages not shown; use read_external_session)` : ''}:` : '',
      text,
      '</external_session_update>',
    ].filter(Boolean).join('\n')
    return createUserMessage({ content: [{ type: 'text', text: body }], source: this.relaySource(follow) })
  }

  // ------------------------------------------------------------- export

  private enableExport(agent: Agent, target: ExternalAgent): void {
    const sessionId = agent.session.header.id
    if (this.state.exports.some(e => e.sessionId === sessionId && e.agent === target)) return
    this.state.exports.push({
      sessionId, agent: target, cwd: agent.session.header.cwd ?? process.cwd(), id: null, path: null, parent: null, written: [],
      status: 'pending', detail: null, updatedAt: Date.now(),
    })
    this.save()
    this.changed()
  }

  /** Write a Session's new messages to every agent it is shared with; one export per Session runs at a time. */
  private exportSession(agent: Agent): Promise<void> {
    const sessionId = agent.session.header.id
    const previous = this.exporting.get(sessionId) ?? Promise.resolve()
    const run = previous.then(() => this.exportNow(agent)).catch((error: unknown) => {
      this.ctx.logger('agent-bridge').warn(`agent-bridge: export of ${sessionId} failed: ${String(error)}`)
    }).finally(() => {
      if (this.exporting.get(sessionId) === run) this.exporting.delete(sessionId)
    })
    this.exporting.set(sessionId, run)
    return run
  }

  private async exportNow(agent: Agent): Promise<void> {
    const sessionId = agent.session.header.id
    const messages = sessionMessages(agent)
    const title = `DeepSeek: ${clip((messages.find(m => m.role === 'user')?.text ?? 'conversation').replace(/\s+/gu, ' '), 60)}`
    const own = new Set(this.state.own[sessionId] ?? [])
    for (const m of messages) own.add(fingerprint(m))
    this.state.own[sessionId] = [...own]
    const records = this.state.exports.filter(e => e.sessionId === sessionId)
    const claudeNeeded = records.some(e => e.agent === 'claude' || e.agent === 'codex')
    const claude = claudeExport(this.homes.claude, records[0]?.cwd ?? process.cwd(), stableUuid(`dsh:${sessionId}`))
    let claudeParent: string | null = null
    if (claudeNeeded) {
      // Codex imports the Claude Code transcript, so it is kept current for either target.
      const record = records.find(e => e.agent === 'claude') ?? records.find(e => e.agent === 'codex')
      if (record === undefined) return
      const shared = this.claudeWriter(sessionId)
      const fresh = messages.filter(m => !shared.written.has(m.key))
      shared.parent = appendClaude(claude, record.cwd, title, fresh, shared.parent)
      for (const m of fresh) shared.written.add(m.key)
      claudeParent = shared.parent
    }
    for (const record of records) {
      try {
        if (record.agent === 'claude') {
          Object.assign(record, { id: claude.id, path: claude.path, parent: claudeParent, written: messages.map(m => m.key), status: 'synced', detail: null })
          this.followExport(record)
        } else if (record.agent === 'gemini') {
          const id = stableUuid(`dsh-gemini:${sessionId}`)
          record.path ??= geminiChatPath(geminiProjectDir(this.homes.gemini, record.cwd), id)
          const fresh = messages.filter(m => !record.written.includes(m.key))
          appendGemini(record.path, id, record.cwd, fresh)
          Object.assign(record, { id, written: [...record.written, ...fresh.map(m => m.key)], status: 'synced', detail: null })
          this.followExport(record)
        } else {
          const result = await importIntoCodex(
            {
              command: this.config.codexCommand, home: this.homes.codex, claudeHome: this.homes.claude,
              timeoutMs: this.config.codexTimeoutMs,
            },
            claude.path, record.cwd, AbortSignal.timeout(this.config.codexTimeoutMs),
          )
          if (result.threadId !== null) {
            record.id = result.threadId
            record.path = codexRollout(this.homes.codex, result.threadId) ?? record.path
            Object.assign(record, { written: messages.map(m => m.key), status: 'synced', detail: null })
            this.followExport(record)
          } else {
            Object.assign(record, { status: record.id === null ? 'error' : 'deferred', detail: result.detail })
          }
        }
      } catch (error) {
        const missing = /ENOENT|could not start Codex/u.test(String(error))
        Object.assign(record, { status: missing ? 'unavailable' : 'error', detail: missing ? `${this.config.codexCommand} is not installed or not on PATH` : String(error) })
      }
      record.updatedAt = Date.now()
    }
    this.save()
    this.changed()
  }

  private readonly claudeWriters = new Map<string, { parent: string | null; written: Set<string> }>()

  private claudeWriter(sessionId: string): { parent: string | null; written: Set<string> } {
    let writer = this.claudeWriters.get(sessionId)
    if (writer === undefined) {
      const record = this.state.exports.find(e => e.sessionId === sessionId && e.agent === 'claude')
        ?? this.state.exports.find(e => e.sessionId === sessionId && e.agent === 'codex')
      writer = { parent: record?.parent ?? null, written: new Set(record?.written ?? []) }
      this.claudeWriters.set(sessionId, writer)
    }
    return writer
  }

  /** Follow a shared session's file so what the other agent adds there is relayed back. */
  private followExport(record: ExportRecord): void {
    if (record.path === null || record.id === null) return
    if (this.state.follows.some(f => f.sessionId === record.sessionId && f.path === record.path)) return
    const messages = this.withoutOwn(PARSERS[record.agent](record.path).messages, record.sessionId)
    this.state.follows.push({
      sessionId: record.sessionId, agent: record.agent, id: record.id, path: record.path, title: 'shared from DeepSeek Harness',
      delivered: messages.map(m => m.key), stamp: fileStamp(record.path), status: 'following', error: null,
    })
  }

  // ------------------------------------------------------------- memory

  private shareMemory(): void {
    const file = this.config.memoryFile
    if (file === '') return
    const episodic = join(dirname(file), 'episodic.db')
    const stamp = `${fileStamp(file)}|${fileStamp(episodic)}|${this.config.shareMemoryWith.join(',')}`
    if (stamp === this.memoryStamp) return
    this.memoryStamp = stamp
    let facts: ReturnType<typeof parseMemoryFacts> = []
    try {
      facts = parseMemoryFacts(readFileSync(file, 'utf8'))
    } catch (error) {
      // No memory saved yet: any earlier block is removed below.
      void error
    }
    const plan = planMemory(facts, sessionDirectories(episodic))
    // The episodic database changes every turn; the files change only when the plan does.
    const signature = JSON.stringify([plan.user, [...plan.projects], this.config.shareMemoryWith])
    if (signature === this.memoryPlan) return
    this.memoryPlan = signature
    const enabled = new Set(this.config.shareMemoryWith)
    const files = memoryFiles(this.homes, plan, enabled, cwd => geminiProjectDir(this.homes.gemini, cwd))
    const previous = new Set(this.state.memoryPaths)
    const written: string[] = []
    const counted = plan.user.length + [...plan.projects.values()].reduce((n, f) => n + f.length, 0)
    this.memoryExports = AGENTS.map((agent): MemoryExportState => {
      if (!enabled.has(agent)) return { agent, paths: [], facts: 0, status: 'disabled', detail: null, updatedAt: Date.now() }
      try {
        const paths: string[] = []
        for (const [path, block] of files[agent]) {
          writeBlock(path, block)
          paths.push(path)
        }
        if (agent === 'codex') paths.push(...writeCodexExtension(this.homes.codex, plan))
        written.push(...files[agent].keys())
        return { agent, paths, facts: counted, status: 'synced', detail: null, updatedAt: Date.now() }
      } catch (error) {
        return { agent, paths: [], facts: 0, status: 'error', detail: String(error), updatedAt: Date.now() }
      }
    })
    // Blocks written earlier where no fact belongs any more, or for an agent no longer shared with, are removed.
    for (const path of previous) {
      if (written.includes(path)) continue
      try {
        writeBlock(path, null)
      } catch (error) {
        this.ctx.logger('agent-bridge').warn(`agent-bridge: could not remove the memory block from ${path}: ${String(error)}`)
      }
    }
    if (!enabled.has('codex')) removeCodexExtension(this.homes.codex)
    this.state.memoryPaths = written
    this.save()
    this.changed()
  }

  // ------------------------------------------------------------- state

  private snapshot(): BridgeState {
    return {
      sessions: this.sessions().slice(0, this.config.listLimit),
      follows: this.state.follows.map(f => ({
        sessionId: f.sessionId, agent: f.agent, id: f.id, title: f.title, relayed: f.delivered.length, status: f.status, error: f.error,
      })),
      exports: this.state.exports.map(e => ({
        sessionId: e.sessionId, agent: e.agent, status: e.status, resume: resumeCommand(e.agent, e.id), path: e.path,
        written: e.written.length, detail: e.detail, updatedAt: e.updatedAt,
      })),
      memorySources: memorySources(this.homes, null),
      memoryExports: this.memoryExports,
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  private statePath(): string {
    return join(this.config.stateDir, 'state.json')
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath(), 'utf8')) as Partial<Persisted>
      this.state = {
        follows: parsed.follows ?? [], exports: parsed.exports ?? [], own: parsed.own ?? {}, memoryPaths: parsed.memoryPaths ?? [],
      }
    } catch (error) {
      // First run, or an unreadable file: the bridge starts with nothing followed or shared.
      void error
    }
  }

  private save(): void {
    const path = this.statePath()
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(this.state))
    renameSync(temp, path)
  }
}

/** Size and modification time of a file, or an empty string when it is missing. */
function fileStamp(path: string): string {
  try {
    const s = statSync(path)
    return `${s.size}:${s.mtimeMs}`
  } catch (error) {
    // A deleted or moved session file reads as missing.
    void error
    return ''
  }
}

/** The rollout file of a Codex thread. */
function codexRollout(codexHome: string, threadId: string): string | null {
  return codexFiles(codexHome).find(path => path.includes(threadId)) ?? null
}

/**
 * The model-visible conversation of a Session as transcript messages: the user's own prompts,
 * the agent's text and tool calls, and tool results. Relayed messages are left out, so a shared
 * session never echoes another agent's messages back to it.
 * @param agent - the Session's agent.
 * @returns messages keyed by message id.
 */
export function sessionMessages(agent: Agent): BridgeMessage[] {
  const out: BridgeMessage[] = []
  for (const message of agent.session.deriveMessages()) {
    if (message.role === 'user') {
      if (message.source.kind !== 'user') continue
      const text = message.content.map(b => (b.type === 'text' ? b.text : '')).join('\n').trim()
      if (text !== '') out.push({ key: message.id, role: 'user', text })
    } else if (message.role === 'assistant') {
      const parts: string[] = []
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text)
        else if (block.type === 'tool-call') parts.push(toolCallNote(block.name, parseArguments(block.arguments)))
      }
      if (parts.length > 0) out.push({ key: message.id, role: 'assistant', text: parts.join('\n\n') })
    } else if (message.role === 'tool') {
      const text = message.content.map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
      out.push({ key: message.id, role: 'tool', text: toolResultNote(text, message.isError) })
    }
  }
  return out
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    // Arguments are shown as written when they are not JSON.
    void error
    return text
  }
}
