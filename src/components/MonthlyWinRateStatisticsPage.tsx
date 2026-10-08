import { useEffect, useMemo, useState } from 'react'
import { createMonthlyWinRateStatistics } from '../lib/monthlyWinRateStatistics'
import { editionOf, WIN_RATE_EDITION_SOURCES } from '../lib/winRateConditions'
import { initialHistorySelection, loadWinRateHistory, monthLabel } from '../lib/winRateHistory'
import { loadWinRateManifest } from '../lib/winRates'
import type { MonthlyWinRateStatisticsMode } from '../types/monthlyWinRateStatistics'
import type { HistoryDatasetResult, WinRateHistorySelection } from '../types/winRateHistory'
import type { WinRateManifest } from '../types/winRates'
import { DataLoadState } from './DataLoadState'
import { MonthlyWinRateStatisticsTable } from './MonthlyWinRateStatisticsTable'
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
  | { key: string; status: 'ready'; results: HistoryDatasetResult[] }

function timestampLabel(value: string): string {
  return `${new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value))} JST`
}

export function MonthlyWinRateStatisticsPage() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [selection, setSelection] = useState<WinRateHistorySelection | null>(null)
  const [mode, setMode] = useState<MonthlyWinRateStatisticsMode>('monthly')
  const [historyState, setHistoryState] = useState<HistoryState | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void loadWinRateManifest().then(manifest => {
      if (!current) return
      setSelection(initialHistorySelection(manifest))
      setBootstrap({ status: 'ready', manifest })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [bootstrapVersion])

  const manifest = bootstrap.status === 'ready' ? bootstrap.manifest : null
  const edition = selection ? editionOf(selection) : 'general'
  const operationMode = selection?.controlType === 'combined' ? 'combined' : 'separate'
  const league = selection?.league
  const fromMonth = selection?.fromMonth
  const toMonth = selection?.toMonth
  // Classic and modern share files; changing the projection does not reload them.
  const query = useMemo<WinRateHistorySelection | null>(() =>
    league && fromMonth && toMonth ? {
      edition, league, fromMonth, toMonth, controlType: operationMode === 'combined' ? 'combined' : 'classic',
    } : null, [edition, league, fromMonth, toMonth, operationMode])
  const requestKey = manifest && query ? JSON.stringify([manifest.generatedAt, query]) : null

  useEffect(() => {
    if (!manifest || !query || !requestKey) return
    let current = true
    const requestedKey = requestKey
    setHistoryState({ key: requestedKey, status: 'loading' })
    void loadWinRateHistory(manifest, query).then(results => {
      if (current) setHistoryState({ key: requestedKey, status: 'ready', results })
    }).catch(() => {
      if (current) setHistoryState({ key: requestedKey, status: 'error' })
    })
    return () => { current = false }
  }, [manifest, query, requestKey, historyVersion])

  // Hide the previous condition's data before the new request's effect runs.
  const currentState = historyState?.key === requestKey ? historyState : null
  const readyResults = currentState?.status === 'ready' ? currentState.results : null
  const statistics = useMemo(() => manifest && selection && readyResults
    ? createMonthlyWinRateStatistics(manifest, selection, readyResults, mode) : null,
  [manifest, selection, readyResults, mode])

  if (bootstrap.status === 'loading') return <DataLoadState loading message="期間と条件を読み込み中…" />
  if (bootstrap.status === 'error' || !manifest || !selection) {
    return <DataLoadState message="期間と条件を読み込めませんでした。" onRetry={() => setBootstrapVersion(version => version + 1)} />
  }

  const failedCount = statistics?.rows.filter(row => row.status === 'error').length ?? 0
  const source = WIN_RATE_EDITION_SOURCES[edition]
  const resultsByMonth = new Map((readyResults ?? []).map(result => [result.month, result]))

  return <section className="monthly-win-rate-statistics-page" aria-label="月別勝率統計">
    <WinRateHistoryFilters manifest={manifest} selection={selection} onChange={setSelection} />
    <div className="monthly-statistics-mode">
      <label><span>集計対象</span><select aria-label="集計対象" value={mode}
        onChange={event => setMode(event.target.value as MonthlyWinRateStatisticsMode)}>
        <option value="monthly">各月の掲載キャラ</option>
        <option value="common">選択期間の共通キャラ</option>
      </select></label>
      {statistics && mode === 'common' && statistics.commonCharacterCount !== null &&
        <span className="monthly-statistics-common-count" role="status">共通 {statistics.commonCharacterCount} キャラ</span>}
    </div>

    {(!currentState || currentState.status === 'loading') && <DataLoadState loading message="月別の勝率を読み込み中…" />}
    {currentState?.status === 'error' && <DataLoadState message="月別の勝率を読み込めませんでした。" onRetry={() => setHistoryVersion(version => version + 1)} />}
    {statistics && <>
      {failedCount > 0 && <div className="history-load-error" role="alert">
        <span>{statistics.rows.length}か月中{failedCount}か月を読み込めませんでした。</span>
        <button type="button" className="win-rates-button" onClick={() => setHistoryVersion(version => version + 1)}>再読み込み</button>
      </div>}
      {mode === 'common' && statistics.commonUnavailable && <div className="monthly-statistics-message" role="status">
        期間内のデータが揃っていないため、共通キャラの統計を算出できません。
      </div>}
      <MonthlyWinRateStatisticsTable rows={statistics.rows} />

      <details className="win-rates-details"><summary>統計量の見方</summary><div className="win-rates-details-content">
        <p>各月のキャラ別公式Totalを百分率へ換算し、1キャラを1つの値として集計しています（5.058 → 50.58%）。平均はキャラを同じ重みで平均した値で、全試合の勝率ではありません。</p>
        <p>中央値は値を並べた中央の値です。標準偏差は、各値と平均の差を二乗して対象キャラ数Nで割り、平方根を取っています。勝率の1%分の差を1ポイントとして表示します。対象が1キャラだけの場合は標準偏差を算出せず「—」と表示します。</p>
        <p>対象／掲載は集計に使ったキャラ数／その月・条件の掲載キャラ数です。欠損と公式の少数試合の印があるTotalを除外し、0.00%は有効値に含めます。</p>
        <p>「各月の掲載キャラ」は月ごとの有効値を集計します。「選択期間の共通キャラ」は全月に有効値がある同じキャラだけを集計します。未登録や読込失敗の月がある場合、共通キャラの統計は算出しません。</p>
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
            <caption className="win-rates-visually-hidden">月別の集計除外理由とデータ取得日時</caption>
            <thead><tr><th scope="col">対象月</th><th scope="col">欠損</th><th scope="col">少数試合</th><th scope="col">共通対象外</th><th scope="col">取得日時</th><th scope="col">生成日時</th></tr></thead>
            <tbody>{statistics.rows.map(row => {
              const result = resultsByMonth.get(row.month)
              const dataset = result?.status === 'ready' ? result.dataset : null
              return <tr key={row.month}>
                <th scope="row">{monthLabel(row.month)}</th>
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
          const datasets = (readyResults ?? []).flatMap(result => result.status === 'ready' ? [result.dataset] : [])
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
