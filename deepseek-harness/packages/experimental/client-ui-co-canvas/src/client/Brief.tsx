/** The task brief card: what the agent is doing and where, with the goal editable by the user. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TaskBrief } from '@deepseek-ai/dsh-experimental-co-canvas/types'
import css from './CanvasBody.module.css'

/**
 * Render the brief, or nothing before the agent acts.
 * @param props - the brief, the goal editor action, and localized copy.
 * @returns the card.
 */
export function BriefCard({ brief, editGoal, report, t }: {
  readonly brief: TaskBrief | null
  readonly editGoal: (goal: string) => Promise<void>
  readonly report: (action: Promise<unknown>) => void
  readonly t: PropsLocale<'coCanvas'>['t']
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null)
  if (brief === null) return null
  const where = [...new Set([brief.app, brief.window, brief.url].filter(part => part !== ''))].join(' · ')
  return <section className={css.card} aria-label={t('brief.title')}>
    <div className={css.cardHead}>
      <span className={css.cardTitle}>{t('brief.title')}</span>
      {draft === null
        ? <Button size="sm" variant="ghost" onClick={() => { setDraft(brief.goal) }}>{t('brief.edit')}</Button>
        : <Button size="sm" variant="primary" onClick={() => { report(editGoal(draft)); setDraft(null) }}>{t('brief.save')}</Button>}
    </div>
    {draft === null
      ? <div className={css.goal}>{brief.goal}</div>
      : <input className={css.note} value={draft} aria-label={t('brief.goal')} autoFocus
        onChange={(event) => { setDraft(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { report(editGoal(draft)); setDraft(null) }
          if (event.key === 'Escape') setDraft(null)
        }} />}
    {where !== '' && <div className={css.fact}><span className={css.factLabel}>{t('brief.where')}</span>{where}</div>}
    {brief.progress !== '' && <div className={css.fact}><span className={css.factLabel}>{t('brief.progress')}</span>{brief.progress}</div>}
  </section>
}
