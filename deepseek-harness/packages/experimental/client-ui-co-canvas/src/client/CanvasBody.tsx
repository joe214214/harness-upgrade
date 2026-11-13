/**
 * Live view of the shared browser or the desktop, with marking tools and control buttons, the task
 * brief, side questions, the timeline of the agent's actions, and the agent's open question.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasControl, CanvasFrame, CanvasMark, CanvasRect, CanvasSurface, MarkInput, MarkShape } from '@deepseek-ai/dsh-experimental-co-canvas/types'
import type { CanvasInjected } from './face.ts'
import { Answers } from './Answers.tsx'
import { BriefCard } from './Brief.tsx'
import { TimelineStrip } from './TimelineStrip.tsx'
import type {} from './locales.ts'
import css from './CanvasBody.module.css'

interface Point { readonly x: number; readonly y: number }

const SHAPES: readonly MarkShape[] = ['box', 'arrow', 'point']
const MIN_DRAG = 6
const SURFACES: readonly CanvasSurface[] = ['browser', 'desktop']
/** Time to bring the screen to mark to the front before it is frozen. */
const SCREEN_MARK_DELAY_MS = 3000

/** Keys forwarded by name while the user holds control; printable keys are sent as text. */
const NAMED_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

function MarkGlyph({ mark, index, head }: { readonly mark: Pick<MarkInput, 'shape' | 'rect'>; readonly index?: number; readonly head: CanvasSurface }): ReactNode {
  const { x, y, width, height } = mark.rect
  const label = index === undefined ? null : <text className={css.label} x={x + 4} y={y - 6}>{index}</text>
  if (mark.shape === 'point') return <g><circle className={css.point} cx={x} cy={y} r={9} />{label}</g>
  if (mark.shape === 'arrow') {
    return <g><line className={css.stroke} x1={x} y1={y} x2={x + width} y2={y + height} markerEnd={`url(#co-canvas-head-${head})`} />{label}</g>
  }
  return <g>
    <rect className={css.stroke} x={Math.min(x, x + width)} y={Math.min(y, y + height)}
      width={Math.abs(width)} height={Math.abs(height)} rx={4} />
    {label}
  </g>
}

/** Rectangle of a mark drawn from `start` to `end`: normalized for boxes, directed for arrows, empty for points. */
function rectOf(shape: MarkShape, start: Point, end: Point): CanvasRect {
  if (shape === 'point') return { x: start.x, y: start.y, width: 0, height: 0 }
  if (shape === 'arrow') return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y }
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}

const shapeOf = (shape: MarkShape, start: Point, end: Point): MarkShape => (Math.hypot(end.x - start.x, end.y - start.y) >= MIN_DRAG ? shape : 'point')

/**
 * Render the co-canvas tab.
 * @param props - live state and frame hooks, Host actions, and localized copy.
 * @returns the panel.
 */
