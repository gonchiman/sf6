import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { loadBalanceAdjustmentCatalog } from '../lib/balanceAdjustments'
import { timestampLabel } from '../lib/dateTime'
import { monthlyStatisticDefinition, monthlyStatisticValueLabel } from '../lib/monthlyWinRateStatisticsChart'
import { MONTHLY_USAGE_STATISTIC_METRICS } from '../lib/monthlyUsageRateStatisticsChart'
import { createMonthlyUsageStatisticsComparison, loadMonthlyUsageStatisticsComparison } from '../lib/monthlyUsageRateStatisticsComparison'
import { selectUsageRateHistoryConditions, usageRateHistoryRequestKey } from '../lib/usageRateHistory'
import { loadUsageRateManifest, usageRateEditionOf, USAGE_RATE_EDITIONS, USAGE_RATE_EDITION_LEAGUES, USAGE_RATE_EDITION_SOURCES } from '../lib/usageRates'
import { monthLabel } from '../lib/winRateHistory'
import type { BalanceAdjustmentLoadState } from '../types/balanceAdjustments'
import type { LeagueUsageStatisticsDatasetResults, MonthlyUsageRateStatisticMetric, MonthlyUsageRateStatisticsMode, MonthlyUsageRateStatisticsSelection } from '../types/monthlyUsageRateStatistics'
import type { UsageRateManifest } from '../types/usageRates'
import { ComparisonSelection } from './ComparisonSelection'
import { DataLoadState } from './DataLoadState'
import { LeagueSeriesKey } from './LeagueSeriesKey'
import { MonthlyStatisticsAdjustments } from './MonthlyStatisticsAdjustments'
import { MonthlyStatisticsTable } from './MonthlyStatisticsTable'
import { MonthlyUsageRateStatisticsChart } from './MonthlyUsageRateStatisticsChart'
import { StatisticsPanel } from './StatisticsPanel'
import { UsageRateHistoryPeriodFilters } from './UsageRateHistoryPeriodFilters'
import { usageRateLeagueLabel } from './controlTypeRatioFormatting'
import '../win-rates.css'
import '../win-rate-history.css'
import '../monthly-win-rate-statistics.css'

type BootstrapState = { status: 'loading' | 'error' } | { status: 'ready'; manifest: UsageRateManifest }
type HistoryState = { key: string; version: number } & (
  { status: 'loading' | 'error' } | { status: 'ready'; results: LeagueUsageStatisticsDatasetResults[] }
)
const CONTROL_LABELS = { combined: '合算', classic: 'クラシック', modern: 'モダン' } as const

