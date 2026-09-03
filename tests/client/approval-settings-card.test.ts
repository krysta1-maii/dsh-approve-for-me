import { createElement as h } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  ApprovalSettingsCard,
  approvalModelKey,
  type ApprovalModelSettings,
} from '../../src/client/approval-settings-card.js'

const baseRoute: ApprovalModelSettings = {
  reviewer: { provider: 'openai-codex', model: 'gpt-5.6-terra' },
}
const alternativeRoute: ApprovalModelSettings = {
  reviewer: { provider: 'cpa', model: 'gpt-5.6-sol' },
}

function catalog(failures: ModelCatalog['failures'] = []): ModelCatalog {
  return {
    default: { provider: 'openai-codex', model: 'gpt-5.6-terra' },
    routableProviders: ['openai-codex', 'cpa'],
    groups: [
      { id: 'openai-codex', name: 'Codex', models: [{ id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' }] },
      { id: 'cpa', name: 'CPA', models: [{ id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' }] },
    ],
    failures,
  }
}

class FakeSettingsScope implements SettingsScope<ApprovalModelSettings> {
  private readonly listeners = new Set<() => void>()
  snapshot: SettingsScopeSnapshot<ApprovalModelSettings>
  readonly mutate = vi.fn<SettingsScope<ApprovalModelSettings>['mutate']>()

  constructor(snapshot: SettingsScopeSnapshot<ApprovalModelSettings>) {
    this.snapshot = snapshot
  }

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set = vi.fn<SettingsScope<ApprovalModelSettings>['set']>()
  unset = vi.fn<SettingsScope<ApprovalModelSettings>['unset']>()

  publish(snapshot: SettingsScopeSnapshot<ApprovalModelSettings>) {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

function snapshot(
  value: ApprovalModelSettings,
  options: { revision?: number; base?: unknown; user?: unknown } = {},
): SettingsScopeSnapshot<ApprovalModelSettings> {
  return {
    status: 'ready',
    value,
    base: options.base ?? baseRoute,
    user: options.user ?? {},
    revision: options.revision ?? 7,
    writable: true,
    mode: 'host',
  }
}

async function renderCard(
  scope: FakeSettingsScope,
  modelCatalog: ModelCatalog = catalog(),
) {
  let catalogListener: ((connectionReset: boolean) => void) | undefined
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(h(ApprovalSettingsCard, {
      scope,
      loadModelCatalog: async () => modelCatalog,
      subscribeCatalog: listener => {
        catalogListener = listener
        return () => { catalogListener = undefined }
      },
      t: key => key,
    }))
  })
  const header = renderer.root.findByProps({ className: 'afm-settings-card__header' })
  await act(async () => {
    header.props.onClick()
    await Promise.resolve()
    await Promise.resolve()
  })
  return { renderer, catalogListener: () => catalogListener }
}

async function flushAction(action: () => void) {
  await act(async () => {
    action()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('AFM Reviewer model settings card', () => {
  it('saves both route leaves atomically with the draft revision', async () => {
    const scope = new FakeSettingsScope(snapshot(baseRoute))
    scope.mutate.mockImplementation(async (ops) => {
      expect(ops).toHaveLength(2)
      scope.publish(snapshot(alternativeRoute, {
        revision: 8,
        user: alternativeRoute,
      }))
    })
    const { renderer } = await renderCard(scope)
    const select = renderer.root.findByProps({ id: 'afm-reviewer-model' })

    await flushAction(() => select.props.onChange({
      target: { value: approvalModelKey(alternativeRoute.reviewer) },
    }))
    const save = renderer.root.findByProps({ className: 'afm-settings-card__save' })
    await flushAction(() => save.props.onClick())

    expect(scope.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['reviewer', 'provider'], value: 'cpa' },
      { op: 'set', path: ['reviewer', 'model'], value: 'gpt-5.6-sol' },
    ], 7)
    expect(renderer.root.findByProps({ className: 'afm-settings-card__header' }).props['aria-expanded']).toBe(false)
  })

  it('resets both user route leaves back to the composition layer', async () => {
    const scope = new FakeSettingsScope(snapshot(alternativeRoute, {
      user: alternativeRoute,
    }))
    scope.mutate.mockImplementation(async () => {
      scope.publish(snapshot(baseRoute, { revision: 8, user: { reviewer: {} } }))
    })
    const { renderer } = await renderCard(scope)
    const reset = renderer.root.findByProps({ className: 'afm-settings-card__reset' })

    await flushAction(() => reset.props.onClick())
    await flushAction(() => renderer.root.findByProps({ className: 'afm-settings-card__save' }).props.onClick())

    expect(scope.mutate).toHaveBeenCalledWith([
      { op: 'unset', path: ['reviewer', 'provider'] },
      { op: 'unset', path: ['reviewer', 'model'] },
    ], 7)
  })

  it('blocks a drifted draft and discards it on connection reset', async () => {
    const scope = new FakeSettingsScope(snapshot(baseRoute))
    const { renderer, catalogListener } = await renderCard(scope)
    const select = renderer.root.findByProps({ id: 'afm-reviewer-model' })
    await flushAction(() => select.props.onChange({
      target: { value: approvalModelKey(alternativeRoute.reviewer) },
    }))

    await flushAction(() => scope.publish(snapshot(baseRoute, { revision: 8 })))
    expect(renderer.root.findByProps({ className: 'afm-settings-card__save' }).props.disabled).toBe(true)
    expect(renderer.root.findAllByProps({ role: 'status' }).some(node => node.children.includes('settings.conflict'))).toBe(true)
    expect(scope.mutate).not.toHaveBeenCalled()

    await flushAction(() => catalogListener()!(true))
    expect(renderer.root.findAllByProps({ className: 'afm-settings-card__badge' })
      .some(node => node.children.includes('settings.unsaved'))).toBe(false)
  })

  it('announces partial and provider-unknown catalog states without claiming unavailability', async () => {
    const scope = new FakeSettingsScope(snapshot(baseRoute))
    const partialCatalog: ModelCatalog = {
      ...catalog(),
      groups: [{ id: 'cpa', name: 'CPA', models: [{ id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' }] }],
      failures: [{ id: 'openai-codex', name: 'Codex', message: 'temporary failure' }],
    }
    const { renderer } = await renderCard(scope, partialCatalog)
    const statuses = renderer.root.findAllByProps({ role: 'status' }).flatMap(node => node.children)

    expect(statuses).toContain('settings.unknown')
    expect(statuses).toContain('settings.partial')
    expect(statuses).not.toContain('settings.unavailable')
  })
})
