/**
 * The `ask_image` tool: lets a model on a text-only route use images. The
 * image and the question go to a configured image-capable model in an
 * auxiliary request; only the text answer returns to the calling model, so
 * its history never carries an image block it could not accept.
 * @module @deepseek-ai/dsh-vision-bridge
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions, ImageBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-vision-bridge': { kind: 'dsh-vision-bridge' } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vision-bridge'

/** Required services. */
export const inject = ['tools', 'fs', 'llm', 'attachments']

/** Plugin config; every field has a validated default. */
export interface Config {
  /** Provider of the image-capable model; empty uses the calling agent's provider. */
  provider?: string
  /** Image-capable model that answers. */
  model?: string
  /** Output token cap of one answer. */
  maxTokens?: number
  /** Deadline of one answer. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().default(''),
  model: z.string().default('deepseek-flash'),
  maxTokens: z.natural().min(64).default(1500),
  timeoutMs: z.natural().min(1000).default(120_000),
})

type ResolvedConfig = Required<Config>

/** System prompt of the auxiliary request. */
export const BRIDGE_SYSTEM = 'You describe images for another assistant that cannot see them. '
  + 'Answer the question precisely and completely from the image: transcribe any text, error messages, numbers and labels exactly, '
  + 'and describe layout only as far as it matters for the question. Do not guess beyond what is visible.'

const IMAGE_TYPES: Readonly<Record<string, 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}

async function resolveTarget(ctx: Context, exec: ToolExecution, requested: string) {
  const directory = ctx.get('workingDirectory')
  const cwd = exec.agent === undefined || directory === undefined ? undefined : await directory.ensure(exec.agent, exec.signal)
  const target = await ctx.fs.resolve(requested, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return target
}

/**
 * Register `ask_image`.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = config as ResolvedConfig
  ctx.tools.register(defineTool({
    name: 'ask_image',
    description: 'Ask a question about an image file (PNG/JPEG/WebP/GIF) and get a text answer from a vision model. '
      + 'Use it when you cannot view images yourself, e.g. screenshots, diagrams, scanned pages, or frames saved by other tools.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file.' },
      question: { type: 'string', required: true, description: 'What you need to know; ask for exact text when it matters.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { model: { type: 'string', required: true }, answer: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `<answer model="${value.model}">\n${value.answer}\n</answer>` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const ext = /\.[^./]+$/u.exec(args.file_path.toLowerCase())?.[0] ?? ''
      const mediaType = IMAGE_TYPES[ext]
      if (mediaType === undefined) throw new Error(`cannot read "${args.file_path}": ask_image accepts PNG/JPEG/WebP/GIF files`)
      const target = await resolveTarget(ctx, exec, args.file_path)
      const data = await ctx.fs.readBytes(target, exec.signal, ctx.attachments.imageLimits.maxImageBytes)
      const ref = await ctx.attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })

      const provider = cfg.provider || exec.agent?.session.requestHeader()?.config.provider || exec.agent?.options.provider
      if (!provider) throw new Error('ask_image: no provider configured and the calling route has none')
      const info = await ctx.llm.resolveModelInfo(provider, cfg.model, exec.signal)
      if (!(info.inputModalities?.includes('image') ?? false)) {
        throw new Error(`ask_image: configured model "${cfg.model}" does not declare image input; configure an image-capable model`)
      }
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(cfg.timeoutMs)])
      const call = await ctx.llm.prepareCall({ provider, model: cfg.model, maxTokens: cfg.maxTokens }, signal)
      const image: ImageBlock = { type: 'image', attachment: ref }
      const options: GenerateOptions = {
        ...call.config,
        messages: [createUserMessage({ content: [image, { type: 'text', text: args.question }], source: { kind: 'dsh-vision-bridge' } })],
        system: BRIDGE_SYSTEM,
        ...exec.agent === undefined ? {} : { sessionId: exec.agent.session.header.id },
        signal,
      }
      const assembler = new BlockAssembler()
      for await (const chunk of call.stream(options)) assembler.push(chunk)
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(`ask_image: the vision model failed: ${finish.failure.message}`)
      const answer = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
      return { model: `${provider}/${cfg.model}`, answer: answer || '(the vision model returned no answer)' }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Ask about ${args.file_path}`, kind: 'read', locations: [{ path: args.file_path }] }
    },
  }))
}
