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
  'settings.title': 'Approve for me',
  'settings.description': '选择用于审批裁决的独立 Reviewer 模型',
  'settings.model': 'Reviewer 模型',
  'settings.modelHint': '保存后实时切换；provider、凭据与重试策略仍由 DSH 管理。切换到其他模型时使用该模型的默认 reasoning effort。',
  'settings.loading': '正在加载可用模型…',
  'settings.loadFailed': '无法读取模型目录。',
  'settings.retry': '重试',
  'settings.partial': '部分 provider 的模型目录暂时不可用。',
  'settings.unavailable': '当前配置的 route 未出现在已成功加载的模型目录中；请选择可用模型或等待该 route 恢复。',
  'settings.unknown': '该 provider 的目录读取失败，暂时无法确认当前 route 的可用性。',
  'settings.unavailableGroup': '当前不可用',
  'settings.unknownGroup': '可用性待确认',
  'settings.overridden': '已覆盖',
  'settings.reset': '重置',
  'settings.readOnly': '当前设置文档只读。',
  'settings.expand': '展开',
  'settings.collapse': '收起',
  'settings.unsaved': '未保存',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.discard': '放弃',
  'settings.saveFailed': '保存失败；草稿已保留。',
  'settings.conflict': '设置已在其他位置更改；请重新选择模型或放弃草稿。',
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
  'settings.title': 'Approve for me',
  'settings.description': 'Choose the dedicated Reviewer model used for approval decisions',
  'settings.model': 'Reviewer model',
  'settings.modelHint': 'Saving switches live. DSH continues to own providers, credentials, and retries. A different model uses its adapter-default reasoning effort.',
  'settings.loading': 'Loading available models…',
  'settings.loadFailed': 'The model directory could not be loaded.',
  'settings.retry': 'Retry',
  'settings.partial': 'Some provider model directories are temporarily unavailable.',
  'settings.unavailable': 'The configured route is absent from the successfully loaded model directory. Choose an available model or wait for this route to return.',
  'settings.unknown': 'This provider directory failed to load, so the current route availability cannot be confirmed yet.',
  'settings.unavailableGroup': 'Currently unavailable',
  'settings.unknownGroup': 'Availability unknown',
  'settings.overridden': 'Overridden',
  'settings.reset': 'Reset',
  'settings.readOnly': 'The settings document is read-only.',
  'settings.expand': 'Expand',
  'settings.collapse': 'Collapse',
  'settings.unsaved': 'Unsaved',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.discard': 'Discard',
  'settings.saveFailed': 'Save failed; the draft was kept.',
  'settings.conflict': 'Settings changed elsewhere. Choose the model again or discard this draft.',
} satisfies Record<ApproveForMeLocaleKey, string>
