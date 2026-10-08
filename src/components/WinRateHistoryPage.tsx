import { useEffect, useMemo, useState } from 'react'
import { loadWinRateDataset, loadWinRateManifest } from '../lib/winRates'
import { editionOf, WIN_RATE_EDITION_SOURCES } from '../lib/winRateConditions'
import { createWinRateHistorySeries, formatHistoryValue, historyMonths, initialHistorySelection, loadWinRateHistory, monthLabel } from '../lib/winRateHistory'
import type { HistoryDatasetResult, WinRateHistorySelection } from '../types/winRateHistory'
import type { WinRateFighter, WinRateManifest } from '../types/winRates'
import { DataLoadState } from './DataLoadState'
import { CharacterSeriesKey } from './CharacterSeriesKey'
import { HistoryCharacterSelection } from './HistoryCharacterSelection'
import { MonthlyWinRateTable } from './MonthlyWinRateTable'
import { WinRateHistoryChart } from './WinRateHistoryChart'
import { WinRateHistoryFilters } from './WinRateHistoryFilters'
import '../win-rates.css'
import '../win-rate-history.css'

type BootstrapState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; manifest: WinRateManifest; roster: WinRateFighter[] }

type HistoryState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error' }
  | { key: string; status: 'ready'; results: HistoryDatasetResult[] }

function timestampLabel(value: string): string {
  return `${new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value))} JST`
}

