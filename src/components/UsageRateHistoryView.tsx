import { useEffect, useMemo, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { createUsageRateBaselineHistory, usageRateBaselineRequestKey, usageRateBaselineSelection } from '../lib/usageRateBaseline'
import { createUsageRateComparison, loadUsageRateComparison, usageRateComparisonRequestKey } from '../lib/usageRateComparison'
import { formatUsageRateHistoryPoint, type selectUsageRateHistoryConditions } from '../lib/usageRateHistory'
import { loadUsageRateHistory, USAGE_RATE_EDITION_SOURCES } from '../lib/usageRates'
import { monthLabel } from '../lib/winRateHistory'
import type { UsageRateComparisonResult, UsageRateComparisonRow } from '../types/usageRateComparison'
import type { UsageRateEdition, UsageRateHistoryResult, UsageRateManifest } from '../types/usageRates'
import { DataLoadState } from './DataLoadState'
import { MonthlyUsageRateTable } from './MonthlyUsageRateTable'
import { StatisticsPanel } from './StatisticsPanel'
import { UsageRateHistoryChart, UsageRateHistorySeriesKey } from './UsageRateHistoryChart'
import { UsageRateSeriesEditor } from './UsageRateSeriesEditor'
import { usageRateLeagueLabel } from './controlTypeRatioFormatting'
import '../win-rate-history.css'
import '../usage-rate-history.css'

export { UsageRateHistoryPeriodFilters } from './UsageRateHistoryPeriodFilters'

type Selection = NonNullable<ReturnType<typeof selectUsageRateHistoryConditions>>
type Character = { characterId: string; name: string }
type LoadState<T> =
  | { key: string; version: number; status: 'loading' }
  | { key: string; version: number; status: 'error' }
  | { key: string; version: number; status: 'ready'; results: T }

function initialRows(edition: UsageRateEdition, character: Character, operationMode: 'combined' | 'separate'): UsageRateComparisonRow[] {
  const controls = edition === 'general' && operationMode === 'separate' ? ['classic', 'modern'] as const : ['combined'] as const
  return controls.map((controlType, index) => ({
    id: `${edition}-initial-${index}`, characterId: character.characterId, characterName: character.name,
    league: 'MASTER', controlType, colorSlot: index,
  }))
}

export function UsageRateHistoryView({ active, manifest, edition, selection, operationMode, character, characters }: {
  active: boolean
  manifest: UsageRateManifest
  edition: UsageRateEdition
  selection: Selection | null
  operationMode: 'combined' | 'separate'
  character: Character
  characters: readonly Character[]
}) {
  const [rowsByEdition, setRowsByEdition] = useState<Record<UsageRateEdition, UsageRateComparisonRow[]>>(() => ({
    general: initialRows('general', character, operationMode), master: initialRows('master', character, operationMode),
  }))
  const rows = rowsByEdition[edition]
  const [state, setState] = useState<LoadState<UsageRateComparisonResult[]> | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const [showBaseline, setShowBaseline] = useState(true)
  const [baselineState, setBaselineState] = useState<LoadState<UsageRateHistoryResult[]> | null>(null)
  const [baselineVersion, setBaselineVersion] = useState(0)
  const requestKey = selection ? usageRateComparisonRequestKey(manifest, selection, rows) : null
  const fromMonth = selection?.fromMonth
  const toMonth = selection?.toMonth
  const baselineSelection = useMemo(() => fromMonth && toMonth ? usageRateBaselineSelection({
    edition: 'general', league: 'ALL', fromMonth, toMonth,
  }) : null, [fromMonth, toMonth])
  const baselineKey = baselineSelection ? usageRateBaselineRequestKey(manifest, baselineSelection) : null

  useEffect(() => {
    if (!active || !selection || !requestKey) return
    if (state?.key === requestKey && state.version === historyVersion && state.status === 'ready') return
    let current = true
    const key = requestKey
    setState({ key, version: historyVersion, status: 'loading' })
    void loadUsageRateComparison(manifest, selection, rows).then(results => {
      if (current) setState({ key, version: historyVersion, status: 'ready', results })
    }).catch(() => { if (current) setState({ key, version: historyVersion, status: 'error' }) })
    return () => { current = false }
    // The key tracks the edition, publication, period and distinct leagues.
    // Character/control/color edits only project these files, even while loading.
  }, [active, manifest, requestKey, historyVersion])

  useEffect(() => {
    if (!active || !showBaseline || !baselineSelection || !baselineKey) return
    if (baselineState?.key === baselineKey && baselineState.version === baselineVersion && baselineState.status === 'ready') return
    let current = true
    const key = baselineKey
    setBaselineState({ key, version: baselineVersion, status: 'loading' })
    void loadUsageRateHistory(manifest, baselineSelection).then(results => {
      if (current) setBaselineState({ key, version: baselineVersion, status: 'ready', results })
    }).catch(() => { if (current) setBaselineState({ key, version: baselineVersion, status: 'error' }) })
    return () => { current = false }
  }, [active, showBaseline, manifest, baselineSelection, baselineKey, baselineVersion])

  const currentState = state?.key === requestKey ? state : null
  const results = currentState?.status === 'ready' ? currentState.results : null
  const series = useMemo(() => selection && results ? createUsageRateComparison(manifest, selection, rows, results) : [],
    [manifest, selection, rows, results])
  const currentBaselineState = baselineState?.key === baselineKey ? baselineState : null
  const baselineResults = currentBaselineState?.status === 'ready' ? currentBaselineState.results : null
  const baseline = useMemo(() => baselineSelection && baselineResults
    ? createUsageRateBaselineHistory(manifest, baselineSelection, baselineResults) : [], [manifest, baselineSelection, baselineResults])
  const baselineErrors = baseline.filter(point => point.status === 'error').length
  const baselineUnavailable = baseline.filter(point => point.status === 'unavailable').length
  const points = series[0]?.points ?? []
  const effectiveSelectedMonth = selectedMonth && points.some(point => point.month === selectedMonth)
    ? selectedMonth : selectedMonth && points.length && selectedMonth < points[0].month ? points[0].month : points.at(-1)?.month ?? null
  const selectedIndex = points.findIndex(point => point.month === effectiveSelectedMonth)
  const selectedBaselinePoint = baseline.find(point => point.month === effectiveSelectedMonth)
  const selectedValues = series.map(item => ({ ...item, point: item.points[selectedIndex] }))
  const selectedValueText = selectedValues.map(item => `${item.label} ${formatUsageRateHistoryPoint(item.point)}`).join('、')
  const metadata = results?.flatMap(group => group.results.map(result => ({ ...result, league: group.league }))) ?? []
  const failedCount = metadata.filter(result => result.status === 'error').length
  const source = edition === 'general' ? manifest.source : USAGE_RATE_EDITION_SOURCES.master
  const datasets = metadata.flatMap(result => result.status === 'ready' ? [result.dataset] : [])
  const populations = [...new Set(datasets.map(dataset => dataset.source.population))]
  const metrics = [...new Set(datasets.map(dataset => dataset.source.metric))]
  const units = [...new Set(datasets.map(dataset => dataset.source.unit))]
  const notes = [...new Set(datasets.flatMap(dataset => dataset.source.notes))]
  const selectedDates = [...new Set(selectedValues.flatMap(item => item.point?.capturedAt ? [item.point.capturedAt] : []))]
  const totalMismatches = [...new Map(series.flatMap(item => item.points.flatMap(point => point.totalMismatch ? [[
    `${point.month}:${item.league}:${item.controlType}`, {
      key: `${point.month}:${item.league}:${item.controlType}`,
      label: `${monthLabel(point.month)} ${usageRateLeagueLabel(item.league)}（${item.controlType === 'combined' ? '合算' : item.controlType === 'classic' ? 'クラシック' : 'モダン'}）${(point.totalMismatch.observedPercentThousandths / 1000).toFixed(3)}%`,
      evidence: point.totalMismatch,
    },
  ] as const] : []))).values()]
  const retry = () => setHistoryVersion(version => version + 1)
  const retryBaseline = () => setBaselineVersion(version => version + 1)

  if (!selection) return <DataLoadState message="選択した統計区分の使用率データが登録されていません。" />
  return <section className="usage-rate-history-view" aria-label="キャラクターの月別使用率">
    <UsageRateSeriesEditor key={edition} edition={edition} rows={rows} characters={characters}
      onChange={next => setRowsByEdition(previous => ({ ...previous, [edition]: next }))} />
    <StatisticsPanel title="月別使用率推移" headerContent={<label className="win-rates-chart-value-toggle">
      <input type="checkbox" checked={showBaseline} onChange={event => setShowBaseline(event.target.checked)} />均等基準を表示
    </label>}>
      {(!currentState || currentState.status === 'loading') && <DataLoadState loading message="月別の使用率を読み込み中…" />}
      {currentState?.status === 'error' && <DataLoadState message="月別の使用率を読み込めませんでした。" onRetry={retry} />}
      {series.length > 0 && effectiveSelectedMonth && <>
        {failedCount > 0 && <div className="win-rates-comparison-error" role="alert">
          <span>{metadata.length}件中{failedCount}件の使用率を読み込めませんでした。</span>
          <button type="button" className="win-rates-button" onClick={retry}>再読み込み</button>
        </div>}
        {showBaseline && <>
          {(!currentBaselineState || currentBaselineState.status === 'loading') && <div className="win-rates-comparison-error" role="status">
            <span>均等基準を読み込み中…</span>
          </div>}
          {(currentBaselineState?.status === 'error' || baselineErrors > 0) && <div className="win-rates-comparison-error" role="alert">
            <span>均等基準を読み込めない月があります。</span>
            <button type="button" className="win-rates-button" onClick={retryBaseline}>均等基準を再読み込み</button>
          </div>}
          {baselineUnavailable > 0 && <div className="win-rates-comparison-error" role="status">
            <span>均等基準を確認できない月があります。</span>
          </div>}
        </>}
        <UsageRateHistoryChart series={series} selectedMonth={effectiveSelectedMonth} onSelect={setSelectedMonth}
          baseline={showBaseline ? baseline : undefined} />
        <div className="history-selected" aria-live="polite">
          <span>{monthLabel(effectiveSelectedMonth)}</span>
          <dl className="history-selected-values">{selectedValues.map(item => <div key={item.seriesId}>
            <dt><UsageRateHistorySeriesKey colorSlot={item.colorSlot} />{item.label}</dt>
            <dd><strong>{formatUsageRateHistoryPoint(item.point)}</strong></dd>
          </div>)}</dl>
        </div>
        <label className="history-month-slider"><span>確認する月</span>
          <input type="range" min={0} max={Math.max(0, points.length - 1)} step={1} value={selectedIndex}
            disabled={points.length < 2} aria-label="確認する月" aria-valuetext={`${monthLabel(effectiveSelectedMonth)} ${selectedValueText}`}
            onChange={event => setSelectedMonth(points[Number(event.target.value)].month)} />
        </label>
      </>}
    </StatisticsPanel>
    {series.length > 0 && effectiveSelectedMonth && <>
      <details className="win-rates-details usage-rate-history-table" open={tableOpen}
        onToggle={event => setTableOpen(event.currentTarget.open)}>
        <summary>月別の使用率</summary>
        {tableOpen && <div className="usage-rate-history-table-body"><MonthlyUsageRateTable series={series}
          selectedMonth={effectiveSelectedMonth} onSelect={setSelectedMonth} /></div>}
      </details>
      {totalMismatches.length > 0 && <p className="win-rates-comparison-error" role="status">
        {`公開値の合計不一致：${totalMismatches.map(item => item.label).join('、')}。元の公表値を表示しています。`}
      </p>}
      <dl className="win-rates-source">
        <div><dt>対象期間</dt><dd>{monthLabel(selection.fromMonth)}〜{monthLabel(selection.toMonth)}</dd></div>
        {selectedDates.length > 0 && <div><dt>選択月の取得日時</dt><dd>
          {selectedDates.map(date => <time key={date} dateTime={date}>{timestampLabel(date)} </time>)}
        </dd></div>}
        <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}
          <span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
      </dl>
      <details className="win-rates-details"><summary>データの範囲と表記</summary><div className="win-rates-details-content">
        <dl><div><dt>対象</dt><dd>{populations.join('、') || '未確認'}</dd></div>
          <div><dt>指標</dt><dd>{metrics.join('、') || '未確認'}</dd></div>
          <div><dt>単位</dt><dd>{units.join('、') || '未確認'}</dd></div></dl>
        <p>各系列はキャラクター・リーグ・操作タイプの組み合わせです。同じ統計区分と期間で最大6系列を比較し、月や系列の平均、合計100%への再正規化は行いません。各系列の色は条件の編集や他の系列の削除で変わりません。</p>
        {edition === 'general' ? <p>合算は公式ALLの操作タイプ分布です。クラシック・モダンはそれぞれのタイプ内でのキャラ使用率です。ALL（全体）は全リーグを対象とした公式の分布で、各リーグから合算した値ではありません。</p>
          : <p>マスター版は公式の4区分を表示し、操作タイプは合算のみです。総合版の系列は保持され、統計区分を戻すと再表示します。</p>}
        <p>縦軸は0%から始まり、全ての表示値が収まる共通の範囲を使います。数値のない月ではその系列の線を切ります。「未掲載」「未登録」、公式の欠損表記「-」「-.---」、「読込失敗」を0%で補完しません。</p>
        <p>均等基準は100÷Nです。Nは各月の総合版・ALL（全体）・全操作タイプに掲載されたキャラ数を使い、系列数に関係なく全リーグとC／Mで同じ1本の基準線を使います。均等に使われると仮定した比較用の値で、実際の平均や理想値ではありません。月途中の追加キャラも1キャラとして数え、利用可能だった日数は補正しません。確認できない月は基準線を切り、隣の月や現在のキャラ数で補完しません。</p>
        {showBaseline && selectedBaselinePoint?.source && <>
          <p>均等基準の出典・取得情報</p>
          <dl><div><dt>対象月</dt><dd>{monthLabel(effectiveSelectedMonth)}</dd></div>
            <div><dt>出典</dt><dd><a href={selectedBaselinePoint.source.url} target="_blank" rel="noreferrer">{selectedBaselinePoint.source.title}
              <span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
            {selectedBaselinePoint.capturedAt && <div><dt>取得日時</dt><dd><time dateTime={selectedBaselinePoint.capturedAt}>{timestampLabel(selectedBaselinePoint.capturedAt)}</time></dd></div>}
            {selectedBaselinePoint.generatedAt && <div><dt>生成日時</dt><dd><time dateTime={selectedBaselinePoint.generatedAt}>{timestampLabel(selectedBaselinePoint.generatedAt)}</time></dd></div>}
          </dl>
        </>}
        {totalMismatches.length > 0 && <><p>合計不一致の確認記録</p><ul>{totalMismatches.map(item => <li key={item.key}>
          {item.label}：{item.evidence.reason}（確認日時：<time dateTime={item.evidence.verifiedAt}>{timestampLabel(item.evidence.verifiedAt)}</time>）。
          <a href={item.evidence.sourceUrl} target="_blank" rel="noreferrer">公式掲載ページ
            <span className="win-rates-visually-hidden">（新しいタブ）</span></a>
        </li>)}</ul></>}
        <div className="data-table-scroll win-rates-metadata-scroll" role="region" tabIndex={0} aria-label="リーグ別・月別の取得日時・スクロール領域">
          <table className="data-table win-rates-metadata-table"><caption className="win-rates-visually-hidden">リーグ別・月別の取得状態・取得日時・生成日時</caption>
            <thead><tr><th scope="col">リーグ</th><th scope="col">対象月</th><th scope="col">状態</th><th scope="col">取得日時</th><th scope="col">生成日時</th></tr></thead>
            <tbody>{metadata.map(result => <tr key={`${result.league}:${result.month}`}>
              <th scope="row">{usageRateLeagueLabel(result.league)}</th><td>{monthLabel(result.month)}</td>
              <td>{result.status === 'ready' ? '取得済み' : result.status === 'error' ? '読込失敗' : '未登録'}</td>
              <td>{result.status === 'ready' ? <time dateTime={result.dataset.capturedAt}>{timestampLabel(result.dataset.capturedAt)}</time> : '—'}</td>
              <td>{result.status === 'ready' ? <time dateTime={result.dataset.generatedAt}>{timestampLabel(result.dataset.generatedAt)}</time> : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {notes.length > 0 && <><p>保存データの注記</p><ul>{notes.map(note => <li key={note}>{note}</li>)}</ul></>}
      </div></details>
    </>}
  </section>
}
