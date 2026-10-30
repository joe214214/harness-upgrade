/**
 * Memory over real files and node:sqlite: the capped MEMORY.md, FTS5 recall,
 * strict reflect parsing, history projection, the tools, context injection,
 * and the turn-stopping ingest + reflect path with a scripted model.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import * as Memory from '../src/index.ts'
import { EpisodicMemory, LongTermMemory, MemoryFullError, ftsQuery, parseFacts, reflectInput, toTurns } from '../src/index.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-memory-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('LongTermMemory', () => {
  it('files facts under sections, dedupes, and strips source tags from the prompt', () => {
    const m = new LongTermMemory(join(root, 'MEMORY.md'), 8000)
    expect(m.append('user', 'prefers tabs', 's1')).toBe(true)
    expect(m.append('user', 'prefers tabs', 's2')).toBe(false)
    m.append('project', 'uses ruff', 's1')
    m.append('user', 'writes Python', 's1')
    expect(m.read()).toBe('## user\n- prefers tabs  <!-- s1 -->\n- writes Python  <!-- s1 -->\n\n## project\n- uses ruff  <!-- s1 -->\n')
    expect(m.renderForPrompt()).not.toContain('<!--')
    expect(m.renderForPrompt()).toContain('- uses ruff')
  })

  it('enforces the cap and supports replace and rewrite', () => {
    const m = new LongTermMemory(join(root, 'MEMORY.md'), 60)
    m.append('user', 'x'.repeat(30), '')
    expect(() => m.append('user', 'y'.repeat(30), '')).toThrow(MemoryFullError)
    expect(m.replace('missing', 'z')).toBe(false)
    expect(m.replace('x'.repeat(30), 'short')).toBe(true)
    m.rewrite('## user\n- merged')
    expect(m.read()).toBe('## user\n- merged\n')
    expect(new LongTermMemory(join(root, 'none.md'), 10).renderForPrompt()).toBe('')
  })
})

describe('EpisodicMemory', () => {
  it('searches across Sessions, continues indexes, and excludes the caller', () => {
    const e = new EpisodicMemory(join(root, 'episodic.db'))
    onTestFinished(() => { e.close() })
    e.append('old', '/w', [{ role: 'user', text: 'the CORS fix was RELAY_CORS_ORIGINS' }])
    e.append('old', '/w', [{ role: 'tool', text: 'endpoint /v1/relay/jobs decided', toolName: 'read_audio' }])
    e.append('now', '/w', [{ role: 'user', text: 'CORS again' }])
    expect(e.search('CORS fix', 5, 'now').map(h => h.content)).toEqual(['the CORS fix was RELAY_CORS_ORIGINS'])
    expect(e.search('endpoint', 5)[0]).toMatchObject({ toolName: 'read_audio', sessionId: 'old' })
    expect(e.search('!!', 5)).toEqual([])
    expect(e.sessionCount()).toBe(2)
  })

  it('builds FTS queries that never parse punctuation as syntax', () => {
    expect(ftsQuery('what was "the" CORS-fix?')).toBe('"what" OR "was" OR "the" OR "CORS-fix"')
    expect(ftsQuery('接口 名字')).toBe('"接口" OR "名字"')
  })
})

describe('reflect parsing', () => {
  it('accepts a fenced JSON array and drops everything else', () => {
    expect(parseFacts('```json\n[{"section":"user","fact":"prefers tabs"}]\n```')).toEqual([{ section: 'user', fact: 'prefers tabs' }])
    expect(parseFacts('I cannot help with that')).toEqual([])
    expect(parseFacts('[not json')).toEqual([])
    expect(parseFacts('{"fact":"x"}')).toEqual([])
    expect(parseFacts('[{"section":"weird","fact":"x"},{"fact":" "},null,{"section":"user"}]')).toEqual([{ section: 'general', fact: 'x' }])
  })

  it('shows existing memory and the turn to the model', () => {
    const input = reflectInput('', [{ role: 'tool', text: 'said: use /v1/jobs', toolName: 'read_audio' }])
    expect(input).toContain('(empty)')
    expect(input).toContain('TOOL (read_audio): said: use /v1/jobs')
  })
})

describe('toTurns', () => {
  it('keeps user text, assistant text and tool calls, and clips non-media tool results', () => {
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'You are…' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'remember tabs' }] },
      { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context.' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hm' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a"}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a'.repeat(300) }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'read_audio', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'b'.repeat(300) }] },
    ] as unknown as Message[]
    const turns = toTurns(messages, 100)
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool'])
    expect(turns[1]?.text).toBe('[tool read] {"file_path":"a"}')
    expect(turns[2]?.text).toContain('[200 more chars]')
    expect(turns[4]).toMatchObject({ toolName: 'read_audio', text: 'b'.repeat(300) })
  })
})

/** A model that answers every request with one fixed text. */
class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly answer: string) { super() }
  override listModels(): Promise<readonly LlmModelInfo[]> { return Promise.resolve([{ provider: 'test', id: 'm', name: 'm' }]) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('memory plugin', () => {
  async function setup(answer: string, config: Partial<Memory.Config> = {}) {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LlmRuntime)
    const adapter = new ScriptedAdapter(answer)
    ctx.llm.registerAdapter(['test'], adapter)
    await ctx.plugin(Memory, Object.assign({ root }, config))
    return { ctx, adapter }
  }

  function fakeAgent(id: string, messages: unknown[]) {
    return {
      options: { provider: 'test', model: 'm' },
      session: { header: { id, cwd: '/work' }, requestHeader: () => undefined, deriveMessages: () => messages },
    }
  }

  let n = 0
  async function tool(ctx: Context, name: string, args: Record<string, unknown>, sessionId = 's-now') {
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId(`m-${++n}`), name, arguments: args,
      agent: fakeAgent(sessionId, []) as never,
    })
    return { isError: result.isError, text: result.content.map(b => (b.type === 'text' ? b.text : '')).join('') }
  }

  it('saves, dedupes, replaces and rewrites through the tools', async () => {
    const { ctx } = await setup('[]', { capBytes: 512 })
    expect((await tool(ctx, 'memory_write', { section: 'user', fact: 'prefers tabs' })).text).toContain('saved')
    expect((await tool(ctx, 'memory_write', { section: 'user', fact: 'prefers tabs' })).text).toBe('already in memory')
    expect((await tool(ctx, 'memory_replace', { old: 'nope', new: 'x' })).isError).toBe(true)
    expect((await tool(ctx, 'memory_replace', { old: 'tabs', new: 'spaces' })).text).toContain('replaced')
    expect((await tool(ctx, 'memory_read', {})).text).toContain('prefers spaces  <!-- s-now -->')
    const full = await tool(ctx, 'memory_write', { section: 'user', fact: 'z'.repeat(600) })
    expect(full).toMatchObject({ isError: true })
    expect(full.text).toContain('Consolidate first')
    expect((await tool(ctx, 'memory_rewrite', { text: '## user\n- merged' })).text).toContain('rewritten')
  })

  it('injects memory into the assembled context', async () => {
    const { ctx } = await setup('[]')
    await tool(ctx, 'memory_write', { section: 'project', fact: 'codename BLUEFINCH' })
    const contexts = await ctx.systemPrompt.assemble({})
    expect(JSON.stringify(contexts)).toContain('codename BLUEFINCH')
  })

  it('stores each finished turn once, reflects facts into MEMORY.md, and recalls it from another Session', async () => {
    const { ctx, adapter } = await setup('```json\n[{"section":"decisions","fact":"The jobs endpoint is /v1/relay/jobs"}]\n```')
    const messages = [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Summarize the meeting' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_audio', arguments: '{"file_path":"m.mp3"}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '[03:12–03:40] we agreed the endpoint is /v1/relay/jobs' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'The endpoint was decided.' }] },
    ]
    const agent = fakeAgent('s-meeting', messages)
    await ctx.serial('agent/turn-stopping', { agent: agent as never, turn: 1, signal: new AbortController().signal })
    await ctx.serial('agent/turn-stopping', { agent: agent as never, turn: 1, signal: new AbortController().signal })
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('TOOL (read_audio): [03:12–03:40]')
    expect((await tool(ctx, 'memory_read', {})).text).toContain('The jobs endpoint is /v1/relay/jobs  <!-- s-meeting -->')
    const recall = await tool(ctx, 'recall', { query: 'endpoint agreed' }, 's-next')
    expect(recall.text).toContain('read_audio')
    expect(recall.text).toContain('03:12')
  })

  it('skips reflection when disabled and survives a refusal', async () => {
    const off = await setup('[{"section":"user","fact":"x"}]', { reflect: false })
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }]
    await off.ctx.serial('agent/turn-stopping', { agent: fakeAgent('a', messages) as never, turn: 1, signal: new AbortController().signal })
    expect(off.adapter.requests).toHaveLength(0)
    const refusing = await setup('I cannot help with that')
    await refusing.ctx.serial('agent/turn-stopping', { agent: fakeAgent('b', messages) as never, turn: 1, signal: new AbortController().signal })
    expect((await tool(refusing.ctx, 'memory_read', {})).text).toBe('(memory is empty)')
  })
})
