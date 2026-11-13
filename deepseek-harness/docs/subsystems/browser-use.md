# Browser use

English | [中文](browser-use.zh.md)

Browser use lets a model inspect and operate web pages through a configured backend. DSH owns the task loop; the provider supplies browser operations and keeps browser state across turns of one live Session.

## Choose a provider

Mount [`dsh-browser-use`](../../packages/browser-use/browser-use/README.md) and one provider in the same composition. The providers are experimental public npm packages and require explicit activation. Their initial browser engine is Chromium.

| Provider | Integration |
|---|---|
| [Playwright MCP](../../packages/experimental/browser-use-playwright-mcp/README.md) | Playwright's browser-control MCP tools |
| [Chrome DevTools MCP](../../packages/experimental/browser-use-chrome-devtools-mcp/README.md) | Chrome DevTools inspection and control through MCP |
| [Stagehand](../../packages/experimental/browser-use-stagehand-native/README.md) | Native browser operations with AI-assisted actions, observation, and extraction |

The shared service registers only a name and rejects any second provider, including another instance with the same name. It has no common browser-operation methods, browser resources, or model-controlled selector. Provider configuration in a profile or preset selects launch or attachment for that activation.

## Session ownership

A launched browser belongs to the exact live Agent and Session that uses it. Calls across turns reuse that browser. Disposing the Session runtime closes its launched resources; reloading or forking a Session starts fresh browser state. Browser profiles and login state are not restored from the Session log.

An attached browser remains externally owned. The provider reserves it for one Session within that provider instance, preserves its existing browser state, and rejects simultaneous attachment by another Session. Teardown disconnects and leaves the external browser running. Separate DSH processes and other clients remain outside this reservation.

Provider shutdown stops tool admission and waits for owned work and resource cleanup before releasing the shared provider registration. Cancellation cannot undo a browser action already delivered.

## MCP initialization

An MCP provider initializes one client for each live Agent created after the provider loads. The existing serial `agent/created` event awaits connection and discovery before creation or resume completes and queued input runs. The client remains with the Session across turns. Startup failure or cancellation rejects creation or resume and triggers client cleanup.

If an attachment is busy, that activation continues without the browser and does not retry on later turns. After release, a newly created or resumed activation can acquire it. Loading or reloading the provider does not adopt already active Sessions; the [shared runtime](../../packages/experimental/browser-use-runtime/README.md) owns these initialization rules.

## Tools and recorded results

Provider tools use the normal DSH execution pipeline and Session log. The providers own their tool schemas, result rendering, image support, configuration, and upstream limitations; the shared service adds no model-visible content. Stagehand's AI-assisted operations use its explicitly configured native model while DSH retains the task loop. DSH model routing, credential reuse, underlying inference request/response capture, and integration into Session usage accounting are deferred; returned SDK data and metadata remain ordinary logged tool results.

Browser MCP connections also expose [resources and server instructions](mcp.md). Resource calls addressed to a browser server use its Session queue and reject other Sessions; server instructions are assembled only for its owning Session.

The [decision record](../../.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.md) explains the registration-only service and per-Session ownership.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowseruse--browseruseregistry"></a>

### `ctx.browserUse` — `BrowserUseRegistry`

Owns one optional provider registration in the shared browser-use service.

```ts cordis-catalog
/**
 * Reserve the sole provider slot until the contribution is disposed.
 * A second registration fails even when it repeats the current name. Providers
 * must stop their tools and await owned work before releasing this registration.
 * @param name - provider-owned name used in registration diagnostics.
 * @returns the effect disposer for this exact registration.
 */
register(name: BrowserUseProviderName): () => Promise<void>
```

Source: [`packages/browser-use/browser-use/src/index.ts`](../../packages/browser-use/browser-use/src/index.ts)

<a id="ctxcocanvas--cocanvas"></a>

### `ctx.coCanvas` — `CoCanvas`

Owner of the shared browser and of the user's marks and control.

