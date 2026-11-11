/**
 * The bridge service through its tools: opening and following an external session, sharing a
 * conversation and relaying back what another agent adds, and sharing memory. With CODEX_BIN set,
 * the Codex export runs against that real Codex executable.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentBridge, { BLOCK_START, claudeProjectKey } from '../src/index.ts'

interface Fixture {
  ctx: Context
  root: string
  homes: { claude: string; codex: string; gemini: string }
  cwd: string
  agent: Agent
  /** Messages parked for the agent's next step, in its real inbox. */
  relayed: () => readonly UserMessage[]
  history: Message[]
  call: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>
  until: (check: () => boolean) => Promise<void>
}

const text = (result: ToolExecutionResult): string => result.content.map(b => (b.type === 'text' ? b.text : '')).join('')
const bodyOf = (message: UserMessage): string => message.content.map(b => (b.type === 'text' ? b.text : '')).join('')

async function setup(config: Record<string, unknown> = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-bridge-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const homes = { claude: join(root, '.claude'), codex: join(root, '.codex'), gemini: join(root, '.gemini') }
  const cwd = join(root, 'shop')
  for (const dir of [...Object.values(homes), cwd]) mkdirSync(dir, { recursive: true })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TypertRegistry)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('session-bridge-test'), {}, { cwd })
  // The conversation the bridge shares; the production loop is not driven in these tests.
  const history: Message[] = []
  vi.spyOn(agent.session, 'deriveMessages').mockImplementation(() => history)
  await ctx.plugin(AgentBridge, {
    claudeHome: homes.claude, codexHome: homes.codex, geminiHome: homes.gemini, stateDir: join(root, 'state'), memoryFile: join(root, 'MEMORY.md'),
    pollMs: 200, ...config,
  })
  let n = 0
  const call = (name: string, args: Record<string, unknown>) => executeToolFixture(ctx, {
    signal: new AbortController().signal, callId: ToolCallId(`c${++n}`), name, arguments: args, agent,
  })
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 100))
    expect(check()).toBe(true)
  }
  return { ctx, root, homes, cwd, agent, relayed: () => agent.inbox.nextStep, history, call, until }
}

function claudeSession(f: Fixture, id: string, records: { uuid: string; role: 'user' | 'assistant'; text: string }[]): string {
  const dir = join(f.homes.claude, 'projects', claudeProjectKey(f.cwd))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  appendFileSync(path, records.map(r => JSON.stringify({
    type: r.role, uuid: r.uuid, sessionId: id, cwd: f.cwd, isSidechain: false,
    message: { role: r.role, content: r.role === 'user' ? r.text : [{ type: 'text', text: r.text }] },
  })).join('\n') + '\n')
  return path
}

const userMessage = (body: string): Message => createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } })

