/** Agent-bridge tab title. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'

/**
 * Render the tab name.
 * @param props - localized copy.
 * @returns the title text.
 */
export function BridgeTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'agentBridge'>): ReactNode {
  return <>{t('title')}</>
}
