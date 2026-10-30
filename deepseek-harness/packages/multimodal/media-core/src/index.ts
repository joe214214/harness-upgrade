/**
 * Shared building blocks for the multimodal read tools: media command
 * execution through `ctx.subprocess`, a content-addressed result cache,
 * page and time-window arguments, and durable image commits.
 * @module @deepseek-ai/dsh-media-core
 */

export { MediaCommandError, runMediaCommand } from './command.ts'
export type { CommandRequest, CommandResult } from './command.ts'
export { MediaCache, hashFile } from './cache.ts'
export { formatTimestamp, parsePageSelection, parseTimestamp, resolveWindow } from './ranges.ts'
export { STORED_IMAGE_SCHEMA, imageBlock, routeAcceptsImages, savePng } from './images.ts'
export type { StoredImage } from './images.ts'
