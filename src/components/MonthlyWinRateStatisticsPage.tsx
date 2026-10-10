import { useEffect, useMemo, useState } from 'react'
import { createMonthlyStatisticsComparison, loadMonthlyStatisticsComparison } from '../lib/monthlyWinRateStatisticsComparison'
import { MONTHLY_STATISTIC_METRICS, monthlyStatisticDefinition, monthlyStatisticValueLabel } from '../lib/monthlyWinRateStatisticsChart'
import { editionOf, leagueLabel, WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_SOURCES } from '../lib/winRateConditions'
import { initialHistorySelection, monthLabel } from '../lib/winRateHistory'
import { loadWinRateManifest } from '../lib/winRates'
import type { MonthlyWinRateStatisticMetric, MonthlyWinRateStatisticsMode } from '../types/monthlyWinRateStatistics'
import type { LeagueStatisticsDatasetResults } from '../types/monthlyWinRateStatisticsComparison'
import type { WinRateHistorySelection } from '../types/winRateHistory'
import type { WinRateManifest } from '../types/winRates'
import { DataLoadState } from './DataLoadState'
import { ComparisonSelection } from './ComparisonSelection'
import { LeagueSeriesKey } from './LeagueSeriesKey'
import { MonthlyWinRateStatisticsTable } from './MonthlyWinRateStatisticsTable'
import { MonthlyWinRateStatisticsChart } from './MonthlyWinRateStatisticsChart'
import { StatisticsPanel } from './StatisticsPanel'
import { WinRateHistoryFilters } from './WinRateHistoryFilters'
import '../win-rates.css'
import '../win-rate-history.css'
import '../monthly-win-rate-statistics.css'

type BootstrapState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; manifest: WinRateManifest }

type HistoryState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error' }
  | { key: string; status: 'ready'; results: LeagueStatisticsDatasetResults[] }

function timestampLabel(value: string): string {
  return `${new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value))} JST`
}

