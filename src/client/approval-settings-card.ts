/** AFM Reviewer model card for Settings → Plugins → Plugin configuration. */
import {
  createElement as h,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ModelCatalog, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ApproveForMeSettings } from '../config.js'
import type { ApproveForMeLocaleKey } from './locales.js'
import { fetchLedgerHealth, type LedgerHealthViewModel } from './ledger-health-remote.js'

export interface ApprovalModelRoute {
  readonly provider: string
  readonly model: string
}

export interface ApprovalModelCandidate extends ApprovalModelRoute {
  readonly key: string
  readonly providerName: string
  readonly modelName: string
  readonly description?: string
  /** Catalog knowledge for this exact route; unknown covers no response or provider-local failure. */
  readonly availability: 'available' | 'unavailable' | 'unknown'
}

export const APPROVE_FOR_ME_SETTINGS_NAMESPACE = 'dsh-approve-for-me'

export type ApprovalModelSettings = ApproveForMeSettings

export interface ApprovalSettingsCardProps {
  readonly scope: SettingsScope<ApprovalModelSettings>
  readonly loadModelCatalog: () => Promise<ModelCatalog>
  readonly subscribeCatalog: (listener: (connectionReset: boolean) => void) => () => void
  readonly t: (key: ApproveForMeLocaleKey) => string
}

interface DraftRoute {
  readonly mode: 'set' | 'reset'
  readonly route: ApprovalModelRoute
  readonly revision: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow the redacted wire section to the only AFM settings fields the card owns. */
export function decodeApprovalModelSettings(section: unknown): ApprovalModelSettings | undefined {
  if (!isRecord(section) || !isRecord(section.reviewer)) return undefined
  const provider = section.reviewer.provider
  const model = section.reviewer.model
  if (typeof provider !== 'string' || provider.length === 0
    || typeof model !== 'string' || model.length === 0) return undefined
  return { reviewer: { provider, model } }
}

/** Stable opaque identity used only for candidate lookup. */
export function approvalModelKey(route: ApprovalModelRoute): string {
  return `${route.provider}\0${route.model}`
}

function sameRoute(left: ApprovalModelRoute | undefined, right: ApprovalModelRoute | undefined): boolean {
  return left?.provider === right?.provider && left?.model === right?.model
}

function routeFromSettings(settings: ApprovalModelSettings | undefined): ApprovalModelRoute | undefined {
  if (settings === undefined) return undefined
  return { provider: settings.reviewer.provider, model: settings.reviewer.model }
}

function routeFromLayer(layer: unknown): ApprovalModelRoute | undefined {
  return routeFromSettings(decodeApprovalModelSettings(layer))
}

/** Join the live DSH model catalog with a selected route that may be temporarily absent. */
export function approvalModelCandidates(
  groups: readonly ModelProviderGroup[],
  selected: ApprovalModelRoute | undefined,
  failedProviders?: ReadonlySet<string>,
): ApprovalModelCandidate[] {
  const candidates: ApprovalModelCandidate[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const model of group.models) {
      const route = { provider: group.id, model: model.id }
      const key = approvalModelKey(route)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        ...route,
        key,
        providerName: group.name,
        modelName: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        availability: 'available',
      })
    }
  }
  if (selected !== undefined && !seen.has(approvalModelKey(selected))) {
    candidates.push({
      ...selected,
      key: approvalModelKey(selected),
      providerName: selected.provider,
      modelName: selected.model,
      availability: failedProviders === undefined || failedProviders.has(selected.provider)
        ? 'unknown'
        : 'unavailable',
    })
  }
  return candidates
}

/** Whether either route leaf is explicitly present in the raw user layer. */
export function hasReviewerRouteOverride(user: unknown): boolean {
  if (!isRecord(user) || !isRecord(user.reviewer)) return false
  return Object.hasOwn(user.reviewer, 'provider') || Object.hasOwn(user.reviewer, 'model')
}

/** One rendered health row: a locale label key plus the formatted scalar. */
export interface LedgerHealthRowModel {
  readonly labelKey: ApproveForMeLocaleKey
  readonly value: string
}

