/**
 * Action row under the composer's model list that opens the Models settings
 * section, where API keys and model providers are entered.
 */
import { IconSettingsOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the 'conversation.input.model.manage' slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import css from './ManageModelsLink.module.css'

/** Injected face: open the settings panel on one section. */
export interface ManageModelsInjected {
  /** Open the settings panel on the Models section. */
  openModels: () => void
}

/** Composed props of the model menu's action row. */
export type ManageModelsLinkProps = PropsRuntime<'conversation.input.model.manage'> & PropsLocale<'settings'> & ManageModelsInjected

/**
 * Render the link that closes the model menu and opens Settings > Models.
 * @param props - composed slot props.
 * @returns the action button.
 */
export function ManageModelsLink({ close, openModels, t }: ManageModelsLinkProps) {
  return (
    <button type="button" className={css.link} onClick={() => { close(); openModels() }}>
      <IconSettingsOutlineMedium size={14} />
      <span>{t('models.manage')}</span>
    </button>
  )
}
