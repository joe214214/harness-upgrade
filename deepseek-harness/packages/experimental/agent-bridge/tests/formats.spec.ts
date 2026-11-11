/**
 * Readers and writers of Claude Code, Codex, and Gemini CLI session files, and the memory
 * blocks written into the other agents' files.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BLOCK_END, BLOCK_START, appendClaude, appendGemini, changeSince, claudeExport, claudeProjectKey, factsBlock, geminiProjectDir,
  memorySources, parseClaude, parseCodex, parseGemini, parseMemoryFacts, planMemory, renderMessages, stripBlock,
} from '../src/index.ts'
import { writeBlock, writeCodexExtension } from '../src/memory.ts'
import { summarize } from '../src/sources.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agent-bridge-'))
  dirs.push(dir)
  return dir
}
const lines = (records: unknown[]): string => `${records.map(r => JSON.stringify(r)).join('\n')}\n`

describe('Claude Code transcripts', () => {
  it('keeps the conversation, turns tools into notes, and drops injected, meta, and sidechain records', () => {
    const dir = temp()
    const path = join(dir, 'abc.jsonl')
    const base = { sessionId: 'abc', cwd: '/work/shop', isSidechain: false }
    writeFileSync(path, lines([
      { type: 'user', uuid: 'u0', ...base, isMeta: true, message: { role: 'user', content: 'meta' } },
      { type: 'user', uuid: 'u1', ...base, timestamp: '2026-11-11T08:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ignore</system-reminder>' }, { type: 'text', text: 'Fix checkout' }] } },
      { type: 'assistant', uuid: 'a1', ...base, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', uuid: 'u2', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1 failing', is_error: true }] } },
      { type: 'assistant', uuid: 's1', ...base, isSidechain: true, message: { role: 'assistant', content: 'subagent' } },
      { type: 'custom-title', customTitle: 'Checkout bug', sessionId: 'abc' },
    ]))
    const parsed = parseClaude(path)
    expect(parsed).toMatchObject({ id: 'abc', cwd: '/work/shop', title: 'Checkout bug' })
    expect(parsed.messages.map(m => [m.key, m.role])).toEqual([['u1', 'user'], ['a1', 'assistant'], ['u2', 'tool']])
    expect(parsed.messages[0]!.text).toBe('Fix checkout')
    expect(parsed.messages[1]!.text).toBe('Looking.\n\n[tool call: Bash]\ncommand: npm test')
    expect(parsed.messages[2]!.text).toBe('[tool result: error]\n1 failing')
  })

  it('reads the continuation a continued-in record points to', () => {
    const dir = temp()
    const base = { cwd: '/w', isSidechain: false }
    writeFileSync(join(dir, 'old.jsonl'), lines([
      { type: 'user', uuid: 'u1', sessionId: 'old', ...base, message: { role: 'user', content: 'first' } },
      { type: 'continued-in', sessionId: 'old', continuedInSessionId: 'new' },
    ]))
    writeFileSync(join(dir, 'new.jsonl'), lines([
      { type: 'user', uuid: 'u1', sessionId: 'new', ...base, message: { role: 'user', content: 'first' } },
      { type: 'assistant', uuid: 'a1', sessionId: 'new', ...base, message: { role: 'assistant', content: [{ type: 'text', text: 'later' }] } },
    ]))
    expect(parseClaude(join(dir, 'old.jsonl')).messages.map(m => m.text)).toEqual(['first', 'later'])
  })

  it('writes transcripts the reader takes back, chaining records and marking them as the bridge\'s own', () => {
    const home = temp()
    const target = claudeExport(home, '/work/shop', 'dsh-1')
    expect(target.path).toBe(join(home, 'projects', claudeProjectKey('/work/shop'), 'dsh-1.jsonl'))
    const parent = appendClaude(target, '/work/shop', 'DeepSeek: fix', [{ key: 'm1', role: 'user', text: 'Fix it' }, { key: 'm2', role: 'assistant', text: 'Done.' }], null)
    appendClaude(target, '/work/shop', 'DeepSeek: fix', [{ key: 'm3', role: 'tool', text: '[tool result]\nok' }], parent)
    const records = readFileSync(target.path, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(records[0]).toMatchObject({ type: 'custom-title', customTitle: 'DeepSeek: fix' })
    expect(records[2]!.parentUuid).toBe(records[1]!.uuid)
    expect(records[3]!.parentUuid).toBe(records[2]!.uuid)
    expect(parseClaude(target.path).messages).toEqual([])
    expect(parseClaude(target.path, true).messages.map(m => [m.role, m.text])).toEqual([['user', 'Fix it'], ['assistant', 'Done.'], ['assistant', '[tool result]\nok']])
  })
})

describe('Codex rollouts', () => {
  it('reads messages and tool calls and skips injected context', () => {
    const dir = temp()
    const path = join(dir, 'rollout-2026-11-11T07-51-11-01a1c996-e3c7-76c3-8d54-0c425447937e.jsonl')
    writeFileSync(path, lines([
      { type: 'session_meta', payload: { id: '01a1c996-e3c7-76c3-8d54-0c425447937e', cwd: '/work/shop' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Fix checkout' } },
      { type: 'response_item', timestamp: 't1', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix checkout' }] } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}', call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '1 failing' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The loop is off by one.' }] } },
    ]))
    const parsed = parseCodex(path)
    expect(parsed).toMatchObject({ id: '01a1c996-e3c7-76c3-8d54-0c425447937e', cwd: '/work/shop', title: 'Fix checkout' })
    expect(parsed.messages.map(m => [m.key, m.role, m.text])).toEqual([
      ['line-4', 'user', 'Fix checkout'],
      ['line-6', 'assistant', '[tool call: shell]\ncommand: npm test'],
      ['line-7', 'tool', '[tool result]\n1 failing'],
      ['line-8', 'assistant', 'The loop is off by one.'],
    ])
  })
})

describe('Gemini CLI chats', () => {
  it('replays patches and rewinds, and splits tool results from the model turn', () => {
    const dir = temp()
    mkdirSync(join(dir, 'shop', 'chats'), { recursive: true })
    writeFileSync(join(dir, 'shop', '.project_root'), '/work/shop')
    const path = join(dir, 'shop', 'chats', 'session-2026-11-11T08-00-abcd1234.jsonl')
    writeFileSync(path, lines([
      { sessionId: 'g-1', projectHash: 'h', startTime: 's', lastUpdated: 's', kind: 'main' },
      { id: 'q1', timestamp: 't', type: 'user', content: [{ text: 'Fix checkout' }] },
      { id: 'r1', timestamp: 't', type: 'gemini', content: [{ text: 'thinking', thought: true }, { text: 'Running tests.' }], toolCalls: [{ id: 'c1', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success' }] },
      { $patch: { id: 'r1', toolCalls: [{ id: 'c1', result: [{ functionResponse: { response: { output: '1 failing' } } }] }] } },
      { id: 'q2', timestamp: 't', type: 'user', content: 'wrong question' },
      { $rewindTo: 'q2' },
      { id: 'q3', timestamp: 't', type: 'user', content: 'And now?' },
      { id: 'i1', timestamp: 't', type: 'info', content: 'saved' },
      { $set: { summary: 'Checkout fix' } },
    ]))
    const parsed = parseGemini(path)
    expect(parsed).toMatchObject({ id: 'g-1', cwd: '/work/shop', title: 'Checkout fix' })
    expect(parsed.messages.map(m => [m.key, m.role, m.text])).toEqual([
      ['q1', 'user', 'Fix checkout'],
      ['r1', 'assistant', 'Running tests.\n\n[tool call: run_shell_command]\ncommand: npm test'],
      ['r1#results', 'tool', '[tool result]\n1 failing'],
      ['q3', 'user', 'And now?'],
    ])
  })

  it('registers a project the way Gemini CLI does and writes chats the reader takes back', () => {
    const home = temp()
    const project = geminiProjectDir(home, '/work/My Shop')
    expect(project).toBe(join(home, 'tmp', 'my-shop'))
    expect(JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'))).toEqual({ projects: { '/work/My Shop': 'my-shop' } })
    expect(readFileSync(join(project, '.project_root'), 'utf8')).toBe('/work/My Shop')
    expect(geminiProjectDir(home, '/work/My Shop')).toBe(project)
    expect(geminiProjectDir(home, '/other/my shop')).toBe(join(home, 'tmp', 'my-shop-1'))
    const path = join(project, 'chats', 'session-x.jsonl')
    appendGemini(path, 'g-2', '/work/My Shop', [{ key: 'm1', role: 'user', text: 'Hi' }])
    appendGemini(path, 'g-2', '/work/My Shop', [{ key: 'm2', role: 'assistant', text: 'Hello' }])
    expect(parseGemini(path).messages).toEqual([])
    expect(parseGemini(path, true)).toMatchObject({ id: 'g-2', cwd: '/work/My Shop' })
    expect(parseGemini(path, true).messages.map(m => [m.role, m.text])).toEqual([['user', 'Hi'], ['assistant', 'Hello']])
  })
})

describe('listing', () => {
  it('skips a session file deleted after its directory was read, and tells exports from the head of the file', () => {
    const home = temp()
    expect(summarize('claude', join(home, 'gone.jsonl'), new Map())).toBeUndefined()
    const target = claudeExport(home, '/w', 'dsh-2')
    appendClaude(target, '/w', 'DeepSeek: x', [{ key: 'm1', role: 'user', text: 'Hi' }], null)
    expect(summarize('claude', target.path, new Map())).toMatchObject({ id: 'dsh-2', title: 'DeepSeek: x', exported: true })
  })
})

describe('transcript changes', () => {
  const m = (key: string): { key: string; role: 'user'; text: string } => ({ key, role: 'user', text: key })
  it('returns the new suffix, and counts delivered messages a rewind removed', () => {
    expect(changeSince(['a', 'b'], [m('a'), m('b'), m('c')])).toEqual({ added: [m('c')], dropped: 0 })
    expect(changeSince(['a', 'b', 'c'], [m('a'), m('x')])).toEqual({ added: [m('x')], dropped: 2 })
  })

  it('renders the newest messages that fit and counts the rest', () => {
    const { text, omitted } = renderMessages([{ key: '1', role: 'user', text: 'x'.repeat(50) }, { key: '2', role: 'assistant', text: 'done' }], 'codex', 30)
    expect(omitted).toBe(1)
    expect(text).toBe('Codex:\ndone')
  })
})

describe('memory', () => {
  it('keeps project facts in their project and leaves out project facts of unknown Sessions', () => {
    const facts = parseMemoryFacts('## user\n- Prefers pnpm  <!-- s1 -->\n## project\n- cart.js totals the cart  <!-- s2 -->\n- orphan fact  <!-- s9 -->\n')
    const plan = planMemory(facts, new Map([['s1', '/a'], ['s2', '/work/shop']]))
    expect(plan.user.map(f => f.text)).toEqual(['Prefers pnpm'])
    expect([...plan.projects]).toEqual([['/work/shop', [{ section: 'project', text: 'cart.js totals the cart', source: 's2' }]]])
  })

  it('reads DeepSeek Harness facts without source tags and writes them as a replaceable block', () => {
    const facts = parseMemoryFacts('## User preferences\n- Reply in Chinese  <!-- session-1 -->\n\n## Project conventions\n- Postgres 16 only\n')
    expect(facts).toEqual([{ section: 'User preferences', text: 'Reply in Chinese', source: 'session-1' }, { section: 'Project conventions', text: 'Postgres 16 only' }])
    const dir = temp()
    const file = join(dir, 'CLAUDE.md')
    writeFileSync(file, '# My rules\n- tabs\n')
    expect(writeBlock(file, factsBlock(facts))).toBe(true)
    expect(writeBlock(file, factsBlock(facts))).toBe(false)
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('# My rules\n- tabs\n\n')).toBe(true)
    expect(text).toContain(`${BLOCK_START}\n## Memory shared from DeepSeek Harness`)
    expect(text).toContain('### Project conventions\n- Postgres 16 only')
    expect(stripBlock(text)).toBe('# My rules\n- tabs')
    writeBlock(file, factsBlock([facts[0]!]))
    expect(readFileSync(file, 'utf8').match(new RegExp(BLOCK_END, 'gu'))).toHaveLength(1)
    writeBlock(file, null)
    expect(readFileSync(file, 'utf8')).toBe('# My rules\n- tabs')
  })

  it('finds the other agents\' memory for a workspace and ignores files holding only its own block', () => {
    const root = temp()
    const homes = { claude: join(root, 'claude'), codex: join(root, 'codex'), gemini: join(root, 'gemini') }
    mkdirSync(join(homes.claude, 'projects', claudeProjectKey('/work/shop'), 'memory'), { recursive: true })
    writeFileSync(join(homes.claude, 'projects', claudeProjectKey('/work/shop'), 'memory', 'MEMORY.md'), '- [api](api.md) base path /v2')
    mkdirSync(homes.gemini, { recursive: true })
    writeFileSync(join(homes.gemini, 'GEMINI.md'), '## Gemini Added Memories\n- likes tabs\n')
    mkdirSync(homes.codex, { recursive: true })
    writeFileSync(join(homes.codex, 'AGENTS.md'), factsBlock([{ section: 'x', text: 'own fact' }]))
    const paths = writeCodexExtension(homes.codex, { user: [{ section: 'x', text: 'own fact' }], projects: new Map() })
    expect(readFileSync(paths[1]!, 'utf8')).toContain('- own fact')
    const sources = memorySources(homes, '/work/shop')
    expect(sources.map(s => [s.agent, s.scope, s.kind])).toEqual([['claude', 'project', 'memory'], ['gemini', 'user', 'instructions']])
  })
})
