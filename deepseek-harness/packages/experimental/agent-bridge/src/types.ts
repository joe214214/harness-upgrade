/** Wire types shared by the agent-bridge Host service and its Web panel. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The DeepSeek Harness Session is not loaded in this Host. */
    'agent-bridge/no-session': { readonly sessionId: string }
    /** No external session matches the agent and id. */
    'agent-bridge/not-found': { readonly agent: ExternalAgent; readonly id: string }
  }
}

/** Coding agents whose sessions and memory the bridge reads and writes. */
export type ExternalAgent = 'claude' | 'codex' | 'gemini'

/** One session of an external agent found on this machine. */
export interface ExternalSessionInfo {
  readonly agent: ExternalAgent
  /** The agent's own session id, as its resume command takes it. */
  readonly id: string
  /** Session file. */
  readonly path: string
  /** Working directory the session ran in, when recorded. */
  readonly cwd: string | null
  readonly title: string
  /** Last modification, epoch milliseconds. */
  readonly updatedAt: number
  /** Whether DeepSeek Harness wrote this session as an export. */
  readonly exported: boolean
}

/** An external session followed into a DeepSeek Harness Session. */
export interface FollowState {
  readonly sessionId: string
  readonly agent: ExternalAgent
  readonly id: string
  readonly title: string
  /** Messages delivered so far. */
  readonly relayed: number
  readonly status: 'following' | 'waiting' | 'missing'
  readonly error: string | null
}

/** Live export of one DeepSeek Harness Session to one external agent. */
export interface ExportState {
  readonly sessionId: string
  readonly agent: ExternalAgent
  readonly status: 'pending' | 'synced' | 'deferred' | 'unavailable' | 'error'
  /** Command that continues the exported session in that agent. */
  readonly resume: string | null
  readonly path: string | null
  /** Messages written so far. */
  readonly written: number
  readonly detail: string | null
  readonly updatedAt: number
}

/** One memory or instruction file of an external agent. */
export interface MemorySource {
  readonly agent: ExternalAgent
  readonly scope: 'user' | 'project'
  readonly kind: 'instructions' | 'memory'
  readonly path: string
  readonly bytes: number
  readonly updatedAt: number
}

/** Where DeepSeek Harness memory was last written for one agent. */
export interface MemoryExportState {
  readonly agent: ExternalAgent
  readonly paths: readonly string[]
  readonly facts: number
  readonly status: 'synced' | 'disabled' | 'error'
  readonly detail: string | null
  readonly updatedAt: number
}

/** Everything the Web panel shows. */
export interface BridgeState {
  readonly sessions: readonly ExternalSessionInfo[]
  readonly follows: readonly FollowState[]
  readonly exports: readonly ExportState[]
  readonly memorySources: readonly MemorySource[]
  readonly memoryExports: readonly MemoryExportState[]
}
