import { useEffect, useId, useMemo, useState, type MouseEvent } from 'react'
import { loadBalanceAdjustmentCatalog } from '../lib/balanceAdjustments'
import { loadBalanceAdjustmentDetails, balanceAdjustmentPatchDetails } from '../lib/balanceAdjustmentDetails'
import { balanceAdjustmentCharacters, balanceAdjustmentMonthOptions, filterBalanceAdjustmentList, initialBalanceAdjustmentListFilters, selectBalanceAdjustmentEvent, updateBalanceAdjustmentPeriod } from '../lib/balanceAdjustmentList'
import { buildBalanceAdjustmentCountRows } from '../lib/balanceAdjustmentCountChart'
import { loadCharacterManifest } from '../lib/characters'
import { timestampLabel } from '../lib/dateTime'
import { monthLabel } from '../lib/winRateHistory'
import type { BalanceAdjustmentCatalog } from '../types/balanceAdjustments'
import type { BalanceAdjustmentDetailsLoadState, BalanceAdjustmentListFilters } from '../types/balanceAdjustmentDetails'
import type { CharacterManifest } from '../types/characters'
import { BalanceAdjustmentCharactersTable, BalanceAdjustmentOverviewTable, COMMON_ADJUSTMENT_SCOPE, balanceAdjustmentDateLabel } from './BalanceAdjustmentTable'
import { BalanceAdjustmentCountChart } from './BalanceAdjustmentCountChart'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import '../win-rates.css'
import '../control-type-ratio.css'
import '../balance-adjustments.css'

type BootstrapState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; catalog: BalanceAdjustmentCatalog; manifest: CharacterManifest }

