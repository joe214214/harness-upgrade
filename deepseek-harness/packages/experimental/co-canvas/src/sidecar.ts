/**
 * Side questions: the user asks about the screen while the agent works, and a light model answers
 * from the task brief and the marked screenshots in one request, without the agent's history or tools.
 * @module @deepseek-ai/dsh-experimental-co-canvas/sidecar
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ModelChoice } from './types.ts'

/** The model directory and calls of the LLM service that side questions use. */
export type SideModels = Pick<Context['llm'], 'listProviders' | 'listModels' | 'resolveModelInfo' | 'prepareCall'>

/** Instructions of a side question. */
export const SIDE_SYSTEM = 'You answer quick questions from a user who is watching a computer-use agent work on their screen. '
  + 'The task brief says what the agent is doing and where; screenshots show what the user marked in red. '
  + 'Answer in the user\'s language, in one to three short sentences, from what you can see and the brief. '
  + 'Do not give the agent instructions and do not claim to act; if the answer is not visible, say so.'

/**
 * List the models of every provider with credentials.
 * @param llm - the LLM service.
 * @param signal - cancellation.
 * @returns models, image-capable ones first, then by provider order.
 */
export async function listChoices(llm: SideModels, signal: AbortSignal): Promise<ModelChoice[]> {
  const choices: ModelChoice[] = []
  for (const provider of llm.listProviders()) {
    if (signal.aborted) break
    try {
      for (const m of await llm.listModels(provider.id)) {
        choices.push({ provider: provider.id, model: m.id, name: m.name, image: m.inputModalities?.includes('image') ?? false })
      }
    } catch (error) {
      // A provider without credentials lists no models.
      void error
    }
  }
  return choices.sort((a, b) => Number(b.image) - Number(a.image))
}

/**
 * Resolve the configured side-question model to a provider that offers it.
 * @param llm - the LLM service.
 * @param provider - configured provider; empty searches every provider.
 * @param model - configured model id.
 * @param signal - cancellation.
 * @returns the choice, or undefined when no provider with credentials offers the model.
 */
export async function resolveChoice(
  llm: SideModels, provider: string, model: string, signal: AbortSignal,
): Promise<ModelChoice | undefined> {
  const providers = provider !== '' ? [provider] : llm.listProviders().map(p => p.id)
  for (const id of providers) {
    try {
      const info = await llm.resolveModelInfo(id, model, signal)
      // A provider can resolve a model it cannot call; listing proves its credentials.
      const listed = (await llm.listModels(id)).some(m => m.id === model)
      if (listed) return { provider: id, model, name: info.name, image: info.inputModalities?.includes('image') ?? false }
    } catch (error) {
      // Not offered by this provider; the next one is tried.
      void error
    }
  }
  return undefined
}

/** One side question as sent to the model. */
export interface SideRequest {
  readonly choice: ModelChoice
  /** Task brief and context lines. */
  readonly context: string
  readonly question: string
  /** Stored images: the marks' crops, or the whole screen when nothing was marked. */
  readonly images: readonly ImageAttachmentRef[]
  readonly maxTokens: number
  readonly signal: AbortSignal
  /** Instructions; defaults to {@link SIDE_SYSTEM}. */
  readonly system?: string
}

/**
 * Ask the side-question model and stream its answer.
 * @param llm - the LLM service.
 * @param request - the question, its context and images.
 * @param onText - receives the answer so far as it grows.
 * @returns the full answer.
 */
export async function askSide(llm: SideModels, request: SideRequest, onText: (text: string) => void): Promise<string> {
  const { choice } = request
  // The least reasoning the model offers: a side question is a quick look, not a plan.
  const call = await llm.prepareCall({ provider: choice.provider, model: choice.model, maxTokens: request.maxTokens }, request.signal,
    (controls, info) => {
      const least = info.reasoning?.efforts[0]?.id
      return least === undefined ? controls : { ...controls, reasoningEffort: least }
    })
  const content: ContentBlock[] = [{ type: 'text', text: `${request.context}\n\n${request.question}` }]
  if (choice.image) for (const attachment of request.images) content.push({ type: 'image', attachment })
  const options: GenerateOptions = {
    ...call.config,
    messages: [createUserMessage({ content, source: { kind: 'dsh-co-canvas' } })],
    system: request.system ?? SIDE_SYSTEM,
    signal: request.signal,
  }
  let text = ''
  for await (const chunk of call.stream(options)) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      onText(text)
    } else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(chunk.reason.failure.message)
    }
  }
  return text.trim()
}
