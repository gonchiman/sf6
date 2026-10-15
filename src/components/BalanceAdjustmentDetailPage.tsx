import { useEffect, useId, useState, type MouseEventHandler } from 'react'
import { loadBalanceAdjustmentCatalog } from '../lib/balanceAdjustments'
import { balanceAdjustmentPatchDetails, loadBalanceAdjustmentDetails } from '../lib/balanceAdjustmentDetails'
import { loadCharacterManifest } from '../lib/characters'
import type { BalanceAdjustmentCatalog } from '../types/balanceAdjustments'
import type { BalanceAdjustmentDetailsLoadState } from '../types/balanceAdjustmentDetails'
import type { CharacterManifest } from '../types/characters'
import { BalanceAdjustmentDetailContent } from './BalanceAdjustmentDetailContent'
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

  return <section className="balance-adjustments-page balance-adjustment-detail-page" aria-label="調整詳細">
    <a href="#balance-adjustments" className="win-rates-back-link balance-adjustment-back-link" onClick={onBack}>調整一覧へ戻る</a>
    {bootstrap.status === 'loading'
      ? <DataLoadState loading message="調整履歴と条件を読み込み中…" />
      : bootstrap.status === 'error'
        ? <DataLoadState message="調整履歴と条件を読み込めませんでした。" onRetry={() => setBootstrapVersion(version => version + 1)} />
        : !event
          ? <StatisticsPanel title="調整詳細"><DataLoadState message="指定された調整履歴は見つかりません。" /></StatisticsPanel>
          : <StatisticsPanel title={balanceAdjustmentDateLabel(event)} headerContent={<span className="monthly-statistics-panel-summary">{event.kindLabel}</span>}>
            <div className="win-rates-filters balance-adjustment-scope-filter">
              <label><span>表示対象</span><select aria-label="表示対象" value={scope ?? 'all'} aria-controls={contentId}
                disabled={detailsState.status !== 'ready'} onChange={change => onScopeChange(change.target.value === 'all' ? null : change.target.value)}>
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
          </StatisticsPanel>}
  </section>
}
