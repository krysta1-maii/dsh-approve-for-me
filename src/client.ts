/** Browser half: durable AFM approval status in the current Chat flow. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { approvalConversationDefinition } from './client/approval-conversation.js'
import { ApprovalFlowItem, APPROVAL_FLOW_STYLES } from './client/approval-flow-item.js'
import { en, zh } from './client/locales.js'

const NS = 'approve-for-me'
const STYLE_ID = 'dsh-approve-for-me/ApprovalFlowItem'

/** Required Client services for event projection, Chat rendering, and copy. */
export const inject = ['uiConversation', 'slots', 'locale']

function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
  if (document.querySelector(selector) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-approve-for-me'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = APPROVAL_FLOW_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Register one durable asked→decided lifecycle row in the stock Chat stream. */
export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(approvalConversationDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'approve-for-me: dictionaries')
  ctx.effect(() => installStyles(), 'approve-for-me: approval flow styles')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'approve-for-me',
    locale: NS,
  }, ApprovalFlowItem))
}
