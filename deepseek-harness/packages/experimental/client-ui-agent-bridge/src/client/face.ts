/** Injected agent-bridge actions and observable state. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BridgeState, ExternalAgent } from '@deepseek-ai/dsh-experimental-agent-bridge/types'

/** Host actions and the live state for the agent-bridge tab. */
export interface BridgeInjected {
  readonly hooks: {
    readonly bridge: HostObservable<BridgeState | null>
  }
  readonly refresh: () => Promise<void>
  readonly open: (sessionId: string, agent: ExternalAgent, id: string) => Promise<void>
  readonly unfollow: (sessionId: string, agent: ExternalAgent, id: string) => Promise<void>
  readonly share: (sessionId: string, agent: ExternalAgent, enabled: boolean) => Promise<void>
  readonly syncMemory: () => Promise<void>
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The single agent-bridge tab. */
    'agent-bridge': Record<string, never>
  }
}
