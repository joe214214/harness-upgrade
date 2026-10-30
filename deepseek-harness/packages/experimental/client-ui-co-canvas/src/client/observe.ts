/** Host streams mirrored into observables that run only while a view subscribes. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Mirror one Host stream; the stream opens on the first subscriber and closes after the last.
 * @param ctx - Client runtime owning the Remote.
 * @param name - diagnostic stream name.
 * @param open - opens the Remote stream.
 * @returns the latest value (null before the first item and after a carrier failure) and a disposer.
 */
export function liveStream<T>(ctx: Context, name: string, open: (signal: AbortSignal) => AsyncIterable<T>): { store: HostObservable<T | null>; dispose: () => Promise<void> } {
  let value: T | null = null
  const listeners = new Set<() => void>()
  let running: { readonly stop: () => Promise<void> } | undefined
  const set = (next: T | null): void => { value = next; for (const listener of listeners) listener() }
  const start = (): void => {
    const stream = ctx.remote.$stream<T>({
      name, open, ended: () => new RemoteStreamCarrierError(`${name} ended`), carrierFailed: () => { set(null) },
    })
    const loop = (async () => {
      try {
        for await (const item of stream) { set(item.value); item.accept() }
      } catch (error) {
        // The stream ended by disposal or a carrier failure that carrierFailed already reported.
        void error
      }
    })()
    running = { stop: async () => { await stream.dispose(); await loop } }
  }
  const stop = async (): Promise<void> => {
    const current = running
    running = undefined
    await current?.stop()
  }
  return {
    store: {
      getSnapshot: () => value,
      subscribe: (listener) => {
        listeners.add(listener)
        if (running === undefined) start()
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) void stop()
        }
      },
    },
    dispose: stop,
  }
}