describe('agent bridge', () => {
  it('lists, opens, and follows a Claude Code session into the conversation without waking the agent', async () => {
    const f = await setup()
    const path = claudeSession(f, 'cc-1', [{ uuid: 'u1', role: 'user', text: 'Fix the checkout bug' }, { uuid: 'a1', role: 'assistant', text: 'The loop is off by one in cart.js.' }])
    expect(text(await f.call('external_sessions', {}))).toContain('claude cc-1 — "Fix the checkout bug"')
    const opened = text(await f.call('open_external_session', { agent: 'claude', id: 'cc-1' }))
    expect(opened).toContain('<external_session agent="Claude Code" id="cc-1"')
    expect(opened).toContain('Claude Code:\nThe loop is off by one in cart.js.')
    claudeSession(f, 'cc-1', [{ uuid: 'u2', role: 'user', text: 'Also add a test' }])
    void path
    await f.until(() => f.relayed().length === 1)
    expect(f.agent.status).toBe('idle')
    expect(f.relayed()[0]!.source).toMatchObject({ kind: 'dsh-agent-bridge', form: 'relay', senderSessionId: 'Claude Code · Fix the checkout bug' })
    expect(bodyOf(f.relayed()[0]!)).toContain('User:\nAlso add a test')
    expect(bodyOf(f.relayed()[0]!)).not.toContain('off by one')
  })

  it('shares the conversation as native Claude Code and Gemini CLI sessions and relays back what those agents add', async () => {
    const f = await setup()
    f.history.push(userMessage('Add a dark mode'))
    const result = text(await f.call('share_session', { agents: ['claude', 'gemini'] }))
    expect(result).toMatch(/Claude Code: synced — continue with `claude --resume [0-9a-f-]+`/u)
    expect(result).toMatch(/Gemini CLI: synced — continue with `gemini --resume [0-9a-f-]+`/u)
    const claudeId = /claude --resume ([0-9a-f-]+)/u.exec(result)![1]!
    const claudePath = join(f.homes.claude, 'projects', claudeProjectKey(f.cwd), `${claudeId}.jsonl`)
    expect(readFileSync(claudePath, 'utf8')).toContain('Add a dark mode')
    // Claude Code continues the shared session; only its own message is relayed back.
    claudeSession(f, claudeId, [{ uuid: 'cc-a1', role: 'assistant', text: 'Dark mode toggle added in settings.' }])
    await f.until(() => f.relayed().length === 1)
    expect(bodyOf(f.relayed()[0]!)).toContain('Claude Code:\nDark mode toggle added in settings.')
    expect(bodyOf(f.relayed()[0]!)).not.toContain('Add a dark mode')
    expect(text(await f.call('external_sessions', { agent: 'claude' }))).toContain('(shared from DeepSeek Harness)')
  })

  it('writes DeepSeek Harness memory into each agent and offers theirs back with the agent and path of each file', async () => {
    const f = await setup()
    writeFileSync(join(f.root, 'MEMORY.md'), '## Project conventions\n- Postgres 16 only  <!-- s1 -->\n')
    await f.until(() => existsSync(join(f.homes.gemini, 'GEMINI.md')))
    for (const file of [join(f.homes.claude, 'CLAUDE.md'), join(f.homes.codex, 'AGENTS.md'), join(f.homes.gemini, 'GEMINI.md')]) {
      expect(readFileSync(file, 'utf8')).toContain(`${BLOCK_START}\n## Memory shared from DeepSeek Harness`)
      expect(readFileSync(file, 'utf8')).toContain('- Postgres 16 only')
    }
    expect(readFileSync(join(f.homes.codex, 'memories', 'extensions', 'dsh_agent_bridge', 'resources', 'user', 'MEMORY.md'), 'utf8')).toContain('- Postgres 16 only')
    expect(text(await f.call('external_memory', {}))).toBe('no external memory found')
    const memoryDir = join(f.homes.claude, 'projects', claudeProjectKey(f.cwd), 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), '- API base path is /v2/relay\n')
    const listed = text(await f.call('external_memory', {}))
    expect(listed).toBe(`Claude Code project memory: ${join(memoryDir, 'MEMORY.md')}`)
    expect(text(await f.call('external_memory', { path: join(memoryDir, 'MEMORY.md') }))).toBe('- API base path is /v2/relay')
  })

  it('shares project facts only with that project, and removes them when they leave DeepSeek Harness memory', async () => {
    const f = await setup()
    const db = new DatabaseSync(join(f.root, 'episodic.db'))
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at REAL)')
    db.prepare('INSERT INTO sessions VALUES (?, ?, 0)').run('s-shop', f.cwd)
    db.close()
    writeFileSync(join(f.root, 'MEMORY.md'), '## user\n- Prefers pnpm  <!-- s-other -->\n## project\n- cart.js totals the cart  <!-- s-shop -->\n')
    const claudeProject = join(f.homes.claude, 'projects', claudeProjectKey(f.cwd), 'memory', 'MEMORY.md')
    await f.until(() => existsSync(claudeProject))
    expect(readFileSync(claudeProject, 'utf8')).toContain('## Project memory shared from DeepSeek Harness')
    expect(readFileSync(claudeProject, 'utf8')).toContain('- cart.js totals the cart')
    expect(readFileSync(join(f.homes.claude, 'CLAUDE.md'), 'utf8')).toContain('- Prefers pnpm')
    expect(readFileSync(join(f.homes.claude, 'CLAUDE.md'), 'utf8')).not.toContain('cart.js')
    expect(readFileSync(join(f.homes.codex, 'AGENTS.md'), 'utf8')).not.toContain('cart.js')
    const geminiProject = JSON.parse(readFileSync(join(f.homes.gemini, 'projects.json'), 'utf8')) as { projects: Record<string, string> }
    expect(readFileSync(join(f.homes.gemini, 'tmp', geminiProject.projects[f.cwd]!, 'memory', 'MEMORY.md'), 'utf8')).toContain('- cart.js totals the cart')
    const extension = join(f.homes.codex, 'memories', 'extensions', 'dsh_agent_bridge', 'resources', claudeProjectKey(f.cwd))
    expect(JSON.parse(readFileSync(join(extension, 'scope.json'), 'utf8'))).toEqual({ cwd: f.cwd })
    writeFileSync(join(f.root, 'MEMORY.md'), '## user\n- Prefers pnpm  <!-- s-other -->\n')
    await f.until(() => !readFileSync(claudeProject, 'utf8').includes('cart.js'))
    expect(existsSync(extension)).toBe(false)
  })

  it.skipIf(process.env.CODEX_BIN === undefined)('imports the conversation into the real Codex and extends the same thread after the next turn', async () => {
    const f = await setup({ codexCommand: process.env.CODEX_BIN })
    f.history.push(userMessage('What does parse_header do?'))
    const first = text(await f.call('share_session', { agents: ['codex'] }))
    expect(first).toMatch(/Codex: synced — continue with `codex resume [0-9a-f-]+`/u)
    const thread = /codex resume ([0-9a-f-]+)/u.exec(first)![1]!
    f.history.push(userMessage('And what does it return?'))
    const second = text(await f.call('share_session', { agents: ['codex'] }))
    expect(second).toContain(`codex resume ${thread}`)
    const state = JSON.parse(readFileSync(join(f.root, 'state', 'state.json'), 'utf8')) as { exports: { agent: string; path: string }[] }
    const rollout = readFileSync(state.exports.find(e => e.agent === 'codex')!.path, 'utf8')
    expect(rollout).toContain('What does parse_header do?')
    expect(rollout).toContain('And what does it return?')
  }, 120_000)
})
