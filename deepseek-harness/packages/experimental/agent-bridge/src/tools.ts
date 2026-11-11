/**
 * The model-facing tools of the agent bridge. Definitions are built from a
 * set of operations so the tool catalog can describe them without a running
 * bridge.
 * @module @deepseek-ai/dsh-experimental-agent-bridge/tools
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ExternalAgent } from './types.ts'

/** What the tools do; the bridge service implements them. */
export interface BridgeToolOps {
  /** List sessions, optionally of one agent and matching words, preferring a workspace. */
  list(agent: ExternalAgent | undefined, query: string | undefined, cwd: string | null): string
  /** Render a session and, when a Session id is given, follow it into that Session. */
  open(agent: ExternalAgent, id: string, sessionId: string | null): string
  /** Render a range of a session's messages. */
  read(agent: ExternalAgent, id: string, start: number, count: number): string
  /** Share an agent's Session with other agents and describe how to continue there. */
  share(agent: Agent, targets: readonly ExternalAgent[]): Promise<string>
  /** List the other agents' memory files for a workspace, or read one of them. */
  memory(path: string | undefined, cwd: string | null): string
}

const AGENTS = ['claude', 'codex', 'gemini'] as const
const textOutput = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }

function run<T>(body: () => T): Promise<T> {
  try {
    return Promise.resolve(body())
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * The bridge's tool definitions.
 * @param ops - operations behind the tools.
 * @returns tools ready to register.
 */
export function agentBridgeTools(ops: BridgeToolOps): ToolDefinition[] {
  return [
    defineTool({
      name: 'external_sessions',
      description: 'List sessions of Claude Code, Codex, and Gemini CLI on this machine, best matches first, then sessions of the current workspace, then the newest. '
        + 'Use it when the user refers to work done in another coding agent.',
      parameters: {
        agent: { type: 'string', enum: [...AGENTS], description: 'Only this agent.' },
        query: { type: 'string', description: 'Words to look for in the title or working directory.' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => run(() => ops.list(args.agent, args.query, exec.agent?.session.header.cwd ?? null)),
    }),
    defineTool({
      name: 'open_external_session',
      description: 'Read another agent\'s session (the newest messages that fit) and keep following it: messages that agent adds later arrive in this '
        + 'conversation as <external_session_update>. Use read_external_session for older messages.',
      parameters: {
        agent: { type: 'string', enum: [...AGENTS], required: true },
        id: { type: 'string', required: true, description: 'Session id from external_sessions.' },
        follow: { type: 'boolean', description: 'Keep following new messages (default true).' },
      },
      output: textOutput,
      execute: (args, exec) => run(() => {
        const sessionId = args.follow === false ? null : exec.agent?.session.header.id ?? null
        return ops.open(args.agent, args.id, sessionId)
      }),
    }),
    defineTool({
      name: 'read_external_session',
      description: 'Read a range of messages of another agent\'s session, by position (0 is the first message).',
      parameters: {
        agent: { type: 'string', enum: [...AGENTS], required: true },
        id: { type: 'string', required: true },
        start: { type: 'number', required: true },
        count: { type: 'number', description: 'Messages to read (default 20).' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: args => run(() => ops.read(
        args.agent, args.id, Math.max(0, Math.floor(args.start)), Math.max(1, Math.floor(args.count ?? 20)),
      )),
    }),
    defineTool({
      name: 'share_session',
      description: 'Share this conversation live with Claude Code, Codex, or Gemini CLI: it is written as a native session of that agent and kept up to date '
        + 'after each turn, and what the other agent adds there is relayed back here. Returns the command that continues it in that agent.',
      parameters: {
        agents: { type: 'array', items: { type: 'string', enum: [...AGENTS] }, required: true },
      },
      output: textOutput,
      execute: (args, exec) => {
        if (exec.agent === undefined) return Promise.reject(new Error('share_session needs a conversation'))
        return ops.share(exec.agent, args.agents)
      },
    }),
    defineTool({
      name: 'external_memory',
      description: 'Read a memory or user-level instruction file of Claude Code, Codex, or Gemini CLI listed in <external_agent_memory>. Without a path, list them.',
      parameters: { path: { type: 'string', description: 'A path listed in <external_agent_memory>.' } },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => run(() => ops.memory(args.path, exec.agent?.session.header.cwd ?? null)),
    }),
  ]
}