/**
 * WP8-b: prepare the ledger-health rows for rendering. Pure and closed-set:
 * only segments present on the decoded model produce rows, in a stable order,
 * and the extractor watermark renders as an em dash until the first checkpoint
 * commits (null). The caller maps labelKey through the locale dictionary.
 */
export function ledgerHealthRows(health: LedgerHealthViewModel): LedgerHealthRowModel[] {
  const rows: LedgerHealthRowModel[] = []
  if (health.seal !== undefined) {
    rows.push(
      { labelKey: 'health.sealChains', value: String(health.seal.chains) },
      { labelKey: 'health.sealFacts', value: String(health.seal.sealedFacts) },
    )
  }
  if (health.authorization !== undefined) {
    rows.push(
      { labelKey: 'health.authEntries', value: String(health.authorization.entries) },
      { labelKey: 'health.authCheckpoints', value: String(health.authorization.checkpoints) },
      { labelKey: 'health.authWatermark', value: health.authorization.maxThroughSeq === null ? '—' : String(health.authorization.maxThroughSeq) },
    )
  }
  return rows
}

function useSettingsSnapshot(
  scope: SettingsScope<ApprovalModelSettings>,
): SettingsScopeSnapshot<ApprovalModelSettings> {
  return useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
}

function optionGroups(
  candidates: readonly ApprovalModelCandidate[],
  unavailableLabel: string,
  unknownLabel: string,
) {
  const groups = new Map<string, { label: string; items: ApprovalModelCandidate[] }>()
  for (const candidate of candidates) {
    const id = candidate.availability === 'available'
      ? candidate.provider
      : candidate.availability === 'unknown' ? '__unknown__' : '__unavailable__'
    const group = groups.get(id)
    if (group === undefined) {
      groups.set(id, {
        label: candidate.availability === 'available'
          ? candidate.providerName
          : candidate.availability === 'unknown' ? unknownLabel : unavailableLabel,
        items: [candidate],
      })
    } else {
      group.items.push(candidate)
    }
  }
  return [...groups.entries()].map(([id, group]) => h('optgroup', {
    key: id,
    label: group.label,
  }, group.items.map(candidate => h('option', {
    key: candidate.key,
    value: candidate.key,
  }, `${candidate.modelName} · ${candidate.provider}/${candidate.model}${candidate.availability === 'unavailable' ? ' ⚠' : ''}`))))
}