```ts cordis-catalog
/**
 * Follow the browser and collaboration state.
 * @param signal - Client observation lifetime.
 * @returns the current state, then each change.
 */
@Remote({ mode: 'stream' }) async* follow(signal: AbortSignal): AsyncIterable<CanvasState>

/**
 * Stream JPEG frames of the active page.
 * @param signal - Client observation lifetime.
 * @returns frames; slow readers receive only the newest. While the agent is paused the stream
 * holds its last frame, so the user marks a still view.
 */
@Remote({ mode: 'stream' }) frames(signal: AbortSignal): AsyncIterable<CanvasFrame>

/**
 * Stream JPEG frames of the primary display.
 * @param signal - Client observation lifetime.
 * @returns frames sized in screen points, one per configured interval. While the agent is paused
 * no screenshot is taken, so the last frame stays on screen and desktop marks are cropped from it.
 * @throws RemoteError when the desktop surface is disabled.
 */
@Remote({ mode: 'stream' }) desktopFrames(signal: AbortSignal): AsyncIterable<CanvasFrame>

/**
 * Ask a light model about the screen without stopping the agent. On the live view the draft marks
 * are the subject, and the agent never receives them as instructions; on a timeline step, the marks
 * drawn on that step's frame are. The question and answer are then left for the agent at its next
 * step, without waking it or asking it to reply.
 * @param question - the user's question.
 * @param step - timeline step the marks were drawn on; omitted for the live view.
 * @param marks - marks on that step's frame, in its coordinates.
 * @returns the answer's id; its text arrives through `follow`.
 */
@Remote async ask(question: string, step?: string, marks?: readonly MarkInput[]): Promise<string>

/**
 * List the models that can answer side questions: every model of every provider with credentials.
 * @returns models, image-capable ones first.
 */
@Remote async askModels(): Promise<ModelChoice[]>

/**
 * Choose the model that answers side questions and summarizes the task brief.
 * @param choice - the model, as listed by `askModels`.
 */
@Remote async setAskModel(choice: ModelChoice): Promise<void>

/**
 * Pause the agent while a side question is answered, or let it keep working.
 * @param on - pause while answering.
 */
@Remote async setPauseOnAsk(on: boolean): Promise<void>

/**
 * Correct the task brief's goal; an empty goal returns to following the user's requests.
 * @param goal - the goal as the user wants it understood.
 */
@Remote editGoal(goal: string): void

/**
 * The screen after one timeline step.
 * @param step - step id.
 * @returns the frame.
 * @throws RemoteError when the step is no longer kept.
 */
@Remote async stepFrame(step: string): Promise<CanvasFrame>

/**
 * Send the agent back to an earlier step: its next browser or desktop action is refused, and it
 * receives the step's screen with the user's marks, the actions it took since, and the request to
 * return to that state before continuing. The agent resumes if it was paused.
 * @param step - step id.
 * @param marks - marks on that step's frame, in its coordinates.
 * @param note - what went wrong, in the user's words.
 * @throws RemoteError when the step is gone or no agent has acted yet.
 */
@Remote async rewind(step: string, marks: readonly MarkInput[], note: string): Promise<void>

/**
 * Mark the real screen: after a delay, show a frozen screenshot full screen and collect marks on it.
 * @param delayMs - time to bring the screen to mark to the front.
 * @param locale - language of the marker's toolbar, the panel's own.
 * @param defaultQuestion - question asked when the user asks without writing a note, in that language.
 * @returns what the user chose and how many marks were recorded.
 * @throws RemoteError when the desktop surface is disabled.
 */
@Remote async markScreen(delayMs: number, locale?: string, defaultQuestion?: string): Promise<ScreenMarkOutcome>

/**
 * Record one mark as a draft, grounded to the element or window under its focus point. A draft
 * reaches the agent only once the user sends it; asking about it never does.
 * @param input - shape, rectangle in page CSS pixels or screen points, optional note.
 * @returns the recorded mark.
 */
@Remote mark(input: MarkInput): Promise<CanvasMark>

/**
 * Withdraw a draft or an undelivered mark.
 * @param id - mark id.
 */
@Remote removeMark(id: string): void

/**
 * Send the draft marks to the agent as instructions. A working agent receives them with its next
 * tool result, and an action it chose before them is refused; an idle agent takes no next step, so
 * the marks start a turn instead.
 * @param note - the user's instruction, attached to the last draft.
 */
@Remote async send(note?: string): Promise<void>

/**
 * Give the browser to the agent, pause it, or take it.
 * @param control - new holder.
 */
@Remote setControl(control: CanvasControl): void

/**
 * Replay the user's input on the shared browser.
 * @param input - click, scroll, text, or key press.
 * @throws RemoteError unless the user holds control.
 */
@Remote async input(input: CanvasInput): Promise<void>

/**
 * Answer the open question with the marks drawn so far.
 * @param questionId - the question being answered.
 */
@Remote answer(questionId: string): void
```

Source: [`packages/experimental/co-canvas/src/index.ts`](../../packages/experimental/co-canvas/src/index.ts)
<!-- END GENERATED cordis-surface -->
