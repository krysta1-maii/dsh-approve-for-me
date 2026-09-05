import { createElement, memo, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { ApprovalFlowData } from './approval-conversation.js'
import { resolveReasonCodePresentation, type ReasonCode } from './reason-code.js'
import { getReasonCodeRemoteBridge } from './reason-code-remote.js'
import type {} from './locales.js'

export type ApprovalFlowStatus = ApprovalOutcome | 'pending'

type ApprovalFlowItemProps =
  PropsRuntime<'conversation.chat.node', 'approve-for-me'>
  & PropsLocale<'approve-for-me'>

/** Scoped stylesheet using the same tokens and density axes as DSH Chat. */
export const APPROVAL_FLOW_STYLES = `
.dsh-afm-flow {
  --dsh-afm-accent: var(--dsw-alias-state-business-primary);
  --dsh-afm-tint: var(--dsw-alias-state-business-tertiary);
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  box-sizing: border-box;
  padding: 9px 11px;
  border: .5px solid color-mix(in srgb, var(--dsh-afm-accent) 24%, var(--dsw-alias-border-l1));
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsh-afm-tint) 58%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
}
.dsh-afm-flow[data-status="allowed-once"] {
  --dsh-afm-accent: var(--dsw-alias-state-success-primary);
  --dsh-afm-tint: var(--dsw-alias-state-success-tertiary);
}
.dsh-afm-flow[data-status="rejected"] {
  --dsh-afm-accent: var(--dsw-alias-state-error-primary);
  --dsh-afm-tint: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}
.dsh-afm-flow[data-status="unavailable"] {
  --dsh-afm-accent: var(--dsw-alias-state-warn-label);
  --dsh-afm-tint: var(--dsw-alias-state-warn-tertiary);
}
.dsh-afm-flow[data-status="cancelled"] {
  --dsh-afm-accent: var(--dsw-alias-label-tertiary);
  --dsh-afm-tint: var(--dsw-alias-interactive-bg-hover);
}
.dsh-afm-flow__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--dsh-afm-accent) 12%, transparent);
  color: var(--dsh-afm-accent);
}
.dsh-afm-flow__icon svg {
  width: 17px;
  height: 17px;
  overflow: visible;
}
.dsh-afm-flow__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}
.dsh-afm-flow__headline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dsh-afm-flow__status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  color: var(--dsh-afm-accent);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  font-weight: 500;
}
.dsh-afm-flow__dot {
  position: relative;
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: currentcolor;
}
.dsh-afm-flow[data-status="pending"] .dsh-afm-flow__dot::after {
  position: absolute;
  inset: -3px;
  border: 1px solid currentcolor;
  border-radius: inherit;
  content: "";
  animation: dsh-afm-pulse 1.4s ease-out infinite;
}
.dsh-afm-flow__separator {
  width: 2px;
  height: 2px;
  flex: none;
  border-radius: 1px;
  background: var(--dsw-alias-label-caption);
}
.dsh-afm-flow__tool {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code);
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-afm-flow__summary {
  min-width: 0;
  overflow: hidden;
  margin-top: 1px;
  color: var(--dsw-alias-label-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-afm-flow__reason {
  display: block;
  min-width: 0;
  overflow: hidden;
  margin-top: 1px;
  color: var(--dsw-alias-label-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-afm-flow__reason[data-reason-class="tamper"] {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-afm-flow__reason[data-reason-class="capacity"],
.dsh-afm-flow__reason[data-reason-class="storage"],
.dsh-afm-flow__reason[data-reason-class="projection"] {
  color: var(--dsw-alias-state-warn-label);
}
.dsh-afm-flow__detail {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 26px;
  padding: 0 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
.dsh-afm-flow__detail:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-afm-flow__detail:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.dsh-afm-flow__chevron {
  width: 6px;
  height: 6px;
  border-top: 1.25px solid currentcolor;
  border-right: 1.25px solid currentcolor;
  transform: rotate(45deg);
}
@keyframes dsh-afm-pulse {
  0% { opacity: .65; transform: scale(.55); }
  75%, 100% { opacity: 0; transform: scale(1.35); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-afm-flow[data-status="pending"] .dsh-afm-flow__dot::after { animation: none; }
}
@container (max-width: 460px) {
  .dsh-afm-flow__detail span:first-child { display: none; }
}
`

const STATUS_KEYS = {
  pending: 'status.pending',
  'allowed-once': 'status.allowed-once',
  rejected: 'status.rejected',
  cancelled: 'status.cancelled',
  unavailable: 'status.unavailable',
} as const

function statusOf(data: ApprovalFlowData): ApprovalFlowStatus {
  return data.outcome ?? 'pending'
}

/**
 * WP8-a: the sidecar fetch is only warranted for a decided 'unavailable' row
 * whose node does not already carry a reason code. Every other status or an
 * existing code keeps the row exactly as before (pure gate, unit-tested).
 */
export function shouldRequestReasonCode(status: ApprovalFlowStatus, reasonCode: unknown): boolean {
  return status === 'unavailable' && reasonCode === undefined
}

function decisionGlyph(status: ApprovalFlowStatus) {
  if (status === 'allowed-once') {
    return createElement('path', { d: 'm6.4 9 1.65 1.65 3.55-4.05' })
  }
  if (status === 'rejected') {
    return createElement('path', { d: 'm6.8 6.8 4.4 4.4m0-4.4-4.4 4.4' })
  }
  if (status === 'unavailable') {
    return createElement('path', { d: 'M9 5.8v3.4m0 2.1v.1' })
  }
  if (status === 'cancelled') {
    return createElement('path', { d: 'M6.5 9h5' })
  }
  return createElement('circle', { cx: 9, cy: 9, r: 1.2, fill: 'currentColor', stroke: 'none' })
}

function ShieldIcon({ status }: { readonly status: ApprovalFlowStatus }) {
  return createElement(
    'svg',
    {
      viewBox: '0 0 18 18',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.35,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    createElement('path', { d: 'M9 2.1 14 4v4.2c0 3.2-2 5.8-5 7.2-3-1.4-5-4-5-7.2V4l5-1.9Z' }),
    decisionGlyph(status),
  )
}

/**
 * Render one compact, native-token approval lifecycle row in the Chat stream.
 * Pure and hook-free: the sidecar-resolved reason code arrives as a prop, so
 * unit tests (and any host walk) may call this function outside a renderer.
 */
export function ApprovalFlowItemView({
  node,
  inspectCall,
  t,
  sidecarReasonCode,
}: ApprovalFlowItemProps & { readonly sidecarReasonCode?: ReasonCode }) {
  const data: ApprovalFlowData = node.data
  const status = statusOf(data)
  const summary = data.reason ?? t('approval.request', { toolName: data.toolName })
  // The reason code is presentational: mapping it to copy never re-derives the
  // outcome, so a missing/unknown code (or an absent renderer) can never change
  // the Gate authorization result — it only chooses the safe generic line.
  const reason = status === 'pending'
    ? null
    : resolveReasonCodePresentation(status, data.reasonCode ?? sidecarReasonCode)
  return createElement(
    'div',
    {
      className: 'dsh-afm-flow',
      'data-afm-approval': data.requestId,
      'data-status': status,
      role: 'status',
      'aria-live': 'polite',
      'aria-label': `${t('approval.aria')}: ${data.toolName}, ${t(STATUS_KEYS[status])}`,
    },
    createElement('span', { className: 'dsh-afm-flow__icon' }, createElement(ShieldIcon, { status })),
    createElement(
      'span',
      { className: 'dsh-afm-flow__body' },
      createElement(
        'span',
        { className: 'dsh-afm-flow__headline' },
        createElement('span', undefined, t('approval.title')),
        createElement('span', { className: 'dsh-afm-flow__separator', 'aria-hidden': true }),
        createElement(
          'span',
          { className: 'dsh-afm-flow__status' },
          createElement('span', { className: 'dsh-afm-flow__dot', 'aria-hidden': true }),
          t(STATUS_KEYS[status]),
        ),
        createElement('code', { className: 'dsh-afm-flow__tool' }, data.toolName),
      ),
      createElement('span', { className: 'dsh-afm-flow__summary', title: summary }, summary),
      reason === null || reason.copyKey === undefined
        ? null
        : createElement(
          'span',
          {
            className: 'dsh-afm-flow__reason',
            'data-reason-class': reason.class,
            'data-reason-miss': reason.miss ? 'true' : undefined,
            title: t(reason.copyKey),
          },
          t(reason.copyKey),
        ),
    ),
    data.callId === undefined
      ? null
      : createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-afm-flow__detail',
          onClick: () => { inspectCall(data.callId!) },
          'aria-label': t('approval.detail'),
        },
        createElement('span', undefined, t('approval.detail')),
        createElement('span', { className: 'dsh-afm-flow__chevron', 'aria-hidden': true }),
      ),
  )
}

