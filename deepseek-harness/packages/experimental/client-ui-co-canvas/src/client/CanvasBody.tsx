/** Live view of the shared browser with marking tools, control buttons, and the agent's open question. */
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasControl, CanvasFrame, CanvasMark, CanvasRect, MarkShape } from '@deepseek-ai/dsh-experimental-co-canvas/types'
import type { CanvasInjected } from './face.ts'
import type {} from './locales.ts'
import css from './CanvasBody.module.css'

interface Point { readonly x: number; readonly y: number }

const SHAPES: readonly MarkShape[] = ['box', 'arrow', 'point']
const MIN_DRAG = 6

/** Keys forwarded by name while the user holds control; printable keys are sent as text. */
const NAMED_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

function MarkGlyph({ mark, index }: { readonly mark: Pick<CanvasMark, 'shape' | 'rect'>; readonly index?: number }): ReactNode {
  const { x, y, width, height } = mark.rect
  const label = index === undefined ? null : <text className={css.label} x={x + 4} y={y - 6}>{index}</text>
  if (mark.shape === 'point') return <g><circle className={css.point} cx={x} cy={y} r={9} />{label}</g>
  if (mark.shape === 'arrow') {
    return <g><line className={css.stroke} x1={x} y1={y} x2={x + width} y2={y + height} markerEnd="url(#co-canvas-head)" />{label}</g>
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
  t, useCanvas, useFrame, mark, removeMark, setControl, input, answer,
}: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'coCanvas'> & InjectFace<CanvasInjected>): ReactNode {
  const state = useCanvas(s => s)
  const frame: CanvasFrame | null = useFrame(f => f)
  const [shape, setShape] = useState<MarkShape>('box')
  const [note, setNote] = useState('')
  const [draft, setDraft] = useState<{ start: Point; end: Point } | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const control: CanvasControl = state?.control ?? 'agent'
  const human = control === 'human'

  const toPage = (event: { clientX: number; clientY: number }): Point | undefined => {
    const box = surface.current?.getBoundingClientRect()
    if (box === undefined || frame === null || box.width === 0) return undefined
    return { x: (event.clientX - box.left) * frame.width / box.width, y: (event.clientY - box.top) * frame.height / box.height }
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const point = toPage(event)
    if (point === undefined) return
    surface.current?.focus()
    if (human) { void input({ type: 'click', x: point.x, y: point.y }); return }
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
    const kind = shapeOf(shape, start, end)
    void mark({ shape: kind, rect: rectOf(kind, start, end), ...note === '' ? {} : { note } })
    setNote('')
  }
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const point = human ? toPage(event) : undefined
    if (point !== undefined) void input({ type: 'scroll', x: point.x, y: point.y, deltaY: event.deltaY })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!human || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.length === 1) void input({ type: 'text', text: event.key })
    else if (NAMED_KEYS.has(event.key)) void input({ type: 'key', key: event.key })
    else return
    event.preventDefault()
  }

  const pending = state?.pending ?? []
  const draftShape = draft === null ? null : shapeOf(shape, draft.start, draft.end)
  const draftMark = draft === null || draftShape === null ? null : { shape: draftShape, rect: rectOf(draftShape, draft.start, draft.end) }
  const question = state?.question ?? null

  return <div className={css.body}>
    <div className={css.toolbar}>
      <div className={css.group} role="radiogroup" aria-label={t('tool.label')}>
        {SHAPES.map(s => <Button key={s} size="sm" variant={s === shape ? 'outline' : 'ghost'} role="radio" aria-checked={s === shape}
          disabled={human} onClick={() => { setShape(s) }}>{t(`tool.${s}`)}</Button>)}
      </div>
      <div className={css.group}>
        {control === 'agent' && <Button size="sm" variant="ghost" onClick={() => { void setControl('paused') }}>{t('pause')}</Button>}
        {control === 'paused' && <Button size="sm" variant="ghost" onClick={() => { void setControl('agent') }}>{t('resume')}</Button>}
        {human
          ? <Button size="sm" variant="primary" onClick={() => { void setControl('agent') }}>{t('handBack')}</Button>
          : <Button size="sm" variant="outline" onClick={() => { void setControl('human') }}>{t('take')}</Button>}
      </div>
    </div>
    <div className={css.status} data-control={control}>{t(`control.${control}`)}{state !== null && state.url !== '' ? ` · ${state.title || state.url}` : ''}</div>
    {question !== null && <div className={css.question}>
      <span>{t('ask')} <strong>{question.text}</strong></span>
      <Button size="sm" variant="primary" onClick={() => { void answer(question.id) }}>{t('answer')}</Button>
    </div>}
    <input className={css.note} value={note} placeholder={t('note')} aria-label={t('note')} disabled={human}
      onChange={(event) => { setNote(event.target.value) }} />
    <div ref={surface} className={css.surface} data-human={human} tabIndex={0} aria-label={t('view')}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel} onKeyDown={onKeyDown}>
      {frame === null
        ? <div className={css.waiting}>{t('waiting')}</div>
        : <>
          <img className={css.frame} src={`data:image/jpeg;base64,${frame.data}`} alt="" draggable={false} />
          <svg className={css.overlay} viewBox={`0 0 ${frame.width} ${frame.height}`} preserveAspectRatio="none">
            <defs><marker id="co-canvas-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path className={css.head} d="M0,0 L10,5 L0,10 z" /></marker></defs>
            {pending.map((m, i) => <MarkGlyph key={m.id} mark={m} index={i + 1} />)}
            {draftMark !== null && <MarkGlyph mark={draftMark} />}
          </svg>
        </>}
    </div>
    {pending.length > 0 && <div className={css.pending}>
      <div className={css.pendingTitle}>{t('pending')}</div>
      <ol className={css.list}>
        {pending.map(m => <li key={m.id} className={css.item}>
          <span className={css.itemText}>
            {m.target === undefined ? t('noElement') : `${m.target.role ?? m.target.tag} "${m.target.text || m.target.label || ''}"`}
            {m.note === undefined ? null : <em> — {m.note}</em>}
          </span>
          <Button size="sm" variant="ghost" onClick={() => { void removeMark(m.id) }}>{t('remove')}</Button>
        </li>)}
      </ol>
    </div>}
  </div>
}