export function BalanceAdjustmentsPage({ onOpenDetail }: {
  onOpenDetail: (event: MouseEvent<HTMLAnchorElement>, adjustmentId: string, scope: string | null) => void
}) {
  const contentId = useId()
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [detailsState, setDetailsState] = useState<BalanceAdjustmentDetailsLoadState>({ status: 'loading' })
  const [detailsVersion, setDetailsVersion] = useState(0)
  const [filters, setFilters] = useState<BalanceAdjustmentListFilters | null>(null)
  const [view, setView] = useState<'overall' | 'characters'>('overall')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedScope, setSelectedScope] = useState<string | null>(null)
  const [showChartValues, setShowChartValues] = useState(true)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void Promise.all([loadBalanceAdjustmentCatalog(), loadCharacterManifest()]).then(([catalog, manifest]) => {
      if (!current) return
      setFilters(initialBalanceAdjustmentListFilters(catalog))
      setBootstrap({ status: 'ready', catalog, manifest })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [bootstrapVersion])

  const catalog = bootstrap.status === 'ready' ? bootstrap.catalog : null
  const manifest = bootstrap.status === 'ready' ? bootstrap.manifest : null

  useEffect(() => {
    if (!catalog || !manifest) return
    let current = true
    setDetailsState({ status: 'loading' })
    void loadBalanceAdjustmentDetails(catalog, manifest).then(details => {
      if (current) setDetailsState({ status: 'ready', catalog: details })
    }).catch(() => { if (current) setDetailsState({ status: 'error' }) })
    return () => { current = false }
  }, [catalog, manifest, detailsVersion])

  const result = useMemo(() => catalog && filters ? filterBalanceAdjustmentList(catalog, detailsState.status === 'ready' ? detailsState.catalog : null, filters)
    : { events: [], unknownCount: 0 }, [catalog, detailsState, filters])
  const chartRows = useMemo(() => buildBalanceAdjustmentCountRows(result.events,
    detailsState.status === 'ready' ? detailsState.catalog : null, filters?.characterId ?? 'all'), [result.events, detailsState, filters?.characterId])
  const event = selectBalanceAdjustmentEvent(result.events, selectedId)
  const patch = event && detailsState.status === 'ready' ? balanceAdjustmentPatchDetails(detailsState.catalog, event) : null
  const characters = useMemo(() => patch && filters ? balanceAdjustmentCharacters(patch, filters.characterId) : [], [patch, filters])
  const commonVisible = filters?.characterId === 'all' && !!patch && (patch.common.changes.length > 0 || patch.common.policy.length > 0)
  const effectiveScope = selectedScope === COMMON_ADJUSTMENT_SCOPE && commonVisible ? selectedScope
    : characters.some(character => character.characterId === selectedScope) ? selectedScope
      : characters[0]?.characterId ?? (commonVisible ? COMMON_ADJUSTMENT_SCOPE : null)
  const detailsRequired = view === 'characters' || filters?.characterId !== 'all'

  useEffect(() => { if (event && event.id !== selectedId) setSelectedId(event.id) }, [event, selectedId])
  useEffect(() => { if (effectiveScope !== selectedScope) setSelectedScope(effectiveScope) }, [effectiveScope, selectedScope])

  if (bootstrap.status === 'loading') return <DataLoadState loading message="バトル変更履歴と条件を読み込み中…" />
  if (bootstrap.status === 'error' || !catalog || !manifest || !filters) return <DataLoadState message="バトル変更履歴と条件を読み込めませんでした。" onRetry={() => setBootstrapVersion(version => version + 1)} />

  const months = balanceAdjustmentMonthOptions(catalog)
  const characterName = filters.characterId === 'all' ? '全キャラ' : manifest.characters.find(character => character.id === filters.characterId)?.name ?? filters.characterId
  const count = view === 'overall' ? `${result.events.length}件のバトル変更履歴` : event
    ? `${balanceAdjustmentDateLabel(event)} · ${patch ? `${characters.length}キャラ${commonVisible ? '・共通' : ''}` : '技別内容 未取込'}` : '—'
  const hasTableData = detailsState.status === 'ready' || !detailsRequired

  return <section className="balance-adjustments-page" aria-label="バトル変更一覧">
    <StatisticsPanel title="条件選択" headerContent={<span className="monthly-statistics-panel-summary">{characterName} · {monthLabel(filters.fromMonth)}〜{monthLabel(filters.toMonth)}</span>}>
      <div className="win-rates-view-selector control-ratio-view-selector" role="group" aria-label="バトル変更一覧の表示">
        {([['overall', '全体'], ['characters', 'キャラ別']] as const).map(([value, label]) => <button key={value} type="button" className="win-rates-button"
          aria-pressed={view === value} aria-controls={`${contentId}-table`} onClick={() => setView(value)}>{label}</button>)}
      </div>
      <div className="win-rates-filters control-ratio-filters">
        <label><span>キャラクター</span><select aria-label="キャラクター" value={filters.characterId} onChange={change => setFilters({ ...filters, characterId: change.target.value })}>
          <option value="all">すべて</option>{manifest.characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
        </select></label>
        <label><span>開始月</span><select aria-label="開始月" value={filters.fromMonth} onChange={change => setFilters(updateBalanceAdjustmentPeriod(filters, 'fromMonth', change.target.value))}>
          {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
        </select></label>
        <label><span>終了月</span><select aria-label="終了月" value={filters.toMonth} onChange={change => setFilters(updateBalanceAdjustmentPeriod(filters, 'toMonth', change.target.value))}>
          {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
        </select></label>
      </div>
      {view === 'characters' && <div className="win-rates-filters control-ratio-month-filter">
        <label><span>確認する変更日</span><select aria-label="確認する変更日" value={event?.id ?? ''} disabled={result.events.length === 0 || !hasTableData} onChange={change => setSelectedId(change.target.value)}>
          {result.events.length === 0 && <option value="">—</option>}{result.events.map(item => <option key={item.id} value={item.id}>{balanceAdjustmentDateLabel(item)}</option>)}
        </select></label>
      </div>}
    </StatisticsPanel>

    <StatisticsPanel title="グラフ" headerContent={detailsState.status === 'ready' && <span className="monthly-statistics-panel-summary">
      {chartRows.length}件 · 日付順（古い→新しい）
    </span>}>
      <div className="balance-adjustment-chart-controls">
        <label className="win-rates-chart-value-toggle"><input type="checkbox" checked={showChartValues}
          aria-controls={`${contentId}-chart`} onChange={change => setShowChartValues(change.target.checked)} />数値を表示</label>
      </div>
      <div id={`${contentId}-chart`}>
        {detailsState.status === 'loading' ? <DataLoadState loading message="技別内容を読み込み中…" />
          : detailsState.status === 'error' ? <DataLoadState message="技別内容を読み込めませんでした。" onRetry={() => setDetailsVersion(version => version + 1)} />
            : <BalanceAdjustmentCountChart rows={chartRows} showValues={showChartValues} subjectLabel={characterName} />}
      </div>
      <details className="win-rates-details balance-adjustment-chart-help"><summary>項目数の数え方</summary><div className="win-rates-details-content">
        <p>公式の変更内容1行を1項目として数え、調整方針は含めません。「すべて」は共通とキャラ固有の合計、キャラ指定時はそのキャラ固有の項目数です。</p>
        <p>変更のない月は棒を追加しません。本文未取込は0項目にせず、未取込として表示します。</p>
      </div></details>
    </StatisticsPanel>

    <StatisticsPanel title="テーブル" headerContent={hasTableData && <span className="monthly-statistics-panel-summary" aria-live="polite">{count}</span>}>
      <div id={`${contentId}-table`} className="balance-adjustment-table-content">
        {detailsState.status === 'error' && <DataLoadState message="技別内容を読み込めませんでした。" onRetry={() => setDetailsVersion(version => version + 1)} />}
        {detailsRequired && detailsState.status === 'loading' && <DataLoadState loading message="技別内容を読み込み中…" />}
        {hasTableData && <>
          {result.unknownCount > 0 && <p className="balance-adjustment-state" role="status">対象キャラ未確認の{result.unknownCount}件を除外しています。</p>}
          {result.events.length === 0 ? <p className="balance-adjustment-state" role="status">この条件で確認できるバトル変更履歴はありません。</p>
            : view === 'overall' ? <BalanceAdjustmentOverviewTable events={result.events} details={detailsState} selectedId={event?.id ?? null}
              detailScope={filters.characterId === 'all' ? null : filters.characterId} characterId={filters.characterId} onOpen={(click, id, scope) => {
                if (click.button === 0 && !click.metaKey && !click.ctrlKey && !click.shiftKey && !click.altKey) setSelectedId(id)
                onOpenDetail(click, id, scope)
              }} />
              : patch ? <BalanceAdjustmentCharactersTable patch={patch} characters={characters} includeCommon={filters.characterId === 'all'} selectedScope={effectiveScope}
                onOpen={(click, scope) => {
                  if (click.button === 0 && !click.metaKey && !click.ctrlKey && !click.shiftKey && !click.altKey) setSelectedScope(scope)
                  onOpenDetail(click, patch.adjustmentId, scope)
                }} />
                : <p className="balance-adjustment-state" role="status">このバトル変更の技別内容は未取込です。</p>}
        </>}
        <details className="win-rates-details"><summary>データの範囲・出典</summary><div className="win-rates-details-content balance-adjustment-detail-content">
          <p>履歴は{monthLabel(catalog.coverage.fromMonth)}〜{monthLabel(catalog.coverage.toMonth)}の公式変更リストを確認しています。実施日を確認できた履歴は実施日、それ以外は「リスト日」と表示します。</p>
          <p>技別内容が未取込の履歴は、対象キャラも未確認として扱います。キャラを絞り込んだ場合は、その件数を表示して一覧から除外します。公式の未掲載、確認した変更なし、読込失敗とは区別します。</p>
          <p>キャラを絞り込むと、そのキャラ固有の変更が掲載された履歴を表示します。共通の変更は「すべて」で確認できます。未掲載は、その版にキャラ固有の記載がないことを表します。</p>
          <p>項目数は公式リストの変更内容の行数です。同じ変更箇所でも分類ごとに行が分かれている場合は別項目として数え、一つの行に①②などで複数の変更が書かれている場合は1項目として数えます。分類は公式の「調整」「不具合修正」などを保持しています。</p>
          <p>公式で空欄の変更箇所・分類は「—」で表示します。公式の取消線と強調は「【取消線】〜【/取消線】」「【強調】〜【/強調】」で保持し、後日の訂正や追記も含めて表示します。</p>
          {detailsState.status === 'ready' && <p>技別内容の収録版：{detailsState.catalog.patches.map(item => item.date.replaceAll('-', '/')).join('、') || 'なし'}。</p>}
          <dl className="win-rates-source">
            <div><dt>出典</dt><dd><a href={catalog.source.url} target="_blank" rel="noreferrer">{catalog.source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
            <div><dt>履歴の確認日時</dt><dd><time dateTime={catalog.checkedAt}>{timestampLabel(catalog.checkedAt)}</time></dd></div>
            <div><dt>履歴の生成日時</dt><dd><time dateTime={catalog.generatedAt}>{timestampLabel(catalog.generatedAt)}</time></dd></div>
            {detailsState.status === 'ready' && <div><dt>技別内容の生成日時</dt><dd><time dateTime={detailsState.catalog.generatedAt}>{timestampLabel(detailsState.catalog.generatedAt)}</time></dd></div>}
          </dl>
        </div></details>
      </div>
    </StatisticsPanel>
  </section>
}