export function CanvasBody({
  t, useCanvas, useFrame, useDesktopFrame, mark, removeMark, setControl, input, answer, markScreen,
  send, ask, askModels, setAskModel, setPauseOnAsk, editGoal, stepFrame, rewind,
}: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'coCanvas'> & InjectFace<CanvasInjected>): ReactNode {
  const state = useCanvas(s => s)
  const [view, setView] = useState<CanvasSurface>('desktop')
  const [shape, setShape] = useState<MarkShape>('box')
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [step, setStep] = useState<string | null>(null)
  const [past, setPast] = useState<{ step: string; frame: CanvasFrame } | null>(null)
  const [stepMarks, setStepMarks] = useState<MarkInput[]>([])
  // Whether opening a step paused the agent, so returning to Live resumes it.
  const pausedForStep = useRef(false)
  const control: CanvasControl = state?.control ?? 'agent'
  const human = control === 'human'
  const desktop = view === 'desktop' && state?.desktop === true
  const drafts = state?.drafts ?? []
  const pending = state?.pending ?? []
  const question = state?.question ?? null
  const steps = state?.timeline ?? []
  const latestSurface = steps.at(-1)?.surface
  const shownStep = step === null ? undefined : steps.find(s => s.id === step)
  const report = (action: Promise<unknown>): void => {
    setNotice(null)
    action.catch((error: unknown) => { setNotice(error instanceof Error ? error.message : String(error)) })
  }
  // The view follows the surface the agent works on; the user can still switch it.
  useEffect(() => {
    if (latestSurface !== undefined) setView(latestSurface)
  }, [latestSurface])
  useEffect(() => {
    if (step === null) return undefined
    let current = true
    stepFrame(step).then((frame) => { if (current) setPast({ step, frame }) }, (error: unknown) => {
      if (current) setNotice(error instanceof Error ? error.message : String(error))
    })
    return () => { current = false }
  }, [step, stepFrame])
  // Going back to a step pauses the agent, so the screen does not move on while the user looks back;
  // returning to Live resumes it unless the user paused it themselves.
  const selectStep = (id: string | null, resume = true): void => {
    setStep(id)
    setStepMarks([])
    setPast(null)
    if (id !== null && control === 'agent') {
      pausedForStep.current = true
      report(setControl('paused'))
    } else if (id === null && pausedForStep.current) {
      pausedForStep.current = false
      if (resume && control === 'paused') report(setControl('agent'))
    }
  }
  const sendQuestion = (): void => {
    const q = text.trim() === '' ? t('ask.default') : text
    report(step === null ? ask(q) : ask(q, step, stepMarks))
    setText('')
    setStepMarks([])
  }
  const sendMarks = (): void => {
    report(send(text))
    setText('')
  }
  const sendRewind = (): void => {
    if (step === null) return
    report(rewind(step, stepMarks, text))
    setText('')
    pausedForStep.current = false
    selectStep(null, false)
  }
  const controlText = control === 'agent' && state !== null && !state.busy
    ? t('control.idle')
    : control === 'human' && desktop ? t('control.humanDesktop') : t(`control.${control}`)
  const where = shownStep === undefined
    ? (!desktop && state !== null && state.url !== '' ? ` · ${state.title || state.url}` : '')
    : ` · ${t('timeline.step', { n: String(shownStep.index) })}`
  const canRewind = text.trim() !== '' || stepMarks.length > 0

  return <div className={css.body}>
    {state?.desktop === true && <div className={css.group} role="radiogroup" aria-label={t('surface.label')}>
      {SURFACES.map(s => <Button key={s} size="sm" variant={s === view ? 'outline' : 'ghost'} role="radio" aria-checked={s === view}
        onClick={() => { setView(s); selectStep(null) }}>{t(`surface.${s}`)}</Button>)}
    </div>}
    <BriefCard brief={state?.brief ?? null} editGoal={editGoal} report={report} t={t} />
    <div className={css.toolbar}>
      <div className={css.group} role="radiogroup" aria-label={t('tool.label')}>
        {SHAPES.map(s => <Button key={s} size="sm" variant={s === shape ? 'outline' : 'ghost'} role="radio" aria-checked={s === shape}
          disabled={human && !desktop && step === null} onClick={() => { setShape(s) }}>{t(`tool.${s}`)}</Button>)}
      </div>
      <div className={css.group}>
        {control === 'agent' && <Button size="sm" variant="ghost" onClick={() => { pausedForStep.current = false; report(setControl('paused')) }}>{t('pause')}</Button>}
        {control === 'paused' && <Button size="sm" variant="ghost" onClick={() => { selectStep(null, false); report(setControl('agent')) }}>{t('resume')}</Button>}
        {human
          ? <Button size="sm" variant="primary" onClick={() => { report(setControl('agent')) }}>{t('handBack')}</Button>
          : <Button size="sm" variant="outline" onClick={() => { selectStep(null, false); report(setControl('human')) }}>{t('take')}</Button>}
      </div>
    </div>
    <div className={css.status} data-control={control}>{controlText}{where}</div>
    {notice !== null && <div className={css.status} role="alert">{notice}</div>}
    {question !== null && <div className={css.question}>
      <span>{t('ask')} <strong>{question.text}</strong></span>
      <Button size="sm" variant="primary" onClick={() => { report(answer(question.id)) }}>{t('answer')}</Button>
    </div>}
    {desktop && step === null && <div className={css.toolbar}>
      <Button size="sm" variant="outline" onClick={() => { report(markScreen(SCREEN_MARK_DELAY_MS, document.documentElement.lang || navigator.language, t('ask.default'))) }}>{t('markScreen')}</Button>
      <span className={css.status}>{t('markScreenHint')}</span>
    </div>}
    {step === null
      ? <LiveSurface key={desktop ? 'desktop' : 'browser'} t={t} useFrame={desktop ? useDesktopFrame : useFrame} surface={desktop ? 'desktop' : 'browser'}
        pending={[...pending, ...drafts]} shape={shape} replay={human && !desktop} failure={desktop ? null : state?.failure ?? null}
        mark={(value) => { report(mark(value)) }} input={(value) => { report(input(value)) }} />
      : <Surface t={t} frame={past?.step === step ? past.frame : null} surface={shownStep?.surface ?? 'desktop'} glyphs={stepMarks} shape={shape}
        replay={false} failure={null} mark={(value) => { setStepMarks(marks => [...marks, value]) }} input={() => {}} />}
    <TimelineStrip steps={steps} selected={step} select={(id) => { selectStep(id) }} t={t} />
    {shownStep !== undefined && <div className={css.status}>{t('timeline.hint')}{shownStep.irreversible ? ` · ${t('timeline.irreversible')}` : ''}</div>}
    {step === null && drafts.length > 0 && <div className={css.pending}>
      <div className={css.pendingTitle}>{t('drafts')}</div>
      <ol className={css.list}>
        {drafts.map(m => <li key={m.id} className={css.item}>
          <span className={css.itemText}>{describe(m, t)}</span>
          <Button size="sm" variant="ghost" onClick={() => { report(removeMark(m.id)) }}>{t('remove')}</Button>
        </li>)}
      </ol>
    </div>}
    <div className={css.askRow}>
      <input className={css.note} value={text} placeholder={t('note')} aria-label={t('note')}
        onChange={(event) => { setText(event.target.value) }}
        onKeyDown={(event) => {
          // Enter that confirms an input-method composition (Chinese, Japanese) is not a submit.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) sendQuestion()
        }} />
      <Button size="sm" variant="primary" onClick={sendQuestion}>{t('ask.button')}</Button>
      {step === null
        ? <Button size="sm" variant="outline" disabled={drafts.length === 0} onClick={sendMarks}>{t('ask.send')}</Button>
        : <Button size="sm" variant="outline" disabled={!canRewind} onClick={sendRewind}>{t('rewind')}</Button>}
    </div>
    {step === null && pending.length > 0 && <div className={css.status}>
      {t('pending')} {pending.map(m => describe(m, t)).join('; ')}
    </div>}
    <Answers answers={state?.answers ?? []} askModel={state?.askModel ?? null} pauseOnAsk={state?.pauseOnAsk ?? false}
      askModels={askModels} setAskModel={setAskModel} setPauseOnAsk={setPauseOnAsk} report={report} t={t} />
  </div>
}

