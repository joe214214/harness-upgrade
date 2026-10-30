/**
 * Semantic memory: a size-capped MEMORY.md the agent curates itself. Facts
 * live under `## section` headings as `- fact` lines, each tagged with the
 * Session that wrote it. The cap is the point: when a write would exceed it,
 * the write fails and the agent must merge, prune, and compress first.
 * @module @deepseek-ai/dsh-memory/longterm
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** A write would push MEMORY.md past its byte cap. */
export class MemoryFullError extends Error {
  /**
   * @param size - bytes the file would have after the write.
   * @param cap - configured byte cap.
   */
  constructor(readonly size: number, readonly cap: number) {
    super(`MEMORY.md would be ${size} bytes; the cap is ${cap}. Consolidate first with memory_rewrite: `
      + 'merge duplicates, drop stale facts, compress details into conclusions.')
    this.name = 'MemoryFullError'
  }
}

const SOURCE_TAG = /\s*<!--.*?-->\s*$/u

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** The MEMORY.md file and its cap. */
export class LongTermMemory {
  /**
   * @param path - absolute path of MEMORY.md.
   * @param capBytes - UTF-8 byte cap.
   */
  constructor(readonly path: string, readonly capBytes: number) {}

  /**
   * Read MEMORY.md.
   * @returns the file text, or empty when it does not exist.
   */
  read(): string {
    try {
      return readFileSync(this.path, 'utf8')
    } catch (error: unknown) {
      // A missing file is an empty memory; any other read failure is surfaced.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  /**
   * Measure MEMORY.md against its cap.
   * @returns current UTF-8 size in bytes.
   */
  size(): number {
    return Buffer.byteLength(this.read(), 'utf8')
  }

  /**
   * List the facts filed under each section.
   * @returns facts per section, without source tags.
   */
  sections(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    let current = 'general'
    for (const line of this.read().split('\n')) {
      if (line.startsWith('## ')) {
        current = line.slice(3).trim()
        if (!out.has(current)) out.set(current, [])
      } else if (line.trim().startsWith('- ')) {
        const list = out.get(current) ?? []
        list.push(line.trim().slice(2).replace(SOURCE_TAG, ''))
        out.set(current, list)
      }
    }
    return out
  }

  /**
   * Append one fact under a section; an identical fact is not repeated.
   * @param section - section heading.
   * @param fact - one-line fact.
   * @param source - Session id recorded with the fact.
   * @returns true when the file changed.
   * @throws MemoryFullError when the result would exceed the cap.
   */
  append(section: string, fact: string, source: string): boolean {
    const clean = fact.trim().replace(/\s*\n\s*/gu, ' ')
    if (!clean || this.sections().get(section)?.includes(clean)) return false
    let text = this.read()
    const entry = `- ${clean}${source ? `  <!-- ${source} -->` : ''}`
    const heading = new RegExp(`(## ${escapeRegExp(section)}\\n(?:- .*\\n?)*)`, 'u')
    if (heading.test(text)) {
      text = text.replace(heading, match => `${match.replace(/\n+$/u, '')}\n${entry}\n`)
    } else {
      text = `${text.replace(/\n+$/u, '')}${text.trim() ? '\n\n' : ''}## ${section}\n${entry}\n`
    }
    this.write(text)
    return true
  }

  /**
   * Replace one exact, unique substring.
   * @param old - text that must occur exactly once.
   * @param replacement - new text; empty deletes.
   * @returns false when `old` is absent or ambiguous.
   * @throws MemoryFullError when the result would exceed the cap.
   */
  replace(old: string, replacement: string): boolean {
    const text = this.read()
    if (!old || text.split(old).length !== 2) return false
    this.write(text.replace(old, () => replacement))
    return true
  }

  /**
   * Replace the whole file (consolidation).
   * @param text - new MEMORY.md content.
   * @throws MemoryFullError when the text exceeds the cap.
   */
  rewrite(text: string): void {
    this.write(`${text.replace(/\n+$/u, '')}\n`)
  }

  /**
   * Render MEMORY.md as model context.
   * @returns the memory without source tags, wrapped with its size; empty when there is none.
   */
  renderForPrompt(): string {
    const text = this.read().trim()
    if (!text) return ''
    const body = text.split('\n').map(line => line.replace(SOURCE_TAG, '')).join('\n')
    return `<memory size="${this.size()}/${this.capBytes} bytes">\n${body}\n</memory>`
  }

  private write(text: string): void {
    const size = Buffer.byteLength(text, 'utf8')
    if (size > this.capBytes) throw new MemoryFullError(size, this.capBytes)
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, this.path)
  }
}
