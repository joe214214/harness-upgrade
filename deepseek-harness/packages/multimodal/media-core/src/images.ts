/**
 * Route capability checks and durable image commits for media tools that
 * return rendered pages or video frames to the model.
 * @module @deepseek-ai/dsh-media-core/images
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Image fields persisted in a tool's canonical value; re-branded on render. */
export interface StoredImage {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

/** Output-schema fragment for one optional {@link StoredImage}; spread with `required: true` where it is mandatory. */
export const STORED_IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const

/**
 * Whether the calling route's exact model declares image input. Unlike
 * `read_image`, media tools degrade to text instead of refusing, so an
 * unresolvable route answers false.
 * @param ctx - context with the optional `llm` service.
 * @param exec - the tool execution supplying the calling agent.
 * @returns true only when the routed model lists `image` among its input modalities.
 */
export async function routeAcceptsImages(ctx: Context, exec: ToolExecution): Promise<boolean> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return false
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  return info.inputModalities?.includes('image') ?? false
}

/**
 * Commit one PNG produced by a media tool to the attachment store.
 * @param ctx - context with the `attachments` service mounted.
 * @param path - host path of the PNG file.
 * @param name - display name stored with the attachment.
 * @returns the persisted image fields.
 * @throws Error when no attachment store is mounted.
 */
export async function savePng(ctx: Context, path: string, name: string): Promise<StoredImage> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('no attachment service is mounted, so images cannot be returned')
  const ref = await attachments.saveImage({ data: await readFile(path), mediaType: 'image/png', name })
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...ref.name === undefined ? {} : { name: ref.name },
  }
}

/**
 * Build the image content block for a stored image.
 * @param image - persisted image fields from a canonical tool value.
 * @returns a native image block referencing the durable attachment.
 */
export function imageBlock(image: StoredImage): ContentBlock {
  const attachment: ImageAttachmentRef = {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
  return { type: 'image', attachment }
}