/** One line naming what a pending mark points at. */
function describe(m: CanvasMark, t: PropsLocale<'coCanvas'>['t']): string {
  if (m.surface === 'desktop') return m.window === undefined ? t('noWindow') : `${t('surface.desktop')} · ${m.window.title || m.window.app}`
  return m.target === undefined ? t('noElement') : `${m.target.role ?? m.target.tag} "${m.target.text || m.target.label || ''}"`
}

interface SurfaceProps {
  readonly t: PropsLocale<'coCanvas'>['t']
  readonly frame: CanvasFrame | null
  readonly surface: CanvasSurface
  /** Marks drawn on this frame, numbered in order. */
  readonly glyphs: readonly Pick<MarkInput, 'shape' | 'rect'>[]
  readonly shape: MarkShape
  /** The user holds control of the browser: pointer and keys are replayed instead of drawing marks. */
  readonly replay: boolean
  readonly failure: string | null
  readonly mark: (input: Parameters<CanvasInjected['mark']>[0]) => void
  readonly input: (input: Parameters<CanvasInjected['input']>[0]) => void
}

/** The live frame of one surface with its undelivered marks; remounted when the surface changes so each streams only while shown. */
function LiveSurface(props: Omit<SurfaceProps, 'frame' | 'glyphs'> & {
  readonly useFrame: InjectFace<CanvasInjected>['useFrame']
  readonly pending: readonly CanvasMark[]
}): ReactNode {
  const frame: CanvasFrame | null = props.useFrame(f => f)
  const glyphs = props.pending.filter(m => m.surface === props.surface)
  return <Surface {...props} frame={frame} glyphs={glyphs} />
}

