/** Browser half: durable AFM approval status in the current Chat flow. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement as h } from 'react'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { approvalConversationDefinition } from './client/approval-conversation.js'
import { ApprovalFlowItem, APPROVAL_FLOW_STYLES } from './client/approval-flow-item.js'
import {
  APPROVE_FOR_ME_SETTINGS_NAMESPACE,
  APPROVAL_SETTINGS_STYLES,
  ApprovalSettingsCard,
  decodeApprovalModelSettings,
} from './client/approval-settings-card.js'
import { en, zh } from './client/locales.js'
import { setApprovalReasonCodeSidecarReader } from './client/approval-conversation.js'
import { createServerBackedReasonCodeReader, setApprovalReasonCodeServerReader } from './client/reason-code.js'
import { getReasonCodeRemoteBridge, resetReasonCodeRemoteBridge } from './client/reason-code-remote.js'

const NS = 'approve-for-me'
const STYLE_ID = 'dsh-approve-for-me/ApprovalFlowItem'

/** Required Client services for Chat projection and the live settings card. */
export const inject = [
  'uiConversation',
  'slots',
  'locale',
  'remote',
  'remote.session',
  'settingsScope',
]

function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
  if (document.querySelector(selector) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-approve-for-me'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = `${APPROVAL_FLOW_STYLES}\n${APPROVAL_SETTINGS_STYLES}`
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Register the durable Chat row and AFM's Host-backed plugin settings card. */
export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(approvalConversationDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'approve-for-me: dictionaries')
  ctx.effect(() => installStyles(), 'approve-for-me: client styles')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'approve-for-me',
    locale: NS,
  }, ApprovalFlowItem))

  const scope = ctx.settingsScope.bind({
    namespace: APPROVE_FOR_ME_SETTINGS_NAMESPACE,
    decode: decodeApprovalModelSettings,
  })
  const catalogListeners = new Set<(connectionReset: boolean) => void>()
  const notifyCatalog = (connectionReset = false) => {
    for (const listener of catalogListeners) listener(connectionReset)
  }
  const subscribeCatalog = (listener: (connectionReset: boolean) => void) => {
    catalogListeners.add(listener)
    return () => { catalogListeners.delete(listener) }
  }
  const loadModelCatalog = async () => {
    const response = await ctx.remote.session.modelCatalog()
    if (!response.ok) throw new Error('AFM model catalog request failed')
    return response.value
  }
  const t = ctx.locale.bind(NS)
  const SettingsCard = () => h(ApprovalSettingsCard, {
    scope,
    loadModelCatalog,
    subscribeCatalog,
    t,
  })

  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => notifyCatalog()), 'approve-for-me: model adapter invalidations')
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => notifyCatalog()), 'approve-for-me: model settings invalidations')
  ctx.effect(() => ctx.on('connection/reset', () => notifyCatalog(true)), 'approve-for-me: connection generation')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: APPROVE_FOR_ME_SETTINGS_NAMESPACE,
    locale: NS,
  }, SettingsCard))

  // WP5-c + WP8-a: wire the read-only server reason-code query into the browser
  // sidecar seam. The remote bridge fetches the WP8-a GET route with in-flight
  // dedupe and a bounded settled cache; the reader is presentational: a miss
  // (server bridge absent, storage unavailable, or an unknown/unclearable value)
  // degrades to the generic safe line and never touches the Gate authorization
  // result.
  ctx.effect(() => {
    const bridge = getReasonCodeRemoteBridge()
    setApprovalReasonCodeServerReader(bridge)
    setApprovalReasonCodeSidecarReader(createServerBackedReasonCodeReader())
    return () => {
      setApprovalReasonCodeSidecarReader(undefined)
      setApprovalReasonCodeServerReader(undefined)
      resetReasonCodeRemoteBridge()
    }
  }, 'approve-for-me: reason-code sidecar reader')
}