export function MonthlyUsageRateStatisticsPage() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [selection, setSelection] = useState<MonthlyUsageRateStatisticsSelection | null>(null)
  const [leagues, setLeagues] = useState<string[]>(['MASTER'])
  const [mode, setMode] = useState<MonthlyUsageRateStatisticsMode>('monthly')
  const [metric, setMetric] = useState<MonthlyUsageRateStatisticMetric>('standardDeviationPoints')
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [historyState, setHistoryState] = useState<HistoryState | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [adjustmentState, setAdjustmentState] = useState<BalanceAdjustmentLoadState>({ status: 'loading' })
  const [adjustmentVersion, setAdjustmentVersion] = useState(0)
  const [selectedAdjustmentId, setSelectedAdjustmentId] = useState<string | null>(null)
  const adjustmentDetailsId = useId()
  const adjustmentTriggerId = useRef<string | null>(null)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void loadUsageRateManifest().then(manifest => {
      if (!current) return
      const edition = USAGE_RATE_EDITIONS.find(edition => manifest.datasets.some(item => usageRateEditionOf(item) === edition))
      const initial = edition ? selectUsageRateHistoryConditions(manifest, edition) : null
      if (!initial) { setBootstrap({ status: 'error' }); return }
      const available = USAGE_RATE_EDITION_LEAGUES[initial.edition].filter(league => manifest.datasets.some(item => usageRateEditionOf(item) === initial.edition && item.league === league))
      const league = available.includes('MASTER') ? 'MASTER' : available[0]
      setSelection({ ...initial, league, controlType: 'combined' })
      setLeagues([league])
      setBootstrap({ status: 'ready', manifest })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [bootstrapVersion])

  useEffect(() => {
    let current = true
    setAdjustmentState({ status: 'loading' })
    void loadBalanceAdjustmentCatalog().then(catalog => {
      if (current) setAdjustmentState({ status: 'ready', catalog })
    }).catch(() => { if (current) setAdjustmentState({ status: 'error' }) })
    return () => { current = false }
  }, [adjustmentVersion])

  const manifest = bootstrap.status === 'ready' ? bootstrap.manifest : null
  const edition = selection?.edition ?? 'general'
  const availableLeagues = useMemo(() => USAGE_RATE_EDITION_LEAGUES[edition].filter(league =>
    manifest?.datasets.some(item => usageRateEditionOf(item) === edition && item.league === league)), [manifest, edition])
  const selectedLeagues = useMemo(() => {
    const retained = leagues.filter(league => availableLeagues.includes(league))
    return retained.length ? retained : availableLeagues.includes('MASTER') ? ['MASTER'] : availableLeagues.slice(0, 1)
  }, [leagues, availableLeagues])
  const league = selectedLeagues[0]
  const fromMonth = selection?.fromMonth
  const toMonth = selection?.toMonth
  // One monthly file contains all three controls. Projection edits do not start a new request.
  const query = useMemo<MonthlyUsageRateStatisticsSelection | null>(() => league && fromMonth && toMonth
    ? { edition, league, fromMonth, toMonth, controlType: 'combined' } : null, [edition, league, fromMonth, toMonth])
  const requestKey = manifest && query ? JSON.stringify(selectedLeagues.map(league => usageRateHistoryRequestKey(manifest, { ...query, league }))) : null

  useEffect(() => {
    if (!manifest || !query || !requestKey) return
    let current = true
    const key = requestKey
    setHistoryState({ key, version: historyVersion, status: 'loading' })
    void loadMonthlyUsageStatisticsComparison(manifest, query, selectedLeagues).then(results => {
      if (current) setHistoryState({ key, version: historyVersion, status: 'ready', results })
    }).catch(() => { if (current) setHistoryState({ key, version: historyVersion, status: 'error' }) })
    return () => { current = false }
  }, [manifest, query, requestKey, selectedLeagues, historyVersion])

  const currentState = historyState?.key === requestKey && historyState.version === historyVersion ? historyState : null
  const readyResults = currentState?.status === 'ready' ? currentState.results : null
  const statistics = useMemo(() => manifest && selection && readyResults
    ? createMonthlyUsageStatisticsComparison(manifest, selection, readyResults, mode) : null,
  [manifest, selection, readyResults, mode])
  const rows = statistics?.[0]?.statistics.rows ?? []
  const effectiveSelectedMonth = rows.some(row => row.month === selectedMonth) ? selectedMonth : rows.at(-1)?.month ?? null
  const selectedValues = (statistics ?? []).flatMap(item => {
    const row = item.statistics.rows.find(row => row.month === effectiveSelectedMonth)
    return row ? [{ league: item.league, row }] : []
  })
  const selectedIndex = rows.findIndex(row => row.month === effectiveSelectedMonth)
  const metricDefinition = monthlyStatisticDefinition(metric)
  const adjustmentCatalog = adjustmentState.status === 'ready' ? adjustmentState.catalog : null
  const selectedAdjustment = adjustmentCatalog?.events.find(event => event.id === selectedAdjustmentId
    && fromMonth && toMonth && event.date.slice(0, 7) >= fromMonth && event.date.slice(0, 7) <= toMonth) ?? null

  useEffect(() => {
    if (selectedAdjustmentId && !selectedAdjustment) setSelectedAdjustmentId(null)
  }, [selectedAdjustmentId, selectedAdjustment])

  if (bootstrap.status === 'loading') return <DataLoadState loading message="期間と条件を読み込み中…" />
  if (bootstrap.status === 'error' || !manifest || !selection) return <DataLoadState
    message="期間と条件を読み込めませんでした。" onRetry={() => setBootstrapVersion(version => version + 1)} />

  const failedLeagues = (statistics ?? []).flatMap(item => {
    const count = item.statistics.rows.filter(row => row.status === 'error').length
    return count ? [`${usageRateLeagueLabel(item.league)}：${rows.length}か月中${count}か月`] : []
  })
  const incompleteLeagues = (statistics ?? []).filter(item => item.statistics.commonUnavailable).map(item => usageRateLeagueLabel(item.league))
  const detailsRows = rows.flatMap(month => (statistics ?? []).flatMap(item => {
    const row = item.statistics.rows.find(row => row.month === month.month)
    return row ? [{ league: item.league, row }] : []
  }))
  const mismatches = detailsRows.filter(({ row }) => row.totalMismatch)
  const source = edition === 'general' ? manifest.source : USAGE_RATE_EDITION_SOURCES.master
  const sources = detailsRows.flatMap(({ row }) => row.source ? [row.source] : [])
  const notes = [...new Set(sources.flatMap(source => source.notes))]
  const changeEdition = (value: string) => {
    const nextEdition = USAGE_RATE_EDITIONS.find(item => item === value)
    if (!nextEdition) return
    const available = USAGE_RATE_EDITION_LEAGUES[nextEdition].filter(league => manifest.datasets.some(item => usageRateEditionOf(item) === nextEdition && item.league === league))
    const retained = selectedLeagues.filter(league => available.includes(league))
    const nextLeagues = retained.length ? retained : available.includes('MASTER') ? ['MASTER'] : available.slice(0, 1)
    const next = selectUsageRateHistoryConditions(manifest, nextEdition, { ...selection, league: nextLeagues[0] })
    if (!next || !nextLeagues.length) return
    setLeagues(nextLeagues)
    setSelection({ ...next, controlType: nextEdition === 'master' ? 'combined' : selection.controlType })
  }

  return <section className="monthly-win-rate-statistics-page" aria-label="月別使用率統計">
    <StatisticsPanel title="条件選択" headerContent={<span className="monthly-statistics-panel-summary">{monthLabel(selection.fromMonth)}〜{monthLabel(selection.toMonth)}</span>}>
      <div className="monthly-statistics-condition-fields">
        <div className="win-rates-filters history-filters">
          <label><span>統計</span><select aria-label="統計" value={edition} onChange={event => changeEdition(event.target.value)}>
            {USAGE_RATE_EDITIONS.filter(value => manifest.datasets.some(item => usageRateEditionOf(item) === value)).map(value => <option key={value} value={value}>{value === 'general' ? '総合版' : 'マスター版'}</option>)}
          </select></label>
          <label><span>操作タイプ</span><select aria-label="操作タイプ" value={selection.controlType}
            onChange={event => { const controlType = Object.keys(CONTROL_LABELS).find(key => key === event.target.value) as keyof typeof CONTROL_LABELS | undefined; if (controlType) setSelection({ ...selection, controlType }) }}>
            {(edition === 'master' ? ['combined'] as const : ['combined', 'classic', 'modern'] as const).map(value => <option key={value} value={value}>{CONTROL_LABELS[value]}</option>)}
          </select></label>
          <UsageRateHistoryPeriodFilters manifest={manifest} edition={edition} selection={selection}
            onChange={next => setSelection({ ...next, controlType: selection.controlType })} />
        </div>
        <div className="monthly-statistics-mode">
          <label><span>集計対象</span><select aria-label="集計対象" value={mode} onChange={event => setMode(event.target.value as MonthlyUsageRateStatisticsMode)}>
            <option value="monthly">各月の掲載キャラ</option><option value="common">選択期間の共通キャラ</option>
          </select></label>
          {statistics && mode === 'common' && <span className="monthly-statistics-common-count" role="status">各リーグ内の共通キャラ：{statistics.map(item => `${usageRateLeagueLabel(item.league)} ${item.statistics.commonCharacterCount ?? '確認不可'}${item.statistics.commonCharacterCount === null ? '' : 'キャラ'}`).join('、')}</span>}
        </div>
      </div>
      <div className="monthly-statistics-league-selection"><ComparisonSelection
        items={availableLeagues.map(league => ({ id: league, name: usageRateLeagueLabel(league) }))} selectedIds={selectedLeagues}
        onChange={next => { setLeagues(next); setSelection({ ...selection, league: next[0] }) }}
        label="リーグ" selectionLabel="選択中のリーグ" pickerLabel="リーグを選択" legendLabel="比較するリーグ"
        renderKey={id => <LeagueSeriesKey league={id} />} showOptionKeys layout="grid"
        selectionCountLabel={count => `${count}リーグ選択中`} minimumSelectionLabel="1リーグ以上選択" /></div>
    </StatisticsPanel>

    <StatisticsPanel title="グラフ" headerContent={<label className="monthly-statistics-metric"><span>表示する統計量</span>
      <select aria-label="表示する統計量" value={metric} onChange={event => { const next = MONTHLY_USAGE_STATISTIC_METRICS.find(item => item.key === event.target.value); if (next) setMetric(next.key) }}>
        {MONTHLY_USAGE_STATISTIC_METRICS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>}>
      {(!currentState || currentState.status === 'loading') && <DataLoadState loading message="月別の使用率を読み込み中…" />}
      {currentState?.status === 'error' && <DataLoadState message="月別の使用率を読み込めませんでした。" onRetry={() => setHistoryVersion(version => version + 1)} />}
      {statistics && <>
        {failedLeagues.length > 0 && <div className="history-load-error" role="alert"><span>読み込めなかったデータ：{failedLeagues.join('、')}</span><button type="button" className="win-rates-button" onClick={() => setHistoryVersion(version => version + 1)}>再読み込み</button></div>}
        {mode === 'common' && incompleteLeagues.length > 0 && <div className="monthly-statistics-message" role="status">{incompleteLeagues.join('、')}は期間内のデータが揃っていないため、共通キャラの統計を算出できません。</div>}
        {mismatches.length > 0 && <div className="monthly-statistics-message" role="status">公開値の合計不一致：{mismatches.map(({ league, row }) => `${monthLabel(row.month)} ${usageRateLeagueLabel(league)} ${row.publishedTotalPercent?.toFixed(3)}%`).join('、')}。元の公表値を使って集計しています。</div>}
        <div className="monthly-statistics-chart-heading"><h3>{metricDefinition.label}の推移</h3><span>{mode === 'monthly' ? '各月の掲載キャラ' : '選択期間の共通キャラ'}</span></div>
        {effectiveSelectedMonth && <MonthlyUsageRateStatisticsChart series={statistics} metric={metric} selectedMonth={effectiveSelectedMonth} onSelect={setSelectedMonth} />}
        {effectiveSelectedMonth && selectedValues.length > 0 && <>
          <div className="history-selected monthly-statistics-selected" aria-live="polite"><span>{monthLabel(effectiveSelectedMonth)}</span>
            <dl className="history-selected-values monthly-statistics-selected-values">{selectedValues.map(({ league, row }) => <div key={league}>
              <dt><LeagueSeriesKey league={league} />{usageRateLeagueLabel(league)}・{metricDefinition.label}</dt>
              <dd><strong>{monthlyStatisticValueLabel(row, metric)}</strong><span>対象 {row.validCount ?? '—'}／掲載 {row.listedCount ?? '—'} キャラ</span></dd>
            </div>)}</dl></div>
          <label className="history-month-slider"><span>確認する月</span><input type="range" min={0} max={Math.max(0, rows.length - 1)} step={1}
            value={selectedIndex} disabled={rows.length < 2} aria-label="確認する月"
            aria-valuetext={`${monthLabel(effectiveSelectedMonth)} ${metricDefinition.label} ${selectedValues.map(({ league, row }) => `${usageRateLeagueLabel(league)} ${monthlyStatisticValueLabel(row, metric)}`).join('、')}`}
            onChange={event => setSelectedMonth(rows[Number(event.target.value)].month)} /></label>
        </>}
      </>}
    </StatisticsPanel>

    <StatisticsPanel title="テーブル" headerContent={statistics && <span className="monthly-statistics-panel-summary">{statistics.length}リーグ・{rows.length}か月の数値</span>}>
      {statistics && adjustmentState.status === 'error' && <div className="history-load-error" role="alert"><span>バランス調整の履歴を読み込めませんでした。</span><button type="button" className="win-rates-button" onClick={() => setAdjustmentVersion(version => version + 1)}>調整履歴を再読み込み</button></div>}
      {statistics ? <MonthlyStatisticsTable series={statistics} selectedMonth={effectiveSelectedMonth} selectedMetric={metric} onSelect={setSelectedMonth}
        metricDefinitions={MONTHLY_USAGE_STATISTIC_METRICS}
        regionLabel="月別使用率統計・スクロール領域" caption="各月・リーグのキャラ別公式使用率を同じ重みで集計した統計量"
        adjustmentState={adjustmentState} selectedAdjustmentId={selectedAdjustment?.id ?? null} adjustmentDetailsId={adjustmentDetailsId}
        onSelectAdjustment={(id, triggerId) => { adjustmentTriggerId.current = triggerId; setSelectedAdjustmentId(current => current === id ? null : id) }} />
        : <p className="monthly-statistics-table-state" role="status">{currentState?.status === 'error' ? '月別の数値を読み込めませんでした。' : '月別の数値を読み込み中…'}</p>}
    </StatisticsPanel>

    {statistics && <>
      <MonthlyStatisticsAdjustments selected={selectedAdjustment} catalog={adjustmentCatalog} detailsId={adjustmentDetailsId} measureLabel="使用率"
        onClose={() => { if (adjustmentTriggerId.current) document.getElementById(adjustmentTriggerId.current)?.focus({ preventScroll: true }); setSelectedAdjustmentId(null) }} />
      <details className="win-rates-details"><summary>統計量の見方</summary><div className="win-rates-details-content">
        <p>各月・リーグ・操作タイプのキャラ別公式使用率を、1キャラを1つの値として同じ重みで集計します。保存値の9566は9.566%として扱い、計算後に表示を小数第2位へ丸めています。試合数やプレイヤー数の平均ではありません。</p>
        <p>平均は有効値の合計÷対象キャラ数N、中央値は値を並べた中央の値です。標準偏差は平均との差の二乗をNで割って平方根を取り、使用率の1%分の差を1ポイントとして表示します。1キャラだけの場合は標準偏差を算出せず「—」と表示します。</p>
        <p>変動係数は同じ対象キャラの標準偏差÷実際の平均使用率です。平均を1としたばらつきを比率で表示し、0なら均等、数値が大きいほど平均に対する使用率の差が大きくなります。百分率やポイントではなく、1を超えることもあります。平均が0、標準偏差が算出不能、対象が1キャラ以下の場合は「—」です。</p>
        <p>全キャラの使用率合計が約100%なら、平均はほぼ100÷キャラ数です。キャラ追加も数値に影響します。標準偏差は使用率の偏りを表し、ゲームバランスの良否・確かさ・有意差を表すものではありません。</p>
        <p>「各月の掲載キャラ」はその月の有効値を使います。「選択期間の共通キャラ」は各リーグ内で全月に有効値のある同じキャラだけを使い、合計100%への再正規化はしません。リーグ同士の値を合算せず、共通キャラもリーグごとに求めます。</p>
        <p>対象／掲載は集計に使ったキャラ数／その条件の掲載キャラ数です。欠損を除外し、実際の0%は含めます。未掲載キャラを0%で補いません。共通キャラの確認に必要な月が未登録・読込失敗の場合、そのリーグの共通統計は算出しません。</p>
        <p>すべての指標は0からの縦軸で表示し、数値がない月は線を切ります。使用率には勝率の50%参考線を表示しません。元の使用件数・分母の具体的な定義・ミラー戦などの扱いは提供データから確認できないため復元していません。</p>
      </div></details>
      <details className="win-rates-details"><summary>除外状況・出典</summary><div className="win-rates-details-content monthly-statistics-data-details">
        <dl className="win-rates-source">
          <div><dt>対象期間</dt><dd>{monthLabel(selection.fromMonth)}〜{monthLabel(selection.toMonth)}</dd></div>
          <div><dt>操作タイプ</dt><dd>{CONTROL_LABELS[selection.controlType]}</dd></div>
          <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
          <div><dt>一覧生成日時</dt><dd><time dateTime={manifest.generatedAt}>{timestampLabel(manifest.generatedAt)}</time></dd></div>
          <div><dt>データ形式</dt><dd>Version {manifest.schemaVersion}</dd></div>
        </dl>
        <div className="data-table-scroll monthly-statistics-exclusion-scroll" role="region" tabIndex={0} aria-label="月別使用率の除外状況・スクロール領域">
          <table className="data-table monthly-statistics-exclusion-table"><caption className="win-rates-visually-hidden">月別・リーグ別の集計除外理由と使用率の取得日時</caption>
            <thead><tr><th scope="col">対象月</th><th scope="col">リーグ</th><th scope="col">状態</th><th scope="col">欠損</th><th scope="col">共通対象外</th><th scope="col">掲載値の合計（%）</th><th scope="col">取得日時</th><th scope="col">生成日時</th></tr></thead>
            <tbody>{detailsRows.map(({ league, row }) => <tr key={`${league}:${row.month}`}>
              <th scope="row">{monthLabel(row.month)}</th><th scope="row" className="monthly-statistics-league-cell"><span className="monthly-statistics-league-label"><LeagueSeriesKey league={league} />{usageRateLeagueLabel(league)}</span></th>
              <td>{row.status === 'ready' ? '取得済み' : row.status === 'error' ? '読込失敗' : row.status === 'incomplete' ? '共通対象未確認' : '未登録'}</td>
              <td>{row.excludedMissingCount ?? '—'}</td><td>{row.excludedNonCommonCount ?? '—'}</td><td>{row.publishedTotalPercent === null ? '—' : row.publishedTotalPercent.toFixed(3)}</td>
              <td className="monthly-statistics-timestamp">{row.capturedAt ? <time dateTime={row.capturedAt}>{timestampLabel(row.capturedAt)}</time> : '—'}</td>
              <td className="monthly-statistics-timestamp">{row.generatedAt ? <time dateTime={row.generatedAt}>{timestampLabel(row.generatedAt)}</time> : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p>除外数はキャラ数で、確認できない数は「—」です。掲載値の合計は共通対象へ絞る前の有効値の合計で、欠損がある場合は部分合計です。操作タイプの合算は公式ALL分布を使い、クラシック・モダンを足し合わせていません。</p>
        <dl><div><dt>対象</dt><dd>{[...new Set(sources.map(source => source.population))].join('、') || '未確認'}</dd></div><div><dt>指標</dt><dd>{[...new Set(sources.map(source => source.metric))].join('、') || '未確認'}</dd></div></dl>
        {mismatches.length > 0 && <ul>{mismatches.map(({ league, row }) => <li key={`${league}:${row.month}`}>{monthLabel(row.month)} {usageRateLeagueLabel(league)}：{row.totalMismatch!.reason}（<time dateTime={row.totalMismatch!.verifiedAt}>{timestampLabel(row.totalMismatch!.verifiedAt)}</time>確認）。<a href={row.totalMismatch!.sourceUrl} target="_blank" rel="noreferrer">公式掲載ページ<span className="win-rates-visually-hidden">（新しいタブ）</span></a></li>)}</ul>}
        {notes.length > 0 && <ul>{notes.map(note => <li key={note}>{note}</li>)}</ul>}
      </div></details>
    </>}
  </section>
}
