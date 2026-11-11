/** Browser entry: mount the agent-bridge Remote and register its right-Sidebar tab. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import agentBridgeRemote from '@deepseek-ai/dsh-experimental-agent-bridge/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { GuideArtworkFiles } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BridgeState } from '@deepseek-ai/dsh-experimental-agent-bridge/types'
import { BridgeBody } from './BridgeBody.tsx'
import { BridgeTitle } from './BridgeTitle.tsx'
import type { BridgeInjected } from './face.ts'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

/** Tab implementation identity and keyed Slot dispatch key. */
export const AGENT_BRIDGE_ID = '@deepseek-ai/dsh-experimental-client-ui-agent-bridge'

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
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'agent-bridge: copy')
  // One state stream for the plugin's lifetime: the tab shows sessions as soon as it opens.
  const bridge = createSnapshotStore<BridgeState | null>(null)
  ctx.effect(() => {
    const stream = ctx.remote.$stream<BridgeState>({
      name: 'Agent bridge state', open: signal => ctx.remote.agentBridge.follow(signal),
      ended: () => new RemoteStreamCarrierError('Agent bridge state ended'), carrierFailed: () => { bridge.set(null) },
    })
    const loop = (async () => {
      try {
        for await (const item of stream) { bridge.set(item.value); item.accept() }
      } catch (error) {
        // The stream ended by disposal or a carrier failure that carrierFailed already reported.
        void error
      }
    })()
    return async () => { await stream.dispose(); await loop }
  }, 'agent-bridge: state stream')
  const remote = ctx.remote.agentBridge
  const injected: BridgeInjected = {
    hooks: { bridge },
    refresh: () => unwrap(remote.refresh()),
    open: (sessionId, agent, id) => unwrap(remote.open(sessionId, agent, id)),
    unfollow: (sessionId, agent, id) => unwrap(remote.unfollow(sessionId, agent, id)),
    share: (sessionId, agent, enabled) => unwrap(remote.share(sessionId, agent, enabled)),
    syncMemory: () => unwrap(remote.syncMemory()),
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: AGENT_BRIDGE_ID, kind: 'agent-bridge', title: () => t('title'),
    guide: [{ id: 'open', order: 45, title: () => t('title'), description: () => t('description'), icon: GuideArtworkFiles }],
  }), 'agent-bridge: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: AGENT_BRIDGE_ID, locale: NS, inject: () => injected,
  }, BridgeBody)), 'agent-bridge: body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: AGENT_BRIDGE_ID, locale: NS,
  }, BridgeTitle)), 'agent-bridge: title')
}

/**
 * Activate the agent-bridge tab.
 * @param ctx - Client runtime owning the Remote, dictionaries, slots and Sidebar.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(agentBridgeRemote)
  const ui = ctx.inject(['remote.agentBridge', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
