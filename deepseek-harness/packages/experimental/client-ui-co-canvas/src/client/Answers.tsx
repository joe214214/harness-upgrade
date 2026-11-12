/** Side questions: the answering model, the pause choice, and the questions with their answers. */
import { useState, type ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelChoice, SideAnswer } from '@deepseek-ai/dsh-experimental-co-canvas/types'
import css from './CanvasBody.module.css'

const keyOf = (choice: Pick<ModelChoice, 'provider' | 'model'>): string => `${choice.provider}/${choice.model}`

/**
 * Render the side-question settings and the questions asked so far, newest first.
 * @param props - answers, the current model and pause choice, Host actions, and localized copy.
 * @returns the section.
 */
export function Answers({ answers, askModel, pauseOnAsk, askModels, setAskModel, setPauseOnAsk, report, t }: {
  readonly answers: readonly SideAnswer[]
  readonly askModel: ModelChoice | null
  readonly pauseOnAsk: boolean
  readonly askModels: () => Promise<ModelChoice[]>
  readonly setAskModel: (choice: ModelChoice) => Promise<void>
  readonly setPauseOnAsk: (on: boolean) => Promise<void>
  readonly report: (action: Promise<unknown>) => void
  readonly t: PropsLocale<'coCanvas'>['t']
}): ReactNode {
  const [choices, setChoices] = useState<ModelChoice[] | null>(null)
  const load = (): void => {
    if (choices !== null) return
    report(askModels().then((listed) => { setChoices(listed) }))
  }
  const options = choices ?? (askModel === null ? [] : [askModel])
  return <section className={css.answers} aria-label={t('answers.title')}>
    <div className={css.cardHead}>
      <span className={css.cardTitle}>{t('answers.title')}</span>
      <label className={css.modelPick}>
        <span>{t('answers.model')}</span>
        <select className={css.select} value={askModel === null ? '' : keyOf(askModel)} onFocus={load} onPointerDown={load}
          onChange={(event) => {
            const picked = options.find(c => keyOf(c) === event.target.value)
            if (picked !== undefined) report(setAskModel(picked))
          }}>
          {askModel === null && <option value="">{t('answers.default')}</option>}
          {options.map(c => <option key={keyOf(c)} value={keyOf(c)}>{c.name}{c.image ? ` · ${t('answers.image')}` : ''}</option>)}
        </select>
      </label>
    </div>
    <Checkbox checked={pauseOnAsk} label={t('answers.pause')} onChange={(on) => { report(setPauseOnAsk(on)) }} />
    {answers.length > 0 && <ol className={css.thread}>
      {[...answers].reverse().map(a => <li key={a.id} className={css.exchange}>
        <div className={css.askLine}>
          {a.step !== undefined && <span className={css.stepTag}>{t('answers.onStep', { n: String(a.step) })}</span>}
          {a.question}
        </div>
        <div className={css.answerLine} data-status={a.status}>{a.answer === '' && a.status === 'answering' ? t('answers.answering') : a.answer}</div>
      </li>)}
    </ol>}
  </section>
}
