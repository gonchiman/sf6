import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEventHandler } from 'react'
import { loadBalanceAdjustmentCatalog } from '../lib/balanceAdjustments'
import { balanceAdjustmentPatchDetails, loadBalanceAdjustmentDetails } from '../lib/balanceAdjustmentDetails'
import { buildBalanceAdjustmentOverview } from '../lib/balanceAdjustmentOverview'
import { loadCharacterManifest } from '../lib/characters'
import type { BalanceAdjustmentCatalog } from '../types/balanceAdjustments'
import type { BalanceAdjustmentDetailsLoadState } from '../types/balanceAdjustmentDetails'
import type { CharacterManifest } from '../types/characters'
import { BalanceAdjustmentDetailContent } from './BalanceAdjustmentDetailContent'
import { BalanceAdjustmentOverview } from './BalanceAdjustmentOverview'
import { COMMON_ADJUSTMENT_SCOPE, balanceAdjustmentDateLabel } from './BalanceAdjustmentTable'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import '../win-rates.css'
import '../balance-adjustments.css'

type BootstrapState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; catalog: BalanceAdjustmentCatalog; manifest: CharacterManifest }

type Props = {
  adjustmentId: string
  scope: string | null
  onScopeChange: (scope: string | null) => void
  onBack?: MouseEventHandler<HTMLAnchorElement>
}

export function BalanceAdjustmentDetailPage({ adjustmentId, scope, onScopeChange, onBack }: Props) {
  const contentId = useId()
  const detailsPanelId = `${contentId}-panel`
  const detailsPanelRef = useRef<HTMLDivElement>(null)
  const scopeSelectRef = useRef<HTMLSelectElement>(null)
  const pendingOverviewSelection = useRef<{ adjustmentId: string; scope: string } | null>(null)
  const [overviewSelectionVersion, setOverviewSelectionVersion] = useState(0)
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [detailsState, setDetailsState] = useState<BalanceAdjustmentDetailsLoadState>({ status: 'loading' })
  const [detailsVersion, setDetailsVersion] = useState(0)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void Promise.all([loadBalanceAdjustmentCatalog(), loadCharacterManifest()]).then(([catalog, manifest]) => {
      if (current) setBootstrap({ status: 'ready', catalog, manifest })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [bootstrapVersion])

  const catalog = bootstrap.status === 'ready' ? bootstrap.catalog : null
  const manifest = bootstrap.status === 'ready' ? bootstrap.manifest : null
  // A detail URL identifies one event; an unknown ID must never select the latest event.
  const event = catalog?.events.find(item => item.id === adjustmentId) ?? null

  useEffect(() => {
    if (!catalog || !manifest || !event) return
    let current = true
    setDetailsState({ status: 'loading' })
    void loadBalanceAdjustmentDetails(catalog, manifest).then(details => {
      if (current) setDetailsState({ status: 'ready', catalog: details })
    }).catch(() => { if (current) setDetailsState({ status: 'error' }) })
    return () => { current = false }
  }, [catalog, manifest, event, detailsVersion])

  const patch = event && detailsState.status === 'ready'
    ? balanceAdjustmentPatchDetails(detailsState.catalog, event) : null
  const overview = useMemo(() => patch ? buildBalanceAdjustmentOverview(patch) : null, [patch])

  useLayoutEffect(() => {
    const request = pendingOverviewSelection.current
    if (!request) return
    if (request.adjustmentId !== adjustmentId) {
      pendingOverviewSelection.current = null
      return
    }
    if (request.scope !== scope) return
    const frame = window.requestAnimationFrame(() => {
      if (pendingOverviewSelection.current !== request) return
      pendingOverviewSelection.current = null
      scopeSelectRef.current?.focus({ preventScroll: true })
      detailsPanelRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [adjustmentId, scope, overviewSelectionVersion])

  const selectFromOverview = (nextScope: string) => {
    pendingOverviewSelection.current = { adjustmentId, scope: nextScope }
    onScopeChange(nextScope)
    setOverviewSelectionVersion(version => version + 1)
  }
  const options: { value: string; label: string }[] = []
  if (patch?.common.changes.length || scope === COMMON_ADJUSTMENT_SCOPE) {
    options.push({ value: COMMON_ADJUSTMENT_SCOPE, label: '共通' })
  }
  for (const character of patch?.characters ?? []) {
    if (character.status === 'ready' && character.changes.length > 0) {
      options.push({ value: character.characterId, label: character.name })
    }
  }
  const selectedCharacter = scope && scope !== COMMON_ADJUSTMENT_SCOPE
    ? patch?.characters.find(character => character.characterId === scope)
      ?? manifest?.characters.find(character => character.id === scope)
    : null
  const unknownScope = scope !== null && scope !== COMMON_ADJUSTMENT_SCOPE && !selectedCharacter
  // Direct links may point at an unlisted, unchanged, or not-yet-imported character.
  if (scope && selectedCharacter && !options.some(option => option.value === scope)) {
    options.push({ value: scope, label: selectedCharacter.name })
  }

  return <section className="balance-adjustments-page balance-adjustment-detail-page" aria-label="バトル変更詳細">
    <a href="#balance-adjustments" className="win-rates-back-link balance-adjustment-back-link" onClick={onBack}>バトル変更一覧へ戻る</a>
    {bootstrap.status === 'loading'
      ? <DataLoadState loading message="バトル変更履歴と条件を読み込み中…" />
      : bootstrap.status === 'error'
        ? <DataLoadState message="バトル変更履歴と条件を読み込めませんでした。" onRetry={() => setBootstrapVersion(version => version + 1)} />
        : !event
          ? <StatisticsPanel title="バトル変更詳細"><DataLoadState message="指定されたバトル変更履歴は見つかりません。" /></StatisticsPanel>
          : <>
            {overview && <BalanceAdjustmentOverview overview={overview} selectedScope={scope} detailsId={detailsPanelId}
              dateLabel={balanceAdjustmentDateLabel(event)} onSelect={selectFromOverview} />}
            <div ref={detailsPanelRef} className="balance-adjustment-content-panel">
              <StatisticsPanel id={detailsPanelId} title="変更内容" headerContent={<span className="monthly-statistics-panel-summary">{balanceAdjustmentDateLabel(event)} · {event.kindLabel}</span>}>
                <div className="win-rates-filters balance-adjustment-scope-filter">
                  <label><span>表示対象</span><select ref={scopeSelectRef} aria-label="表示対象" value={scope ?? 'all'} aria-controls={contentId}
                    disabled={detailsState.status !== 'ready'} onChange={change => {
                      pendingOverviewSelection.current = null
                      onScopeChange(change.target.value === 'all' ? null : change.target.value)
                    }}>
                    <option value="all">すべて</option>
                    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    {unknownScope && <option value={scope ?? ''} disabled>表示対象が見つかりません</option>}
                  </select></label>
                </div>
                <div id={contentId}>
                  {detailsState.status === 'loading' ? <DataLoadState loading message="技別内容を読み込み中…" />
                    : detailsState.status === 'error' ? <DataLoadState message="技別内容を読み込めませんでした。" onRetry={() => setDetailsVersion(version => version + 1)} />
                      : unknownScope ? <DataLoadState message="指定された表示対象は見つかりません。" />
                        : <BalanceAdjustmentDetailContent event={event} patch={patch} status={detailsState.status} scope={scope} />}
                </div>
              </StatisticsPanel>
            </div>
          </>}
  </section>
}
