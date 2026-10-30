/**
 * Content-addressed cache for derived media results (transcripts, extracted
 * text, frame lists). Keys combine the source bytes' SHA-256 with the
 * processing parameters, so a renamed or copied file still hits, an edited
 * file misses, and resumed or forked Sessions reuse earlier work.
 * @module @deepseek-ai/dsh-media-core/cache
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * SHA-256 of a file's bytes, streamed so large media never loads whole.
 * @param path - host path of the file.
 * @param signal - cancellation.
 * @returns lowercase hex digest.
 */
export async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** A JSON value store keyed by source digest plus processing parameters. */
export class MediaCache {
  /**
   * @param dir - absolute directory owned by this cache; created on first write.
   */
  constructor(readonly dir: string) {}

  /**
   * Derive the entry key for one source and parameter set.
   * @param digest - source SHA-256 from {@link hashFile}.
   * @param kind - result family, e.g. `pdf-text` or `transcript`.
   * @param params - every parameter that changes the result.
   * @returns a filesystem-safe key.
   */
  key(digest: string, kind: string, params: Readonly<Record<string, string | number | boolean>>): string {
    const canonical = Object.keys(params).sort().map(k => `${k}=${String(params[k])}`).join('&')
    return `${kind}-${createHash('sha256').update(`${digest}|${canonical}`).digest('hex').slice(0, 32)}`
  }

  /**
   * Read one entry.
   * @param key - from {@link MediaCache.key}.
   * @returns the stored value, or undefined when absent or unreadable.
   */
  async get<T>(key: string): Promise<T | undefined> {
    let text: string
    try {
      text = await readFile(join(this.dir, `${key}.json`), 'utf8')
    } catch (error: unknown) {
      // A missing entry is the normal miss path; any other read failure is also treated as a miss.
      void error
      return undefined
    }
    try {
      return JSON.parse(text) as T
    } catch (error: unknown) {
      // A torn or foreign file is a miss; the next put replaces it atomically.
      void error
      return undefined
    }
  }

  /**
   * Store one entry atomically (write to a temp name, then rename).
   * @param key - from {@link MediaCache.key}.
   * @param value - JSON-serializable result.
   */
  async put(key: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.${key}.${process.pid}.tmp`)
    await writeFile(tmp, JSON.stringify(value))
    await rename(tmp, join(this.dir, `${key}.json`))
  }
}