export function WinRateHistoryPage() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [selection, setSelection] = useState<WinRateHistorySelection | null>(null)
  const [characterIds, setCharacterIds] = useState<string[]>(['ryu'])
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [historyState, setHistoryState] = useState<HistoryState | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void loadWinRateManifest().then(async manifest => {
      const general = manifest.datasets.filter(item => editionOf(item) === 'general')
      const latestMonth = historyMonths({ ...manifest, datasets: general }).at(-1)
      const candidates = general.filter(item => item.month === latestMonth)
      const descriptor = candidates.find(item => item.league === 'MASTER' && item.operationMode === 'combined')
        ?? candidates.find(item => item.operationMode === 'combined') ?? candidates[0]
      if (!descriptor) throw new Error('No character roster is registered')
      // Roster failure must not prevent the other months or their retry controls from loading.
      const latestDataset = await loadWinRateDataset(descriptor).catch(() => null)
      if (!current) return
      setSelection(initialHistorySelection(manifest))
      if (latestDataset) setCharacterIds(previous => {
        const retained = previous.filter(id => latestDataset.fighters.some(fighter => fighter.characterId === id))
        return retained.length ? retained : [latestDataset.fighters[0].characterId]
      })
      setBootstrap({ status: 'ready', manifest, roster: latestDataset?.fighters ?? [] })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [bootstrapVersion])

  // Classic and modern use the same files. Character changes only project loaded data.
  const manifest = bootstrap.status === 'ready' ? bootstrap.manifest : null
  const edition = selection ? editionOf(selection) : 'general'
  const operationMode = selection?.controlType === 'combined' ? 'combined' : 'separate'
  const league = selection?.league
  const fromMonth = selection?.fromMonth
  const toMonth = selection?.toMonth
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

  // Hide old conditions synchronously, including the render before the effect starts.
  const currentState = historyState?.key === requestKey ? historyState : null
  const readyResults = currentState?.status === 'ready' ? currentState.results : null
  const characters = useMemo(() => {
    const byId = new Map<string, WinRateFighter>()
    if (bootstrap.status === 'ready') {
      for (const fighter of bootstrap.roster) if (!byId.has(fighter.characterId)) byId.set(fighter.characterId, fighter)
    }
    for (const result of readyResults ?? []) {
      if (result.status !== 'ready') continue
      for (const fighter of result.dataset.fighters) if (!byId.has(fighter.characterId)) byId.set(fighter.characterId, fighter)
    }
    return [...byId.values()]
  }, [bootstrap, readyResults])
  const selectedCharacters = useMemo(() => characterIds.map(characterId => ({
    characterId, name: characters.find(fighter => fighter.characterId === characterId)?.name ?? characterId.toUpperCase(),
  })), [characters, characterIds])
  const series = useMemo(() => manifest && selection && readyResults
    ? createWinRateHistorySeries(manifest, selection, selectedCharacters, readyResults) : [],
  [manifest, selection, selectedCharacters, readyResults])
  const points = series[0]?.points ?? []
  const effectiveSelectedMonth = points.some(point => point.month === selectedMonth)
    ? selectedMonth : points.at(-1)?.month ?? null
  const selectedPoint = points.find(point => point.month === effectiveSelectedMonth)
  const selectedIndex = points.findIndex(point => point.month === effectiveSelectedMonth)

  useEffect(() => {
    if (points.length && selectedMonth !== effectiveSelectedMonth) setSelectedMonth(effectiveSelectedMonth)
  }, [points, selectedMonth, effectiveSelectedMonth])

  if (bootstrap.status === 'loading') return <DataLoadState loading message="期間とキャラを読み込み中…" />
  if (bootstrap.status === 'error' || !manifest || !selection) {
    return <DataLoadState message="期間とキャラを読み込めませんでした。" onRetry={() => setBootstrapVersion(version => version + 1)} />
  }
  const failedCount = points.filter(point => point.status === 'error').length
  const source = selectedPoint?.source ?? WIN_RATE_EDITION_SOURCES[edition]
  const selectedValues = series.map(item => ({ ...item, point: item.points[selectedIndex] }))
  const selectedValueText = selectedValues.map(item => `${item.characterName} ${item.point ? formatHistoryValue(item.point) : '未登録'}`).join('、')

  return <section className="win-rate-history-page" aria-label="キャラの勝率推移">
    <WinRateHistoryFilters manifest={manifest} selection={selection} onChange={setSelection} />
    <HistoryCharacterSelection characters={characters} selectedIds={characterIds} onChange={setCharacterIds} />

    {(!currentState || currentState.status === 'loading') && <DataLoadState loading message="推移データを読み込み中…" />}
    {currentState?.status === 'error' && <DataLoadState message="推移データを読み込めませんでした。" onRetry={() => setHistoryVersion(version => version + 1)} />}
    {readyResults && effectiveSelectedMonth && selectedPoint && <>
      {failedCount > 0 && <div className="history-load-error" role="alert">
        <span>{points.length}か月中{failedCount}か月を読み込めませんでした。</span>
        <button type="button" className="win-rates-button" onClick={() => setHistoryVersion(version => version + 1)}>再読み込み</button>
      </div>}
      <div className="history-layout">
        <section className="history-graph-column" aria-label="勝率のグラフ">
          <header className="history-chart-heading"><h2>Total（%換算）</h2><span>{selection.fromMonth} – {selection.toMonth}</span></header>
          <WinRateHistoryChart series={series} selectedMonth={effectiveSelectedMonth} onSelect={setSelectedMonth} />
          <div className="history-selected" aria-live="polite"><span>{monthLabel(effectiveSelectedMonth)}</span>
            <dl className="history-selected-values">{selectedValues.map(item => <div key={item.characterId}>
              <dt><CharacterSeriesKey characterId={item.characterId} />{item.characterName}</dt>
              <dd><strong>{item.point ? formatHistoryValue(item.point) : '未登録'}</strong></dd>
            </div>)}</dl>
          </div>
          <label className="history-month-slider"><span>確認する月</span><input type="range" min={0} max={Math.max(0, points.length - 1)} step={1} value={selectedIndex}
            disabled={points.length < 2} aria-label="確認する月" aria-valuetext={`${monthLabel(effectiveSelectedMonth)} ${selectedValueText}`}
            onChange={event => setSelectedMonth(points[Number(event.target.value)].month)} /></label>
        </section>
        <section className="history-monthly-column" aria-label="月別の数値"><h2>月別の数値</h2>
          <MonthlyWinRateTable series={series} selectedMonth={effectiveSelectedMonth} onSelect={setSelectedMonth} />
        </section>
      </div>
      <dl className="win-rates-source">
        <div><dt>対象期間</dt><dd>{monthLabel(selection.fromMonth)}〜{monthLabel(selection.toMonth)}</dd></div>
        {selectedPoint.capturedAt && <div><dt>選択月の取得日時</dt><dd><time dateTime={selectedPoint.capturedAt}>{timestampLabel(selectedPoint.capturedAt)}</time></dd></div>}
        <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
      </dl>
      <details className="win-rates-details"><summary>データの範囲と表記</summary><div className="win-rates-details-content">
        {edition === 'master' && <p>マスター版は操作タイプ合算のみです。選択した期間のうち保存データがない月は「未登録」と表示します。</p>}
        {selectedPoint.source && <dl><div><dt>対象</dt><dd>{selectedPoint.source.population}</dd></div><div><dt>指標</dt><dd>{selectedPoint.source.metric}</dd></div></dl>}
        <p>月別の公式Totalを百分率へ換算しています（5.058 → 50.58%）。月同士の平均や独自の総合勝率は計算していません。</p>
        <p>未掲載はその月の表にキャラがない状態、未登録は選んだ条件の保存データがない状態です。「-」「-.---」は公式の欠損表記で、0.00%と区別します。読込失敗は再読み込みできます。</p>
        <p>色・線種・記号はキャラごとに固定です。複数キャラも同じリーグ・操作タイプ・期間で表示し、縦軸はすべての表示値に合わせて共通の範囲を使います。</p>
        <p>値がない月では、そのキャラの線を切ります。折れ線は月別の値をつなぎ、月の途中の勝率は示しません。50%の破線は比較用の基準です。</p>
        <p>元の勝数・試合数、Totalの集計方法、ミラー戦・引き分け・切断の扱い、パッチ番号は未確認です。少数試合の印や信頼区間は追加していません。</p>
        {selectedPoint.source && selectedPoint.source.notes.length > 0 && <><p>選択月の保存データの注記</p><ul>{selectedPoint.source.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></>}
      </div></details>
    </>}
  </section>
}