/** Native-looking, staged and revision-fenced Reviewer model selector. */
export function ApprovalSettingsCard(props: ApprovalSettingsCardProps) {
  const snapshot = useSettingsSnapshot(props.scope)
  const current = routeFromSettings(snapshot.value)
  const base = routeFromLayer(snapshot.base)
  const overridden = hasReviewerRouteOverride(snapshot.user)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DraftRoute | undefined>()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [conflicted, setConflicted] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog | undefined>()
  const [catalogStatus, setCatalogStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  // WP8-b: read-only ledger-health section state. Presentational only: a fetch
  // failure or a body outside the closed set settles to 'unavailable' and the
  // muted line below; it never touches the settings draft or authorization.
  const [health, setHealth] = useState<LedgerHealthViewModel | undefined>(undefined)
  const [healthStatus, setHealthStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const healthGeneration = useRef(0)
  const catalogGeneration = useRef(0)
  const saveGeneration = useRef(0)
  const alive = useRef(true)
  const desired = draft?.route ?? current
  const candidates = useMemo(
    () => approvalModelCandidates(
      catalog?.groups ?? [],
      desired,
      catalog === undefined ? undefined : new Set(catalog.failures.map(failure => failure.id)),
    ),
    [catalog, desired?.provider, desired?.model],
  )

  const loadCatalog = () => {
    if (catalogStatus === 'loading') return
    const generation = ++catalogGeneration.current
    setCatalogStatus('loading')
    void props.loadModelCatalog().then(value => {
      if (!alive.current || generation !== catalogGeneration.current) return
      setCatalog(value)
      setCatalogStatus('ready')
    }, () => {
      if (!alive.current || generation !== catalogGeneration.current) return
      setCatalogStatus('error')
    })
  }

  const loadHealth = useCallback(() => {
    const generation = ++healthGeneration.current
    setHealthStatus('loading')
    void fetchLedgerHealth().then(model => {
      if (!alive.current || generation !== healthGeneration.current) return
      setHealth(model)
      setHealthStatus(model === undefined ? 'unavailable' : 'ready')
    })
  }, [])

  useEffect(() => {
    alive.current = true
    loadHealth()
    return () => {
      alive.current = false
      healthGeneration.current += 1
      catalogGeneration.current += 1
      saveGeneration.current += 1
    }
  }, [loadHealth])

  useEffect(() => props.subscribeCatalog(connectionReset => {
    catalogGeneration.current += 1
    setCatalog(undefined)
    setCatalogStatus('idle')
    if (connectionReset) {
      saveGeneration.current += 1
      setDraft(undefined)
      setSaving(false)
      setFailed(false)
      setConflicted(false)
    }
  }), [props.subscribeCatalog])

  useEffect(() => {
    if (open && catalogStatus === 'idle') loadCatalog()
  }, [open, catalogStatus])

  useEffect(() => {
    if (draft === undefined || saving || snapshot.revision === draft.revision) return
    const landed = draft.mode === 'reset'
      ? !overridden && sameRoute(current, draft.route)
      : sameRoute(current, draft.route)
    if (landed) {
      setDraft(undefined)
      setFailed(false)
      setConflicted(false)
    } else {
      setConflicted(true)
    }
  }, [snapshot.revision, current?.provider, current?.model, overridden, draft, saving])

  if (snapshot.status !== 'ready' || current === undefined) return null

  const dirty = draft !== undefined
  const displayRoute = desired ?? current
  const selectedKey = approvalModelKey(displayRoute)
  const title = props.t('settings.title')
  const stageRoute = (route: ApprovalModelRoute) => {
    if (!snapshot.writable || saving) return
    if (sameRoute(route, current)) setDraft(undefined)
    else setDraft({ mode: 'set', route, revision: snapshot.revision })
    setFailed(false)
    setConflicted(false)
  }
  const reset = () => {
    if (!snapshot.writable || saving || base === undefined) return
    setDraft({ mode: 'reset', route: base, revision: snapshot.revision })
    setFailed(false)
    setConflicted(false)
  }
  const discard = () => {
    if (saving) return
    setDraft(undefined)
    setFailed(false)
    setConflicted(false)
  }
  const save = async () => {
    if (draft === undefined || !snapshot.writable || saving || conflicted) return
    const generation = saveGeneration.current
    setSaving(true)
    setFailed(false)
    try {
      const ops = draft.mode === 'reset'
        ? [
            { op: 'unset' as const, path: ['reviewer', 'provider'] },
            { op: 'unset' as const, path: ['reviewer', 'model'] },
          ]
        : [
            { op: 'set' as const, path: ['reviewer', 'provider'], value: draft.route.provider },
            { op: 'set' as const, path: ['reviewer', 'model'], value: draft.route.model },
          ]
      await props.scope.mutate(ops, draft.revision)
      if (!alive.current || generation !== saveGeneration.current) return
      const landedSnapshot = props.scope.getSnapshot()
      const landedCurrent = routeFromSettings(landedSnapshot.value)
      const landed = draft.mode === 'reset'
        ? !hasReviewerRouteOverride(landedSnapshot.user) && sameRoute(landedCurrent, draft.route)
        : sameRoute(landedCurrent, draft.route)
      setSaving(false)
      setFailed(!landed)
      if (landed) {
        setDraft(undefined)
        setConflicted(false)
        setOpen(false)
      }
    } catch {
      if (!alive.current || generation !== saveGeneration.current) return
      setSaving(false)
      setFailed(true)
    }
  }

  const disabled = !snapshot.writable || saving
  const partial = (catalog?.failures.length ?? 0) > 0
  const selectedCandidate = candidates.find(candidate => candidate.key === selectedKey)
  return h('li', {
    className: `afm-settings-card${open ? ' afm-settings-card--open' : ''}`,
    'data-afm-settings-card': '',
  },
  h('button', {
    type: 'button',
    className: 'afm-settings-card__header',
    'aria-expanded': open,
    'aria-label': `${props.t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`,
    onClick: () => setOpen(!open),
  },
  h('span', { className: 'afm-settings-card__head-text' },
    h('span', { className: 'afm-settings-card__title' }, title),
    h('span', { className: 'afm-settings-card__description' }, props.t('settings.description')),
  ),
  h('span', { className: 'afm-settings-card__route' }, `${displayRoute.provider}/${displayRoute.model}`),
  dirty ? h('span', { className: 'afm-settings-card__badge' }, props.t('settings.unsaved')) : null,
  h('span', { className: `afm-settings-card__chevron${open ? ' afm-settings-card__chevron--open' : ''}`, 'aria-hidden': true }, '⌄')),
  open ? h('div', { className: 'afm-settings-card__body' },
    !snapshot.writable ? h('p', { className: 'afm-settings-card__notice', role: 'status' }, props.t('settings.readOnly')) : null,
    h('div', { className: 'afm-settings-card__field' },
      h('div', { className: 'afm-settings-card__field-head' },
        h('label', { htmlFor: 'afm-reviewer-model', className: 'afm-settings-card__label' }, props.t('settings.model')),
        overridden ? h('span', { className: 'afm-settings-card__field-actions' },
          h('span', { className: 'afm-settings-card__badge' }, props.t('settings.overridden')),
          h('button', { type: 'button', className: 'afm-settings-card__reset', disabled, onClick: reset }, props.t('settings.reset')),
        ) : null,
      ),
      catalogStatus === 'loading'
        ? h('p', { className: 'afm-settings-card__notice', role: 'status' }, props.t('settings.loading'))
        : null,
      catalogStatus === 'error'
        ? h('div', { className: 'afm-settings-card__catalog-error', role: 'alert' },
            h('span', null, props.t('settings.loadFailed')),
            h('button', { type: 'button', disabled: saving, onClick: loadCatalog }, props.t('settings.retry')),
          )
        : null,
      h('select', {
        id: 'afm-reviewer-model',
        className: 'afm-settings-card__select',
        value: selectedKey,
        disabled: disabled || candidates.length === 0,
        onChange: (event: { target: { value: string } }) => {
          const candidate = candidates.find(item => item.key === event.target.value)
          if (candidate !== undefined) stageRoute(candidate)
        },
      }, optionGroups(
        candidates,
        props.t('settings.unavailableGroup'),
        props.t('settings.unknownGroup'),
      )),
      selectedCandidate?.description === undefined
        ? null
        : h('p', { className: 'afm-settings-card__hint' }, selectedCandidate.description),
      h('p', { className: 'afm-settings-card__hint' }, props.t('settings.modelHint')),
      catalogStatus === 'ready' && selectedCandidate?.availability === 'unavailable'
        ? h('p', { className: 'afm-settings-card__warning', role: 'status' }, props.t('settings.unavailable'))
        : null,
      catalogStatus === 'ready' && selectedCandidate?.availability === 'unknown'
        ? h('p', { className: 'afm-settings-card__notice', role: 'status' }, props.t('settings.unknown'))
        : null,
      partial ? h('p', { className: 'afm-settings-card__notice', role: 'status' }, props.t('settings.partial')) : null,
      conflicted ? h('p', { className: 'afm-settings-card__warning', role: 'status' }, props.t('settings.conflict')) : null,
    ),
    h('div', { className: 'afm-settings-card__field' },
      h('div', { className: 'afm-settings-card__field-head' },
        h('span', { className: 'afm-settings-card__label' }, props.t('health.title')),
        h('button', { type: 'button', className: 'afm-settings-card__refresh', disabled: saving, onClick: loadHealth }, props.t('health.refresh')),
      ),
      healthStatus === 'loading'
        ? h('p', { className: 'afm-settings-card__notice', role: 'status' }, props.t('health.loading'))
        : healthStatus === 'unavailable' || health === undefined
          ? h('p', { className: 'afm-settings-card__notice', role: 'status' }, props.t('health.unavailable'))
          : h('dl', { className: 'afm-settings-card__health' }, ledgerHealthRows(health).flatMap((row, index) => [
            h('dt', { key: `label-${index}` }, props.t(row.labelKey)),
            h('dd', { key: `value-${index}` }, row.value),
          ])),
    ),
    h('div', { className: 'afm-settings-card__footer' },
      failed ? h('p', { className: 'afm-settings-card__failed', role: 'alert' }, props.t('settings.saveFailed')) : null,
      h('button', { type: 'button', className: 'afm-settings-card__discard', disabled: !dirty || saving, onClick: discard }, props.t('settings.discard')),
      h('button', { type: 'button', className: 'afm-settings-card__save', disabled: !dirty || saving || conflicted, onClick: () => { void save() } }, saving ? props.t('settings.saving') : props.t('settings.save')),
    ),
  ) : null)
}

/** Scoped styles mirror the stock configurable-plugin card tokens and rhythm. */
export const APPROVAL_SETTINGS_STYLES = `
.afm-settings-card{list-style:none;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;transition:border-color .16s,background .16s}
.afm-settings-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.afm-settings-card--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.afm-settings-card__header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}
.afm-settings-card__header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.afm-settings-card__head-text{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}
.afm-settings-card__title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.afm-settings-card__description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.afm-settings-card__route{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font:500 12px/1.5 var(--dsw-font-family-code,monospace)}
.afm-settings-card__badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.afm-settings-card__chevron{color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:1;transition:transform .16s}
.afm-settings-card__chevron--open{transform:rotate(180deg)}
.afm-settings-card__body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.afm-settings-card__field{display:flex;flex-direction:column;gap:7px;padding:12px 0}
.afm-settings-card__field-head{display:flex;align-items:center;gap:8px}
.afm-settings-card__label{min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.afm-settings-card__field-actions{display:inline-flex;align-items:center;gap:8px}
.afm-settings-card__reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:0;padding:0;font-size:12px;line-height:1.5}
.afm-settings-card__reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.afm-settings-card__refresh{font:inherit;color:var(--dsw-alias-brand-primary);cursor:pointer;background:transparent;border:0;padding:0;font-size:12px;line-height:1.5}
.afm-settings-card__refresh:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
.afm-settings-card__health{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;margin:0;font-size:12px;line-height:1.5}
.afm-settings-card__health dt{margin:0;color:var(--dsw-alias-label-tertiary)}
.afm-settings-card__health dd{margin:0;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-code,monospace);text-align:right}
.afm-settings-card__select{width:100%;height:36px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 34px 0 12px;font:inherit;font-size:13px;line-height:1.5}
.afm-settings-card__select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.afm-settings-card__select:disabled,.afm-settings-card__reset:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
.afm-settings-card__hint,.afm-settings-card__notice,.afm-settings-card__warning,.afm-settings-card__failed{margin:0;font-size:12px;line-height:1.5}
.afm-settings-card__hint,.afm-settings-card__notice{color:var(--dsw-alias-label-tertiary)}
.afm-settings-card__warning{color:var(--dsw-alias-state-warn-label)}
.afm-settings-card__catalog-error{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-error);font-size:12px}
.afm-settings-card__catalog-error button{font:inherit;color:var(--dsw-alias-brand-primary);cursor:pointer;background:transparent;border:0;padding:0}
.afm-settings-card__footer{border-top:.5px solid var(--dsw-alias-border-l2);display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px}
.afm-settings-card__failed{min-width:0;flex:1;color:var(--dsw-alias-label-error)}
.afm-settings-card__discard,.afm-settings-card__save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.afm-settings-card__discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}
.afm-settings-card__save{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-brand-primary)}
.afm-settings-card__discard:disabled,.afm-settings-card__save:disabled{cursor:default;opacity:.45}
@media (max-width:680px){.afm-settings-card__route{display:none}.afm-settings-card__header{gap:8px}}
@media (prefers-reduced-motion:reduce){.afm-settings-card,.afm-settings-card__chevron{transition:none}}
`
