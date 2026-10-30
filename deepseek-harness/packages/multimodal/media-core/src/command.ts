/**
 * Batch execution of media command-line tools (poppler, ffmpeg) through the
 * subprocess seam. Output is collected in memory; binary results are written
 * to files by the tools themselves, so only text crosses this boundary.
 * @module @deepseek-ai/dsh-media-core/command
 */

import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Explicit limits for one command run; nothing here is defaulted. */
export interface CommandRequest {
  /** Executable name or absolute path, then its arguments. Never shell-interpreted. */
  readonly argv: readonly [string, ...string[]]
  /** Working directory in the subprocess provider's execution world. */
  readonly cwd: string
  /** Deadline for the whole run. */
  readonly timeoutMs: number
  /** In-memory cap for stdout; stderr keeps a fixed diagnostic tail. */
  readonly maxStdoutBytes: number
  /** Caller cancellation. */
  readonly signal: AbortSignal
}

/** Text output and exit facts of one completed command. */
export interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  /** True when stdout exceeded `maxStdoutBytes` and only its tail was kept. */
  readonly truncated: boolean
}

/** A media command failed: missing executable, non-zero exit, or deadline. */
export class MediaCommandError extends Error {
  /**
   * @param message - model-facing explanation with a recovery hint.
   * @param code - stable failure category.
   */
  constructor(message: string, readonly code: 'MEDIA_TOOL_MISSING' | 'MEDIA_TOOL_FAILED' | 'MEDIA_TOOL_TIMEOUT') {
    super(message)
    this.name = 'MediaCommandError'
  }
}

const STDERR_TAIL_BYTES = 4096
const KILL_GRACE_MS = 2000

/**
 * Run one media tool to completion and return its text output.
 * @param ctx - context providing `ctx.subprocess`.
 * @param request - argv, directory, limits, and cancellation.
 * @param installHint - package names shown when the executable is missing.
 * @returns collected stdout/stderr of a zero-exit run.
 * @throws MediaCommandError for a missing executable, non-zero exit, or timeout.
 */
export async function runMediaCommand(ctx: Context, request: CommandRequest, installHint: string): Promise<CommandResult> {
  const [command, ...args] = request.argv
  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable(command, undefined, request.signal)
  } catch (error: unknown) {
    if (!(error instanceof SubprocessExecutableNotFoundError)) throw error
    throw new MediaCommandError(`${command} is not installed on this machine; install ${installHint}`, 'MEDIA_TOOL_MISSING')
  }
  const deadline = AbortSignal.timeout(request.timeoutMs)
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...args],
    cwd: request.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: request.maxStdoutBytes },
      stderr: { maxBytes: STDERR_TAIL_BYTES },
    },
    graceMs: KILL_GRACE_MS,
    signal: AbortSignal.any([request.signal, deadline]),
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (deadline.aborted && !request.signal.aborted) {
    throw new MediaCommandError(`${command} did not finish within ${request.timeoutMs} ms`, 'MEDIA_TOOL_TIMEOUT')
  }
  request.signal.throwIfAborted()
  if (outcome.exitCode !== 0) {
    const detail = stderr.trim().split('\n').slice(-3).join(' | ')
    throw new MediaCommandError(
      `${command} failed (exit ${outcome.exitCode ?? outcome.signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
      'MEDIA_TOOL_FAILED',
    )
  }
  return { stdout: stdout?.text ?? '', stderr, truncated: stdout?.lossy ?? false }
}
