/** `approve-for-me` browser namespace dictionaries. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'approval.aria': 'Approve for me 审批状态',
  'approval.title': 'Approve for me',
  'approval.request': '工具 {toolName} 请求提升权限',
  'approval.detail': '查看操作',
  'status.pending': '审批中',
  'status.allowed-once': '已允许',
  'status.rejected': '已拒绝',
  'status.cancelled': '已取消',
  'status.unavailable': '审批不可用',
} satisfies Record<string, string>

export type ApproveForMeLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Inline approval audit copy. */
    'approve-for-me': ApproveForMeLocaleKey
  }
}

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'approval.aria': 'Approve for me approval status',
  'approval.title': 'Approve for me',
  'approval.request': 'Tool {toolName} requests elevated access',
  'approval.detail': 'View action',
  'status.pending': 'Reviewing',
  'status.allowed-once': 'Allowed',
  'status.rejected': 'Denied',
  'status.cancelled': 'Cancelled',
  'status.unavailable': 'Review unavailable',
} satisfies Record<ApproveForMeLocaleKey, string>
