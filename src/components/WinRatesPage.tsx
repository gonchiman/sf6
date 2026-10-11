import { useEffect, useId, useMemo, useState } from 'react'
import { loadWinRateDataset, loadWinRateManifest } from '../lib/winRates'
import { createLeagueTotalWinRates } from '../lib/leagueTotalWinRates'
import { createCharacterLeagueWinRates } from '../lib/characterLeagueWinRates'
import { CHARACTER_LEAGUE_CHART_RANGES, type CharacterLeagueChartRange } from '../lib/characterLeagueChartAxis'
import { loadMonthlyStatisticsComparison } from '../lib/monthlyWinRateStatisticsComparison'
import { editionOf, leagueLabel, WIN_RATE_EDITIONS, WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_SOURCES } from '../lib/winRateConditions'
import type { LeagueTotalWinRateSelection, LeagueTotalWinRateSort } from '../types/leagueTotalWinRates'
import type { LeagueStatisticsDatasetResults } from '../types/monthlyWinRateStatisticsComparison'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateManifest, WinRateOperationMode } from '../types/winRates'
import { WinRateTable } from './WinRateTable'
import { LeagueTotalWinRateTable } from './LeagueTotalWinRateTable'
import { CharacterLeagueWinRateChart } from './CharacterLeagueWinRateChart'
import { StatisticsPanel } from './StatisticsPanel'
import { DataLoadState as LoadState } from './DataLoadState'
import '../win-rates.css'
import '../league-total-win-rates.css'

type DatasetState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; data: WinRateDataset }
  | { key: string; status: 'error'; message: string }

type ComparisonState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; results: LeagueStatisticsDatasetResults[] }
  | { key: string; status: 'error' }

const OPERATION_LABELS: Record<WinRateOperationMode, string> = {
  combined: '合算', separate: '操作タイプ別',
}

function chooseDataset(
  candidates: readonly WinRateDatasetDescriptor[],
  preferred?: Pick<WinRateDatasetDescriptor, 'league' | 'operationMode'>,
  preferOperationMode = false,
): WinRateDatasetDescriptor | undefined {
  return candidates.find(item => item.league === preferred?.league && item.operationMode === preferred?.operationMode)
    ?? (preferOperationMode ? candidates.find(item => item.operationMode === preferred?.operationMode) : undefined)
    ?? candidates.find(item => item.league === preferred?.league && item.operationMode === 'combined')
    ?? candidates.find(item => item.league === preferred?.league)
    ?? candidates.find(item => item.operationMode === preferred?.operationMode)
    ?? candidates.find(item => item.league === 'MASTER' && item.operationMode === 'combined')
    ?? candidates.find(item => item.operationMode === 'combined')
    ?? candidates[0]
}

function initialDataset(manifest: WinRateManifest): WinRateDatasetDescriptor | undefined {
  const general = manifest.datasets.filter(item => editionOf(item) === 'general')
  const latestMonth = general.map(item => item.month).sort().at(-1)
  return chooseDataset(general.filter(item => item.month === latestMonth))
}

function datasetKey(descriptor: WinRateDatasetDescriptor): string {
  return JSON.stringify([editionOf(descriptor), descriptor.id, descriptor.capturedAt])
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-')
  return `${year}年${Number(monthNumber)}月`
}

function timestampLabel(value: string): string {
  return `${new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value))} JST`
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.startsWith('選択した条件')
    ? '選択した条件とデータが一致しません。ページを再読み込みしてください。'
    : '勝率データを読み込めませんでした。'
}

