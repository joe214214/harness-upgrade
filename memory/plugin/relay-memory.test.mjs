// Run: node --test memory/plugin/relay-memory.test.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { RpcClient, resolveConfig, toTurns } from './relay-memory.mjs'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

test('toTurns keeps user, assistant text, tool calls and results; drops system and runtime context', () => {
  const turns = toTurns([
    { role: 'system', content: [{ type: 'text', text: 'You are…' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'remember tabs' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context.' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-call', id: 'c1', name: 'memory_write', arguments: '{"fact":"tabs"}' },
    ] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'saved' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
  ])
  assert.deepEqual(turns, [
    { role: 'user', text: 'remember tabs' },
    { role: 'assistant', text: '[tool memory_write] {"fact":"tabs"}' },
    { role: 'tool', text: 'saved', tool_name: 'memory_write' },
    { role: 'assistant', text: 'Noted.' },
  ])
})

test('toTurns clips long tool output', () => {
  const [turn] = toTurns([{ role: 'tool', toolCallId: 'x', content: [{ type: 'text', text: 'a'.repeat(5000) }] }])
  assert.ok(turn.text.length < 1600 && turn.text.endsWith('[3500 more chars]'))
})

test('resolveConfig fills every field explicitly', () => {
  const cfg = resolveConfig({ root: '/r', reflect: false })
  assert.deepEqual(cfg, { python: 'python3', root: '/r', reflect: false, capBytes: 8000 })
})

test('RpcClient round-trips against the real Python server', async (t) => {
  const root = fileURLToPath(new URL(`./.tmp-${process.pid}`, import.meta.url))
  const rpc = new RpcClient('python3', ['-m', 'relay_memory', 'serve', '--root', root, '--no-reflect'],
    { ...process.env, PYTHONPATH: PACKAGE_DIR })
  t.after(async () => {
    rpc.close()
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  const init = await rpc.request('initialize', {})
  assert.equal(init.serverInfo.name, 'relay-memory')
  const res = await rpc.request('tools/call', { name: 'memory_write', arguments: { section: 'user', fact: 'likes rust' } })
  assert.equal(res.isError, false)
  assert.match((await rpc.request('relay/context')).text, /likes rust/)
  await assert.rejects(rpc.request('no/such/method'), /method not found/)
})
