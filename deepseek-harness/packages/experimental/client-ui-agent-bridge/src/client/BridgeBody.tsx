/** The agent-bridge tab: share this conversation, open other agents' sessions here, and see shared memory. */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, CommandText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExternalAgent, ExternalSessionInfo } from '@deepseek-ai/dsh-experimental-agent-bridge/types'
import type { BridgeInjected } from './face.ts'
import type {} from './locales.ts'
import css from './BridgeBody.module.css'

const AGENTS: readonly ExternalAgent[] = ['claude', 'codex', 'gemini']

/**
 * Render the agent-bridge tab.
 * @param props - the Session this Sidebar belongs to, live state, Host actions, and localized copy.
 * @returns the panel.
 */
export function BridgeBody({
  t, sessionId, useBridge, refresh, open, unfollow, share, syncMemory,
}: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'agentBridge'> & InjectFace<BridgeInjected>): ReactNode {
  const state = useBridge(s => s)
  const [filter, setFilter] = useState<ExternalAgent | 'all'>('all')
  const [notice, setNotice] = useState<string | null>(null)
  const report = (action: Promise<unknown>): void => {
    setNotice(null)
    action.catch((error: unknown) => { setNotice(error instanceof Error ? error.message : String(error)) })
  }
  const exports = state?.exports.filter(e => e.sessionId === sessionId) ?? []
  const follows = state?.follows.filter(f => f.sessionId === sessionId) ?? []
  const sessions = (state?.sessions ?? []).filter(s => filter === 'all' || s.agent === filter)

  return <div className={css.body}>
    {notice !== null && <div className={css.notice} role="alert">{notice}</div>}

    <section className={css.section}>
      <h3 className={css.heading}>{t('section.share')}</h3>
      {AGENTS.map((agent) => {
        const record = exports.find(e => e.agent === agent)
        return <div key={agent} className={css.row}>
          <Checkbox checked={record !== undefined} label={t(`agent.${agent}`)} onChange={(next) => { report(share(sessionId, agent, next)) }} />
          {record !== undefined && <span className={css.meta} data-status={record.status}>{t(`status.${record.status}`)}{record.detail === null ? '' : ` · ${record.detail}`}</span>}
          {record?.resume != null && record.status !== 'error' && record.status !== 'unavailable' && <div className={css.command}>
            <span className={css.meta}>{t('resume')}</span>
            <CommandText text={record.resume} label={t('resume')} className={css.code} />
          </div>}
        </div>
      })}
    </section>

    {follows.length > 0 && <section className={css.section}>
      <h3 className={css.heading}>{t('section.follows')}</h3>
      {follows.map(f => <div key={`${f.agent}:${f.id}`} className={css.row}>
        <span className={css.title}>{t(`agent.${f.agent}`)} · {f.title}</span>
        <span className={css.meta}>{t(`follow.${f.status}`)} · {t('relayed', { count: f.relayed })}{f.error === null ? '' : ` · ${f.error}`}</span>
        <Button size="sm" variant="ghost" onClick={() => { report(unfollow(sessionId, f.agent, f.id)) }}>{t('unfollow')}</Button>
      </div>)}
    </section>}

    <section className={css.section}>
      <div className={css.headingRow}>
        <h3 className={css.heading}>{t('section.sessions')}</h3>
        <Button size="sm" variant="ghost" onClick={() => { report(refresh()) }}>{t('refresh')}</Button>
      </div>
      <div className={css.group} role="radiogroup" aria-label={t('section.sessions')}>
        {(['all', ...AGENTS] as const).map(a => <Button key={a} size="sm" variant={a === filter ? 'outline' : 'ghost'} role="radio" aria-checked={a === filter}
          onClick={() => { setFilter(a) }}>{t(`agent.${a}`)}</Button>)}
      </div>
      {sessions.length === 0
        ? <div className={css.empty}>{t('noSessions')}</div>
        : <ul className={css.list}>{sessions.map(s => <SessionRow key={`${s.agent}:${s.path}`} t={t} session={s}
          onOpen={() => { report(open(sessionId, s.agent, s.id)) }} />)}</ul>}
    </section>

    <section className={css.section}>
      <div className={css.headingRow}>
        <h3 className={css.heading}>{t('section.memory')}</h3>
        <Button size="sm" variant="ghost" onClick={() => { report(syncMemory()) }}>{t('syncMemory')}</Button>
      </div>
      <div className={css.subheading}>{t('memory.out')}</div>
      {(state?.memoryExports ?? []).map(m => <div key={m.agent} className={css.row}>
        <span className={css.title}>{t(`agent.${m.agent}`)}</span>
        <span className={css.meta}>{m.status === 'disabled' ? t('memory.disabled') : m.status === 'error' ? `${t('status.error')} · ${m.detail ?? ''}` : t('memory.facts', { count: m.facts })}</span>
        <span className={css.path}>{m.paths.join(' · ')}</span>
      </div>)}
      <div className={css.subheading}>{t('memory.in')}</div>
      {(state?.memorySources ?? []).length === 0
        ? <div className={css.empty}>{t('memory.none')}</div>
        : (state?.memorySources ?? []).map(m => <div key={m.path} className={css.row}>
          <span className={css.title}>{t(`agent.${m.agent}`)} · {t(`scope.${m.scope}`)} · {t(`kind.${m.kind}`)}</span>
          <span className={css.path}>{m.path}</span>
        </div>)}
    </section>
  </div>
}

function SessionRow({ t, session, onOpen }: { readonly t: PropsLocale<'agentBridge'>['t']; readonly session: ExternalSessionInfo; readonly onOpen: () => void }): ReactNode {
  return <li className={css.item}>
    <div className={css.itemText}>
      <span className={css.title}>{session.title}</span>
      <span className={css.meta}>
        {t(`agent.${session.agent}`)} · {new Date(session.updatedAt).toLocaleString()}{session.exported ? ` · ${t('shared')}` : ''}
      </span>
      {session.cwd !== null && <span className={css.path}>{session.cwd}</span>}
    </div>
    <Button size="sm" variant="outline" onClick={onOpen}>{t('open')}</Button>
  </li>
}