export function WinRatesPage() {
  const contentId = useId()
  const [view, setView] = useState<'total' | 'matchup'>('total')
  const [hasViewedMatchup, setHasViewedMatchup] = useState(false)
  const [manifest, setManifest] = useState<WinRateManifest | null>(null)
  const [manifestLoading, setManifestLoading] = useState(true)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [manifestVersion, setManifestVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [datasetState, setDatasetState] = useState<DatasetState | null>(null)
  const [comparisonState, setComparisonState] = useState<ComparisonState | null>(null)
  const [datasetVersion, setDatasetVersion] = useState(0)
  const [sort, setSort] = useState<LeagueTotalWinRateSort>({ league: 'MASTER', direction: 'descending' })
  const [selectedCharacter, setSelectedCharacter] = useState({ characterId: 'ryu', name: 'RYU' })
  const [showChartValues, setShowChartValues] = useState(true)
  const [chartRange, setChartRange] = useState<CharacterLeagueChartRange>('0-100')

  useEffect(() => {
    let current = true
    setManifestLoading(true)
    setManifestError(null)
    void loadWinRateManifest().then(next => {
      if (!current) return
      setManifest(next)
      setSelectedId(previous => next.datasets.some(item => item.id === previous)
        ? previous : initialDataset(next)?.id ?? null)
    }).catch((error: unknown) => {
      if (current) setManifestError(errorMessage(error))
    }).finally(() => {
      if (current) setManifestLoading(false)
    })
    return () => { current = false }
  }, [manifestVersion])

  const selected = manifest?.datasets.find(item => item.id === selectedId)
  const selection = useMemo<LeagueTotalWinRateSelection | null>(() => selected ? {
    edition: editionOf(selected), month: selected.month, operationMode: selected.operationMode,
  } : null, [selected?.edition, selected?.month, selected?.operationMode])
  const comparisonKey = manifest && selection ? JSON.stringify([selection,
    manifest.datasets.filter(item => editionOf(item) === selection.edition && item.month === selection.month
      && item.operationMode === selection.operationMode).map(item => [item.id, item.league, item.path, item.capturedAt]),
  ]) : null

  useEffect(() => {
    if (!manifest || !selection || !comparisonKey) return
    let current = true
    const key = comparisonKey
    setComparisonState({ key, status: 'loading' })
    const leagues = WIN_RATE_EDITION_LEAGUES[selection.edition]
    void loadMonthlyStatisticsComparison(manifest, {
      edition: selection.edition, league: leagues[0], fromMonth: selection.month, toMonth: selection.month,
      controlType: selection.operationMode === 'combined' ? 'combined' : 'classic',
    }, leagues).then(results => {
      if (current) setComparisonState({ key, status: 'ready', results })
    }).catch(() => {
      if (current) setComparisonState({ key, status: 'error' })
    })
    return () => { current = false }
  }, [manifest, selection, comparisonKey, datasetVersion])

  useEffect(() => {
    if (!selected || !hasViewedMatchup) return
    let current = true
    const requested = selected
    const key = datasetKey(requested)
    setDatasetState({ key, status: 'loading' })
    void loadWinRateDataset(requested).then(data => {
      if (!current) return
      if (data.id !== requested.id || editionOf(data) !== editionOf(requested)) throw new Error('選択した条件とデータが一致しません。')
      setDatasetState({ key, status: 'ready', data })
    }).catch((error: unknown) => {
      if (current) setDatasetState({ key, status: 'error', message: errorMessage(error) })
    })
    return () => { current = false }
  }, [selected, hasViewedMatchup, datasetVersion])

  // Check keys while rendering, before an effect can replace the previous condition's results.
  const currentComparison = comparisonState?.key === comparisonKey ? comparisonState : null
  const readyResults = currentComparison?.status === 'ready' ? currentComparison.results : null
  const comparison = useMemo(() => manifest && selection && readyResults
    ? createLeagueTotalWinRates(manifest, selection, readyResults) : null, [manifest, selection, readyResults])
  const chartComparison = useMemo(() => comparison && selection
    ? createCharacterLeagueWinRates(comparison, selection, selectedCharacter.characterId, selectedCharacter.name)
    : null, [comparison, selection, selectedCharacter])
  const chartCharacters = useMemo(() => [...new Map(comparison?.rows.map(row =>
    [row.characterId, { characterId: row.characterId, name: row.name }]) ?? []).values()], [comparison])
  const currentDataset = selected && datasetState?.key === datasetKey(selected) ? datasetState : null
  const dataset = currentDataset?.status === 'ready' ? currentDataset.data : null

  if (manifestLoading) return <LoadState loading message="期間と条件を読み込み中…" />
  if (manifestError) return <LoadState message={manifestError} onRetry={() => setManifestVersion(version => version + 1)} />
  if (!manifest || manifest.datasets.length === 0) return <LoadState message="表示できるデータはまだ登録されていません。" />
  if (!selected || !selection) return <LoadState message="選択した条件のデータが登録されていません。" onRetry={() => setManifestVersion(version => version + 1)} />

  const edition = selection.edition
  const editions = WIN_RATE_EDITIONS.filter(value => manifest.datasets.some(item => editionOf(item) === value))
  const editionDatasets = manifest.datasets.filter(item => editionOf(item) === edition)
  const months = [...new Set(editionDatasets.map(item => item.month))].sort().reverse()
  const monthDatasets = editionDatasets.filter(item => item.month === selected.month)
  const leagues = WIN_RATE_EDITION_LEAGUES[edition].filter(league => monthDatasets.some(item => item.league === league))
  const leagueDatasets = monthDatasets.filter(item => item.league === selected.league)
  const modeDatasets = view === 'total' ? monthDatasets : leagueDatasets
  const modes = [...new Set(modeDatasets.map(item => item.operationMode))]
  const failedLeagues = comparison?.metadata.filter(item => item.status === 'error').map(item => leagueLabel(item.league)) ?? []
  const comparisonDatasets = comparison?.metadata.flatMap(item => item.result ? [item.result.dataset] : []) ?? []
  const visibleDatasets = view === 'total' ? comparisonDatasets : dataset ? [dataset] : []
  const hasVisibleData = view === 'total' ? comparison !== null : dataset !== null
  const source = WIN_RATE_EDITION_SOURCES[edition]
  const populations = [...new Set(visibleDatasets.map(item => item.source.population))]
  const metrics = [...new Set(visibleDatasets.map(item => item.source.metric))]
  const notes = [...new Set(visibleDatasets.flatMap(item => item.source.notes))]
  const retry = () => setDatasetVersion(version => version + 1)
  const chooseCharacter = (characterId: string) => {
    const character = chartCharacters.find(item => item.characterId === characterId)
    if (character) setSelectedCharacter(character)
  }

  return <section className="win-rates-page" aria-label="キャラクター別の勝率">
    <div className="win-rates-view-selector" role="group" aria-label="勝率の表示">
      {([['total', 'キャラ別'], ['matchup', 'マッチアップ']] as const).map(([value, label]) => <button
        className="win-rates-button" type="button" key={value} aria-pressed={view === value} aria-controls={`${contentId}-${value}`}
        onClick={() => { setView(value); if (value === 'matchup') setHasViewedMatchup(true) }}
      >{label}</button>)}
    </div>
    <div className="win-rates-filters">
      <label><span>統計</span><select aria-label="統計" value={edition} onChange={event => {
        const candidates = manifest.datasets.filter(item => editionOf(item) === event.target.value)
        const month = candidates.some(item => item.month === selected.month) ? selected.month : candidates.map(item => item.month).sort().at(-1)
        const next = chooseDataset(candidates.filter(item => item.month === month), { league: 'MASTER', operationMode: 'combined' })
        if (next && sort.league && !WIN_RATE_EDITION_LEAGUES[editionOf(next)].includes(sort.league)) setSort({ league: null, direction: 'descending' })
        setSelectedId(next?.id ?? null)
      }}>
        {editions.map(value => <option value={value} key={value}>{value === 'general' ? '総合版' : 'マスター版'}</option>)}
      </select></label>
      <label><span>対象月</span><select aria-label="対象月" value={selected.month} onChange={event => {
        setSelectedId(chooseDataset(editionDatasets.filter(item => item.month === event.target.value), selected, view === 'total')?.id ?? null)
      }}>{months.map(month => <option value={month} key={month}>{monthLabel(month)}</option>)}</select></label>
      {view === 'matchup' ? <label className="win-rates-league-filter"><span>リーグ</span>
        <select aria-label="リーグ" value={selected.league} onChange={event => {
          setSelectedId(chooseDataset(monthDatasets.filter(item => item.league === event.target.value), selected)?.id ?? null)
        }}>{leagues.map(league => <option value={league} key={league}>{leagueLabel(league)}</option>)}</select>
      </label> : <div className="win-rates-league-summary"><span>リーグ</span><strong>全{WIN_RATE_EDITION_LEAGUES[edition].length}リーグ</strong></div>}
      <label><span>操作タイプ</span><select aria-label="操作タイプ" value={selected.operationMode} onChange={event => {
        setSelectedId(chooseDataset(modeDatasets.filter(item => item.operationMode === event.target.value), selected)?.id ?? null)
      }}>{modes.map(mode => <option value={mode} key={mode}>{OPERATION_LABELS[mode]}</option>)}</select></label>
    </div>

    <div id={`${contentId}-total`} className="win-rates-view-panel win-rates-total-layout" hidden={view !== 'total'}>
      <StatisticsPanel title="ランク別勝率" headerContent={<div className="win-rates-chart-controls">
        <label className="win-rates-character-select"><span>キャラクター</span>
          <select aria-label="グラフのキャラクター" value={selectedCharacter.characterId} disabled={!comparison}
            onChange={event => chooseCharacter(event.target.value)}>
            {!chartCharacters.some(item => item.characterId === selectedCharacter.characterId) &&
              <option value={selectedCharacter.characterId}>{selectedCharacter.name}</option>}
            {chartCharacters.map(character => <option value={character.characterId} key={character.characterId}>{character.name}</option>)}
          </select>
        </label>
        <label className="win-rates-character-select"><span>表示範囲</span>
          <select aria-label="勝率の表示範囲" value={chartRange} onChange={event => setChartRange(event.target.value as CharacterLeagueChartRange)}>
            {CHARACTER_LEAGUE_CHART_RANGES.map(range => <option value={range.id} key={range.id}>{range.label}</option>)}
          </select>
        </label>
        <label className="win-rates-chart-value-toggle"><input type="checkbox" checked={showChartValues}
          onChange={event => setShowChartValues(event.target.checked)} />数値を表示</label>
      </div>}>
        {(!currentComparison || currentComparison.status === 'loading') && <LoadState loading message="ランク別の勝率を読み込み中…" />}
        {currentComparison?.status === 'error' && <LoadState message="勝率データを読み込めませんでした。" onRetry={retry} />}
        {chartComparison && <CharacterLeagueWinRateChart comparison={chartComparison} showValues={showChartValues} range={chartRange} />}
      </StatisticsPanel>
      <StatisticsPanel title="キャラ別勝率" headerContent={<span className="monthly-statistics-panel-summary">公式Total（%換算）</span>}>
        {(!currentComparison || currentComparison.status === 'loading') && <LoadState loading message="全リーグの勝率を読み込み中…" />}
        {currentComparison?.status === 'error' && <LoadState message="勝率データを読み込めませんでした。" onRetry={retry} />}
        {failedLeagues.length > 0 && <div className="win-rates-comparison-error" role="alert">
          <span>読み込めなかったリーグ：{failedLeagues.join('、')}</span><button type="button" className="win-rates-button" onClick={retry}>再読み込み</button>
        </div>}
        {comparison && <LeagueTotalWinRateTable comparison={comparison} separateControls={selection.operationMode === 'separate'} sort={sort} onSortChange={setSort}
          selectedCharacterId={selectedCharacter.characterId} onCharacterChange={chooseCharacter} />}
      </StatisticsPanel>
    </div>
    <div id={`${contentId}-matchup`} className="win-rates-view-panel" hidden={view !== 'matchup'}>
      {(!currentDataset || currentDataset.status === 'loading') && <LoadState loading message="勝率表を読み込み中…" />}
      {currentDataset?.status === 'error' && <LoadState message={currentDataset.message} onRetry={retry} />}
      {dataset && hasViewedMatchup && <WinRateTable key={dataset.id} dataset={dataset} />}
    </div>
    {hasVisibleData && <>
      <dl className="win-rates-source">
        <div><dt>対象期間</dt><dd>{monthLabel(selection.month)}</dd></div>
        {view === 'matchup' && dataset && <div><dt>取得日時</dt><dd><time dateTime={dataset.capturedAt}>{timestampLabel(dataset.capturedAt)}</time></dd></div>}
        <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
      </dl>
      <details className="win-rates-details"><summary>データの範囲と表記</summary><div className="win-rates-details-content">
        {edition === 'master' && <p>マスター版は操作タイプを合算した保存データを表示しています。</p>}
        <dl><div><dt>対象</dt><dd>{populations.join('、') || '未確認'}</dd></div><div><dt>指標</dt><dd>{metrics.join('、') || '未確認'}</dd></div></dl>
        {view === 'total' ? <>
          <p>各リーグの保存済み公式Totalを10倍して百分率で表示しています（5.058 → 50.58%）。</p>
          <p>ランク別勝率の表示範囲は0〜100%・40〜60%・45〜55%から選べます。操作タイプ別ではC／M共通の軸を使います。破線は50%の基準線です。表のキャラ名からもグラフのキャラを選べます。</p>
          <p>拡大表示では棒の基点が範囲の下限になり、それより下の部分を省略します。範囲外の値には端のマークと矢印付きの実際の勝率を表示します。数値表示をオフにしても範囲外の値は表示します。</p>
          <p>「未登録」はその月・条件のデータがなく、「未掲載」はそのリーグにキャラが掲載されていない状態です。「-」「-.---」は公式の欠損表記です。「読込失敗」は取得または検証に失敗した状態です。</p>
          <p>「i」は公式サイトで試合数が少ないと示されたTotalです。掲載値とともに表示しています。</p>
          <p>元の勝数・試合数、ミラー戦・引き分け・切断の扱いなど、集計方法の詳細は未確認です。</p>
          {comparison && <div className="data-table-scroll win-rates-metadata-scroll" role="region" tabIndex={0} aria-label="リーグ別の取得日時・スクロール領域">
            <table className="data-table win-rates-metadata-table"><caption className="win-rates-visually-hidden">リーグ別の取得状態・取得日時・生成日時</caption>
              <thead><tr><th scope="col">リーグ</th><th scope="col">状態</th><th scope="col">取得日時</th><th scope="col">生成日時</th></tr></thead>
              <tbody>{comparison.metadata.map(item => <tr key={item.league}>
                <th scope="row">{leagueLabel(item.league)}</th><td>{item.status === 'ready' ? '取得済み' : item.status === 'error' ? '読込失敗' : '未登録'}</td>
                <td>{item.result ? <time dateTime={item.result.dataset.capturedAt}>{timestampLabel(item.result.dataset.capturedAt)}</time> : '—'}</td>
                <td>{item.result ? <time dateTime={item.result.dataset.generatedAt}>{timestampLabel(item.result.dataset.generatedAt)}</time> : '—'}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </> : <>
          <p>マッチアップの数値は公式表の表記です。百分率への換算は行っていません。</p>
          <p>「i」は公式サイトで試合数が少ないと示された組み合わせです。</p>
          {selected.operationMode === 'separate' && <p>C：クラシック　M：モダン</p>}
        </>}
        {notes.length > 0 && <><p>保存データの注記</p><ul>{notes.map(note => <li key={note}>{note}</li>)}</ul></>}
      </div></details>
    </>}
  </section>
}
