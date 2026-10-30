import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import {
  MediaCache,
  MediaCommandError,
  formatTimestamp,
  hashFile,
  parsePageSelection,
  parseTimestamp,
  resolveWindow,
  runMediaCommand,
} from '../src/index.ts'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'media-core-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('parsePageSelection', () => {
  it('accepts single pages, ranges and lists, sorted and de-duplicated', () => {
    expect(parsePageSelection('3', 10, 5)).toEqual([3])
    expect(parsePageSelection('2-4', 10, 5)).toEqual([2, 3, 4])
    expect(parsePageSelection('5, 1-2,2', 10, 5)).toEqual([1, 2, 5])
  })

  it('rejects malformed, out-of-range and oversized selections with the valid range', () => {
    expect(() => parsePageSelection('a', 10, 5)).toThrow(/use forms like/)
    expect(() => parsePageSelection('0', 10, 5)).toThrow(/pages 1-10/)
    expect(() => parsePageSelection('9-11', 10, 5)).toThrow(/pages 1-10/)
    expect(() => parsePageSelection('4-2', 10, 5)).toThrow(/pages 1-10/)
    expect(() => parsePageSelection('1-6', 10, 5)).toThrow(/at most 5 per call/)
  })
})

describe('timestamps', () => {
  it('formats under and over an hour', () => {
    expect(formatTimestamp(65.9)).toBe('01:05')
    expect(formatTimestamp(3725)).toBe('01:02:05')
    expect(formatTimestamp(-3)).toBe('00:00')
  })

  it('parses seconds, MM:SS and HH:MM:SS', () => {
    expect(parseTimestamp('95.5')).toBe(95.5)
    expect(parseTimestamp('01:35')).toBe(95)
    expect(parseTimestamp('1:00:01')).toBe(3601)
    expect(() => parseTimestamp('1m30s')).toThrow(/invalid timestamp/)
  })

  it('clamps windows to the duration and rejects empty or late windows', () => {
    expect(resolveWindow(undefined, undefined, 120)).toEqual({ start: 0, end: 120 })
    expect(resolveWindow('30', '500', 120)).toEqual({ start: 30, end: 120 })
    expect(() => resolveWindow('200', undefined, 120)).toThrow(/past the end/)
    expect(() => resolveWindow('60', '30', 120)).toThrow(/empty window/)
  })
})

describe('MediaCache', () => {
  it('keys on content and parameters, and round-trips JSON', async () => {
    const a = join(dir, 'a.bin')
    const b = join(dir, 'b.bin')
    await writeFile(a, 'same bytes')
    await writeFile(b, 'same bytes')
    const signal = new AbortController().signal
    const digest = await hashFile(a, signal)
    expect(await hashFile(b, signal)).toBe(digest)

    const cache = new MediaCache(join(dir, 'cache'))
    const k1 = cache.key(digest, 'pdf-text', { pages: '1-2', dpi: 100 })
    expect(cache.key(digest, 'pdf-text', { dpi: 100, pages: '1-2' })).toBe(k1)
    expect(cache.key(digest, 'pdf-text', { pages: '1-3', dpi: 100 })).not.toBe(k1)
    expect(await cache.get(k1)).toBeUndefined()
    await cache.put(k1, { text: 'hello' })
    expect(await cache.get(k1)).toEqual({ text: 'hello' })
  })

  it('treats a corrupt entry as a miss', async () => {
    const cache = new MediaCache(join(dir, 'cache2'))
    await cache.put('k', 1)
    await writeFile(join(dir, 'cache2', 'k.json'), '{oops')
    expect(await cache.get('k')).toBeUndefined()
  })
})

describe('runMediaCommand', () => {
  async function subprocessContext(): Promise<Context> {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LocalSubprocessRuntime)
    return ctx
  }
  const base = { cwd: tmpdir(), timeoutMs: 10_000, maxStdoutBytes: 1 << 20 }

  it('returns collected stdout of a zero-exit run', async () => {
    const ctx = await subprocessContext()
    const result = await runMediaCommand(ctx, { ...base, argv: ['printf', 'hello'], signal: new AbortController().signal }, 'coreutils')
    expect(result.stdout).toBe('hello')
    expect(result.truncated).toBe(false)
  })

  it('names the package to install when the executable is missing', async () => {
    const ctx = await subprocessContext()
    const run = runMediaCommand(ctx, { ...base, argv: ['no-such-media-tool-xyz'], signal: new AbortController().signal }, 'poppler-utils')
    await expect(run).rejects.toThrow(MediaCommandError)
    await expect(run).rejects.toThrow(/install poppler-utils/)
  })

  it('reports non-zero exits with the stderr tail', async () => {
    const ctx = await subprocessContext()
    const run = runMediaCommand(ctx, { ...base, argv: ['ls', '/definitely/missing/path'], signal: new AbortController().signal }, 'coreutils')
    await expect(run).rejects.toThrow(/ls failed \(exit 2\)/)
  })

  it('reports a deadline as a timeout', async () => {
    const ctx = await subprocessContext()
    const run = runMediaCommand(ctx, { ...base, timeoutMs: 200, argv: ['sleep', '5'], signal: new AbortController().signal }, 'coreutils')
    await expect(run).rejects.toMatchObject({ code: 'MEDIA_TOOL_TIMEOUT' })
  })
})
