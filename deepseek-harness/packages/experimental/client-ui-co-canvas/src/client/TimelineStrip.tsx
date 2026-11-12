/** The timeline strip: one chip per recorded action of the agent, newest last, then Live. */
import { useEffect, useRef, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TimelineStep } from '@deepseek-ai/dsh-experimental-co-canvas/types'
import css from './CanvasBody.module.css'

/**
 * Render the steps as a scrollable row; the selected one is highlighted, steps that may not be
 * undoable carry a red dot.
 * @param props - the steps, the selected step id or null for Live, the selection action, and localized copy.
 * @returns the strip, or nothing before the first step.
 */
export function TimelineStrip({ steps, selected, select, t }: {
  readonly steps: readonly TimelineStep[]
  readonly selected: string | null
  readonly select: (step: string | null) => void
  readonly t: PropsLocale<'coCanvas'>['t']
}): ReactNode {
  const row = useRef<HTMLDivElement>(null)
  // Follow the newest step while Live is shown.
  useEffect(() => {
    if (selected === null && row.current !== null) row.current.scrollLeft = row.current.scrollWidth
  }, [steps.length, selected])
  if (steps.length === 0) return null
  return <div className={css.timeline}>
    <div className={css.cardTitle}>{t('timeline.title')}</div>
    <div ref={row} className={css.steps} role="listbox" aria-label={t('timeline.title')}>
      {steps.map(s => <button key={s.id} type="button" role="option" aria-selected={s.id === selected} className={css.step}
        title={`${s.tool} ${s.action}${s.window === '' ? '' : ` · ${s.window}`}${s.irreversible ? ` · ${t('timeline.irreversible')}` : ''}`}
        onClick={() => { select(s.id === selected ? null : s.id) }}>
        {s.irreversible && <span className={css.danger} aria-label={t('timeline.irreversible')} />}
        <span className={css.stepIndex}>{s.index}</span>
        <span className={css.stepTool}>{s.tool}</span>
      </button>)}
      <button type="button" role="option" aria-selected={selected === null} className={css.step} onClick={() => { select(null) }}>
        {t('timeline.live')}
      </button>
    </div>
  </div>
}