export function MonthlyWinRateStatisticsPage() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [selection, setSelection] = useState<WinRateHistorySelection | null>(null)
  const [leagues, setLeagues] = useState<string[]>(['MASTER'])
  const [mode, setMode] = useState<MonthlyWinRateStatisticsMode>('monthly')
  const [metric, setMetric] = useState<MonthlyWinRateStatisticMetric>('standardDeviationPoints')
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [historyState, setHistoryState] = useState<HistoryState | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void loadWinRateManifest().then(manifest => {
      if (!current) return
      const initial = initialHistorySelection(manifest, 'all')
      setSelection(initial)
      setLeagues([initial.league])
      setBootstrap({ status: 'ready', manifest })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [bootstrapVersion])

  const manifest = bootstrap.status === 'ready' ? bootstrap.manifest : null
  const edition = selection ? editionOf(selection) : 'general'
  const availableLeagues = useMemo(() => WIN_RATE_EDITION_LEAGUES[edition].filter(league =>
    manifest?.datasets.some(item => editionOf(item) === edition && item.league === league)), [manifest, edition])
  const selectedLeagues = useMemo(() => {
    const retained = leagues.filter(league => availableLeagues.includes(league))
    return retained.length ? retained : availableLeagues.includes('MASTER') ? ['MASTER'] : availableLeagues.slice(0, 1)
  }, [leagues, availableLeagues])
  const operationMode = selection?.controlType === 'combined' ? 'combined' : 'separate'
  const league = selectedLeagues[0]
  const fromMonth = selection?.fromMonth
  const toMonth = selection?.toMonth
  // Classic and modern share files; changing the projection does not reload them.
  const query = useMemo<WinRateHistorySelection | null>(() =>
    league && fromMonth && toMonth ? {
      edition, league, fromMonth, toMonth, controlType: operationMode === 'combined' ? 'combined' : 'classic',
    } : null, [edition, league, fromMonth, toMonth, operationMode])
  const requestKey = manifest && query ? JSON.stringify([manifest.generatedAt, query, selectedLeagues]) : null

  useEffect(() => {
    if (!manifest || !query || !requestKey) return
    let current = true
    const requestedKey = requestKey
    setHistoryState({ key: requestedKey, status: 'loading' })
    void loadMonthlyStatisticsComparison(manifest, query, selectedLeagues).then(results => {
      if (current) setHistoryState({ key: requestedKey, status: 'ready', results })
    }).catch(() => {
      if (current) setHistoryState({ key: requestedKey, status: 'error' })
    })
    return () => { current = false }
  }, [manifest, query, requestKey, selectedLeagues, historyVersion])

  // Hide the previous condition's data before the new request's effect runs.
  const currentState = historyState?.key === requestKey ? historyState : null
  const readyResults = currentState?.status === 'ready' ? currentState.results : null
  const statistics = useMemo(() => manifest && selection && readyResults
    ? createMonthlyStatisticsComparison(manifest, selection, readyResults, mode) : null,
  [manifest, selection, readyResults, mode])
  const rows = statistics?.[0]?.statistics.rows ?? []
  const effectiveSelectedMonth = rows.some(row => row.month === selectedMonth)
    ? selectedMonth : rows.at(-1)?.month ?? null
  const selectedValues = (statistics ?? []).flatMap(item => {
    const row = item.statistics.rows.find(row => row.month === effectiveSelectedMonth)
    return row ? [{ league: item.league, row }] : []
  })
  const selectedIndex = rows.findIndex(row => row.month === effectiveSelectedMonth)
  const metricDefinition = monthlyStatisticDefinition(metric)

  useEffect(() => {
    if (effectiveSelectedMonth && selectedMonth !== effectiveSelectedMonth) setSelectedMonth(effectiveSelectedMonth)
  }, [effectiveSelectedMonth, selectedMonth])

  if (bootstrap.status === 'loading') return <DataLoadState loading message="期間と条件を読み込み中…" />
  if (bootstrap.status === 'error' || !manifest || !selection) {
    return <DataLoadState message="期間と条件を読み込めませんでした。" onRetry={() => setBootstrapVersion(version => version + 1)} />
  }

  const failedLeagues = (statistics ?? []).flatMap(item => {
    const count = item.statistics.rows.filter(row => row.status === 'error').length
    return count ? [`${leagueLabel(item.league)}：${rows.length}か月中${count}か月`] : []
  })
  const incompleteLeagues = (statistics ?? []).filter(item => item.statistics.commonUnavailable).map(item => leagueLabel(item.league))
  const source = WIN_RATE_EDITION_SOURCES[edition]
  const resultsByLeague = new Map((readyResults ?? []).map(item => [item.league, new Map(item.results.map(result => [result.month, result]))]))
  const detailsRows = rows.flatMap(month => (statistics ?? []).flatMap(item => {
    const row = item.statistics.rows.find(row => row.month === month.month)
    return row ? [{ league: item.league, row }] : []
  }))
  const onFilterChange = (next: WinRateHistorySelection) => {
    const nextAvailable = WIN_RATE_EDITION_LEAGUES[editionOf(next)].filter(league =>
      manifest.datasets.some(item => editionOf(item) === editionOf(next) && item.league === league))
    const retained = selectedLeagues.filter(league => nextAvailable.includes(league))
    const nextLeagues = retained.length ? retained : [next.league]
    setLeagues(previous => previous.length === nextLeagues.length && previous.every((league, index) => league === nextLeagues[index])
      ? previous : nextLeagues)
    setSelection({ ...next, league: nextLeagues[0] })
  }

  return <section className="monthly-win-rate-statistics-page" aria-label="月別勝率統計">
    <StatisticsPanel title="条件選択" headerContent={<span className="monthly-statistics-panel-summary">
      {monthLabel(selection.fromMonth)}〜{monthLabel(selection.toMonth)}
    </span>}>
      <div className="monthly-statistics-condition-fields">
        <WinRateHistoryFilters manifest={manifest} selection={selection} onChange={onFilterChange} showLeague={false} />
        <div className="monthly-statistics-mode">
          <label><span>集計対象</span><select aria-label="集計対象" value={mode}
            onChange={event => setMode(event.target.value as MonthlyWinRateStatisticsMode)}>
            <option value="monthly">各月の掲載キャラ</option>
            <option value="common">選択期間の共通キャラ</option>
          </select></label>
          {statistics && mode === 'common' && <span className="monthly-statistics-common-count" role="status">
            各リーグ内の共通キャラ：{statistics.map(item => `${leagueLabel(item.league)} ${item.statistics.commonCharacterCount ?? '確認不可'}${item.statistics.commonCharacterCount === null ? '' : 'キャラ'}`).join('、')}
          </span>}
        </div>
      </div>
      <div className="monthly-statistics-league-selection">
        <ComparisonSelection items={availableLeagues.map(league => ({ id: league, name: leagueLabel(league) }))}
          selectedIds={selectedLeagues} onChange={next => {
            setLeagues(next)
            setSelection({ ...selection, league: next[0] })
          }} label="リーグ" selectionLabel="選択中のリーグ" pickerLabel="リーグを選択"
          legendLabel="比較するリーグ" renderKey={id => <LeagueSeriesKey league={id} />} showOptionKeys layout="grid"
          selectionCountLabel={count => `${count}リーグ選択中`} minimumSelectionLabel="1リーグ以上選択" />
      </div>
    </StatisticsPanel>

    <StatisticsPanel title="グラフ" headerContent={<label className="monthly-statistics-metric">
      <span>表示する統計量</span><select aria-label="表示する統計量" value={metric} onChange={event => {
        const next = MONTHLY_STATISTIC_METRICS.find(item => item.key === event.target.value)
        if (next) setMetric(next.key)
      }}>{MONTHLY_STATISTIC_METRICS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
    </label>}>
      {(!currentState || currentState.status === 'loading') && <DataLoadState loading message="月別の勝率を読み込み中…" />}
      {currentState?.status === 'error' && <DataLoadState message="月別の勝率を読み込めませんでした。" onRetry={() => setHistoryVersion(version => version + 1)} />}
      {statistics && <>
        {failedLeagues.length > 0 && <div className="history-load-error" role="alert">
          <span>読み込めなかったデータ：{failedLeagues.join('、')}</span>
          <button type="button" className="win-rates-button" onClick={() => setHistoryVersion(version => version + 1)}>再読み込み</button>
        </div>}
        {mode === 'common' && incompleteLeagues.length > 0 && <div className="monthly-statistics-message" role="status">
          {incompleteLeagues.join('、')}は期間内のデータが揃っていないため、共通キャラの統計を算出できません。
        </div>}
        <div className="monthly-statistics-chart-heading">
          <h3>{metricDefinition.label}の推移</h3>
          <span>{mode === 'monthly' ? '各月の掲載キャラ' : '選択期間の共通キャラ'}</span>
        </div>
        {effectiveSelectedMonth && <MonthlyWinRateStatisticsChart series={statistics} metric={metric}
          selectedMonth={effectiveSelectedMonth} onSelect={setSelectedMonth} />}
        {selectedValues.length > 0 && effectiveSelectedMonth && <>
          <div className="history-selected monthly-statistics-selected" aria-live="polite">
            <span>{monthLabel(effectiveSelectedMonth)}</span>
            <dl className="history-selected-values monthly-statistics-selected-values">{selectedValues.map(({ league, row }) => <div key={league}>
              <dt><LeagueSeriesKey league={league} />{leagueLabel(league)}・{metricDefinition.label}</dt>
              <dd><strong>{monthlyStatisticValueLabel(row, metric)}</strong>
                <span>対象 {row.validCount ?? '—'}／掲載 {row.listedCount ?? '—'} キャラ</span>
              </dd>
            </div>)}</dl>
          </div>
          <label className="history-month-slider"><span>確認する月</span>
            <input type="range" min={0} max={Math.max(0, rows.length - 1)} step={1} value={selectedIndex}
              disabled={rows.length < 2} aria-label="確認する月"
              aria-valuetext={`${monthLabel(effectiveSelectedMonth)} ${metricDefinition.label} ${selectedValues.map(({ league, row }) => `${leagueLabel(league)} ${monthlyStatisticValueLabel(row, metric)}`).join('、')}`}
              onChange={event => setSelectedMonth(rows[Number(event.target.value)].month)} />
          </label>
        </>}
      </>}
    </StatisticsPanel>

    <StatisticsPanel title="テーブル" headerContent={statistics && <span className="monthly-statistics-panel-summary">
      {statistics.length}リーグ・{rows.length}か月の数値
    </span>}>
      {statistics ? <MonthlyWinRateStatisticsTable series={statistics} selectedMonth={effectiveSelectedMonth}
        selectedMetric={metric} onSelect={setSelectedMonth} />
        : <p className="monthly-statistics-table-state" role="status">
          {currentState?.status === 'error' ? '月別の数値を読み込めませんでした。' : '月別の数値を読み込み中…'}
        </p>}
    </StatisticsPanel>

    {statistics && <>
      <details className="win-rates-details"><summary>統計量の見方</summary><div className="win-rates-details-content">
        <p>各月のキャラ別公式Totalを百分率へ換算し、1キャラを1つの値として集計しています（5.058 → 50.58%）。平均はキャラを同じ重みで平均した値で、全試合の勝率ではありません。</p>
        <p>中央値は値を並べた中央の値です。標準偏差は、各値と平均の差を二乗して対象キャラ数Nで割り、平方根を取っています。勝率の1%分の差を1ポイントとして表示します。対象が1キャラだけの場合は標準偏差を算出せず「—」と表示します。</p>
        <p>グラフは月別の値をつなぎ、数値がない月では線を切ります。平均・中央値・最小・最大には50%の参考線を表示し、標準偏差の縦軸は0ポイントから表示します。</p>
        <p>対象／掲載は集計に使ったキャラ数／その月・条件の掲載キャラ数です。欠損と公式の少数試合の印があるTotalを除外し、0.00%は有効値に含めます。</p>
        <p>各リーグの公式Totalを別々に集計し、同じ期間・操作タイプ・統計量で比較します。リーグを合算した平均や勝率は計算していません。</p>
        <p>「各月の掲載キャラ」は月ごとの有効値を集計します。「選択期間の共通キャラ」は各リーグ内で全月に有効値がある同じキャラだけを集計します。リーグ間で対象キャラが一致するとは限りません。未登録や読込失敗の月があるリーグの共通統計は算出しません。</p>
        <p>標準偏差は掲載値のばらつきを表し、勝率の確かさや有意差を表しません。使い手・対戦相手の構成やキャラの追加も数値に影響します。元の試合数、Totalの集計方法、パッチ番号、ミラー戦・引き分け・切断の扱いは未確認です。</p>
      </div></details>

      <details className="win-rates-details"><summary>除外状況・出典</summary><div className="win-rates-details-content monthly-statistics-data-details">
        <dl className="win-rates-source">
          <div><dt>対象期間</dt><dd>{monthLabel(selection.fromMonth)}〜{monthLabel(selection.toMonth)}</dd></div>
          <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
          <div><dt>一覧生成日時</dt><dd><time dateTime={manifest.generatedAt}>{timestampLabel(manifest.generatedAt)}</time></dd></div>
          <div><dt>データ形式</dt><dd>Version {manifest.schemaVersion}</dd></div>
        </dl>
        <div className="data-table-scroll monthly-statistics-exclusion-scroll" role="region" tabIndex={0} aria-label="月別の除外状況・スクロール領域">
          <table className="data-table monthly-statistics-exclusion-table">
            <caption className="win-rates-visually-hidden">月別・リーグ別の集計除外理由とデータ取得日時</caption>
            <thead><tr><th scope="col">対象月</th><th scope="col">リーグ</th><th scope="col">欠損</th><th scope="col">少数試合</th><th scope="col">共通対象外</th><th scope="col">取得日時</th><th scope="col">生成日時</th></tr></thead>
            <tbody>{detailsRows.map(({ league, row }) => {
              const result = resultsByLeague.get(league)?.get(row.month)
              const dataset = result?.status === 'ready' ? result.dataset : null
              return <tr key={`${league}:${row.month}`}>
                <th scope="row">{monthLabel(row.month)}</th>
                <th scope="row" className="monthly-statistics-league-cell"><span className="monthly-statistics-league-label"><LeagueSeriesKey league={league} />{leagueLabel(league)}</span></th>
                <td>{row.excludedMissingCount ?? '—'}</td>
                <td>{row.excludedLowSampleCount ?? '—'}</td>
                <td>{row.excludedNonCommonCount ?? '—'}</td>
                <td className="monthly-statistics-timestamp">{row.capturedAt ? <time dateTime={row.capturedAt}>{timestampLabel(row.capturedAt)}</time> : '—'}</td>
                <td className="monthly-statistics-timestamp">{dataset ? <time dateTime={dataset.generatedAt}>{timestampLabel(dataset.generatedAt)}</time> : '—'}</td>
              </tr>
            })}</tbody>
          </table>
        </div>
        <p>除外数はキャラ数です。確認できない件数は「—」と表示します。公式の「-」「-.---」は欠損として扱います。</p>
        {(() => {
          const datasets = (readyResults ?? []).flatMap(item => item.results.flatMap(result => result.status === 'ready' ? [result.dataset] : []))
          const populations = [...new Set(datasets.map(dataset => dataset.source.population))]
          const metrics = [...new Set(datasets.map(dataset => dataset.source.metric))]
          const notes = [...new Set(datasets.flatMap(dataset => dataset.source.notes))]
          return <>
            <dl><div><dt>対象</dt><dd>{populations.join('、') || '未確認'}</dd></div><div><dt>指標</dt><dd>{metrics.join('、') || '未確認'}</dd></div></dl>
            {notes.length > 0 && <ul>{notes.map(note => <li key={note}>{note}</li>)}</ul>}
          </>
        })()}
      </div></details>
    </>}
  </section>
}