/**
 * Chat-slot component: owns the WP8-a sidecar fetch lifecycle. An 'unavailable'
 * row without a code asks the read-only sidecar once; when the value settles
 * the row re-renders with the resolved code. A miss settles to undefined and
 * the presentation stays the generic safe line. Hooks are unconditional (rules
 * of hooks); the pure view above stays directly callable from tests.
 */
export const ApprovalFlowItem = memo(function ApprovalFlowItem(props: ApprovalFlowItemProps) {
  const data: ApprovalFlowData = props.node.data
  const status = statusOf(data)
  const nodeReasonCode = data.reasonCode
  const requestId = data.requestId
  const [sidecarReasonCode, setSidecarReasonCode] = useState<ReasonCode | undefined>(undefined)
  useEffect(() => {
    if (!shouldRequestReasonCode(status, nodeReasonCode)) return
    let alive = true
    void getReasonCodeRemoteBridge().request(requestId).then(() => {
      if (!alive) return
      const resolved = getReasonCodeRemoteBridge().resolve(requestId)
      setSidecarReasonCode(current => current ?? resolved)
    })
    return () => { alive = false }
  }, [status, nodeReasonCode, requestId])
  return createElement(ApprovalFlowItemView, {
    ...props,
    ...sidecarReasonCode === undefined ? {} : { sidecarReasonCode },
  })
})
