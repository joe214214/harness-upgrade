/** Browser entry: mount the co-canvas Remote and register its right-Sidebar tab. */
import type { Context } from '@deepseek-ai/cordis'
import coCanvasRemote from '@deepseek-ai/dsh-experimental-co-canvas/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasFrame, CanvasState } from '@deepseek-ai/dsh-experimental-co-canvas/types'
import { CanvasBody } from './CanvasBody.tsx'
import { CanvasTitle } from './CanvasTitle.tsx'
import type { CanvasInjected } from './face.ts'
import { liveStream } from './observe.ts'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

/** Tab implementation identity and keyed Slot dispatch key. */
export const CO_CANVAS_ID = '@deepseek-ai/dsh-experimental-client-ui-co-canvas'

/** Client services required before the Remote mounts. */
export const inject = ['remote', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** A Remote call result: unwrap the value or throw the Remote error. */
async function unwrap<T>(call: Promise<{ ok: true; value: T } | { ok: false; error: Error }>): Promise<T> {
  const result = await call
  if (!result.ok) throw result.error
  return result.value
}

function registerUi(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'co-canvas: copy')
  const state = liveStream<CanvasState>(ctx, 'Co-canvas state', signal => ctx.remote.coCanvas.follow(signal))
  const frames = liveStream<CanvasFrame>(ctx, 'Co-canvas frames', signal => ctx.remote.coCanvas.frames(signal))
  ctx.effect(() => async () => { await Promise.all([state.dispose(), frames.dispose()]) }, 'co-canvas: streams')
  const remote = ctx.remote.coCanvas
  const injected: CanvasInjected = {
    hooks: { canvas: state.store, frame: frames.store },
    mark: input => unwrap(remote.mark(input)),
    removeMark: id => unwrap(remote.removeMark(id)),
    setControl: control => unwrap(remote.setControl(control)),
    input: input => unwrap(remote.input(input)),
    answer: id => unwrap(remote.answer(id)),
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CO_CANVAS_ID, kind: 'co-canvas', title: () => t('title'),
    guide: [{ id: 'open', order: 40, title: () => t('title'), description: () => t('description'), icon: GuideArtworkBrowser }],
  }), 'co-canvas: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: CO_CANVAS_ID, locale: NS, inject: () => injected,
  }, CanvasBody)), 'co-canvas: body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: CO_CANVAS_ID, locale: NS,
  }, CanvasTitle)), 'co-canvas: title')
}

/**
 * Activate the co-canvas tab.
 * @param ctx - Client runtime owning the Remote, dictionaries, slots and Sidebar.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(coCanvasRemote)
  const ui = ctx.inject(['remote.coCanvas', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