/** One frame with marks drawn on it: the live view, or the screen after a timeline step. */
function Surface({ t, frame, surface: kind, glyphs, shape, replay, failure, mark, input }: SurfaceProps): ReactNode {
  const [draft, setDraft] = useState<{ start: Point; end: Point } | null>(null)
  const surface = useRef<HTMLDivElement>(null)

  const toPage = (event: { clientX: number; clientY: number }): Point | undefined => {
    const box = surface.current?.getBoundingClientRect()
    if (box === undefined || frame === null || box.width === 0) return undefined
    return { x: (event.clientX - box.left) * frame.width / box.width, y: (event.clientY - box.top) * frame.height / box.height }
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const point = toPage(event)
    if (point === undefined) return
    surface.current?.focus()
    if (replay) { input({ type: 'click', x: point.x, y: point.y }); return }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraft({ start: point, end: point })
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const point = draft === null ? undefined : toPage(event)
    if (draft !== null && point !== undefined) setDraft({ start: draft.start, end: point })
  }
  const onPointerUp = (): void => {
    if (draft === null) return
    const { start, end } = draft
    setDraft(null)
    const drawn = shapeOf(shape, start, end)
    mark({ surface: kind, shape: drawn, rect: rectOf(drawn, start, end) })
  }
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const point = replay ? toPage(event) : undefined
    if (point !== undefined) input({ type: 'scroll', x: point.x, y: point.y, deltaY: event.deltaY })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!replay || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.length === 1) input({ type: 'text', text: event.key })
    else if (NAMED_KEYS.has(event.key)) input({ type: 'key', key: event.key })
    else return
    event.preventDefault()
  }

  const draftShape = draft === null ? null : shapeOf(shape, draft.start, draft.end)
  const draftMark = draft === null || draftShape === null ? null : { shape: draftShape, rect: rectOf(draftShape, draft.start, draft.end) }

  return <div ref={surface} className={css.surface} data-human={replay} tabIndex={0} aria-label={t(kind === 'desktop' ? 'desktopView' : 'view')}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel} onKeyDown={onKeyDown}>
    {frame === null
      ? <div className={css.waiting}>{failure === null ? t(kind === 'desktop' ? 'waitingDesktop' : 'waiting') : `${t('failed')} ${failure}`}</div>
      : <>
        <img className={css.frame} src={`data:image/jpeg;base64,${frame.data}`} alt="" draggable={false} />
        <svg className={css.overlay} viewBox={`0 0 ${frame.width} ${frame.height}`} preserveAspectRatio="none">
          <defs><marker id={`co-canvas-head-${kind}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path className={css.head} d="M0,0 L10,5 L0,10 z" /></marker></defs>
          {glyphs.map((m, i) => <MarkGlyph key={i} mark={m} index={i + 1} head={kind} />)}
          {draftMark !== null && <MarkGlyph mark={draftMark} head={kind} />}
        </svg>
      </>}
  </div>
}
