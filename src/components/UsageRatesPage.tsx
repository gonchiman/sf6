import { useEffect, useId, useMemo, useState } from 'react'
import { createLeagueUsageRates, leagueUsageRateComparisonKey, loadLeagueUsageRates, selectLeagueUsageRateConditions } from '../lib/leagueUsageRates'
import { timestampLabel } from '../lib/dateTime'
import { loadCharacterManifest } from '../lib/characters'
import { selectUsageRateHistoryConditions } from '../lib/usageRateHistory'
import {
  loadUsageRateManifest, usageRateEditionOf, usageRateMonths, USAGE_RATE_EDITIONS,
  USAGE_RATE_EDITION_LEAGUES, USAGE_RATE_EDITION_OPERATION_MODES, USAGE_RATE_EDITION_SOURCES,
} from '../lib/usageRates'
import { USAGE_RATE_CHART_RANGES, type UsageRateChartRange } from '../lib/usageRateChartAxis'
import { monthLabel } from '../lib/winRateHistory'
import type { LeagueUsageRateMetadata, LeagueUsageRateSelection, LeagueUsageRateSort } from '../types/leagueUsageRates'
import type { UsageRateEdition, UsageRateManifest, UsageRateSelection } from '../types/usageRates'
import type { CharacterManifest } from '../types/characters'
import { CharacterLeagueUsageRateChart } from './CharacterLeagueUsageRateChart'
import { LeagueUsageRateTable } from './LeagueUsageRateTable'
import { StatisticsPanel } from './StatisticsPanel'
import { DataLoadState as LoadState } from './DataLoadState'
import { usageRateLeagueLabel } from './controlTypeRatioFormatting'
import { UsageRateHistoryPeriodFilters, UsageRateHistoryView } from './UsageRateHistoryView'
import '../win-rates.css'
import '../league-total-win-rates.css'

type ComparisonState =
  | { key: string; version: number; status: 'loading' }
  | { key: string; version: number; status: 'ready'; metadata: LeagueUsageRateMetadata[] }
  | { key: string; version: number; status: 'error' }

const OPERATION_LABELS = { combined: '合算', separate: '操作タイプ別' } as const
const DISTRIBUTION_LABELS = { all: '合算', classic: 'クラシック', modern: 'モダン' } as const

export function UsageRatesPage() {
  const viewId = useId()
  const [view, setView] = useState<'rank' | 'history'>('rank')
  const [hasViewedHistory, setHasViewedHistory] = useState(false)
  const [manifest, setManifest] = useState<UsageRateManifest | null>(null)
  const [characterManifest, setCharacterManifest] = useState<CharacterManifest | null>(null)
  const [characterError, setCharacterError] = useState(false)
  const [characterVersion, setCharacterVersion] = useState(0)
  const [manifestLoading, setManifestLoading] = useState(true)
  const [manifestError, setManifestError] = useState(false)
  const [manifestVersion, setManifestVersion] = useState(0)
  const [preferredSelection, setPreferredSelection] = useState<Partial<LeagueUsageRateSelection>>({ edition: 'general', operationMode: 'combined' })
  const [historyPreferred, setHistoryPreferred] = useState<Partial<UsageRateSelection>>({ league: 'MASTER' })
  const [comparisonState, setComparisonState] = useState<ComparisonState | null>(null)
  const [datasetVersion, setDatasetVersion] = useState(0)
  const [sort, setSort] = useState<LeagueUsageRateSort>({ league: 'MASTER', direction: 'descending' })
  const [selectedCharacter, setSelectedCharacter] = useState({ characterId: 'ryu', name: 'リュウ' })
  const [showChartValues, setShowChartValues] = useState(true)
  const [chartRange, setChartRange] = useState<UsageRateChartRange>('0-20')

  useEffect(() => {
    let current = true
    setCharacterError(false)
    void loadCharacterManifest().then(next => {
      if (current) setCharacterManifest(next)
    }).catch(() => { if (current) setCharacterError(true) })
    return () => { current = false }
  }, [characterVersion])

  useEffect(() => {
    let current = true
    setManifestLoading(true)
    setManifestError(false)
    void loadUsageRateManifest().then(next => {
      if (!current) return
      setManifest(next)
    }).catch(() => {
      if (current) setManifestError(true)
    }).finally(() => {
      if (current) setManifestLoading(false)
    })
    return () => { current = false }
  }, [manifestVersion])

  const selection = useMemo(() => manifest ? selectLeagueUsageRateConditions(manifest, preferredSelection) : null,
    [manifest, preferredSelection])
  const edition = usageRateEditionOf(selection ?? {})
  const historySelection = useMemo(() => manifest ? selectUsageRateHistoryConditions(manifest, edition, historyPreferred) : null,
    [manifest, edition, historyPreferred])
  const selectedMonth = selection?.month
  const comparisonKey = manifest && selection ? leagueUsageRateComparisonKey(manifest, selection) : null

  useEffect(() => {
    if (view !== 'rank' || !manifest || !selectedMonth || !comparisonKey) return
    // Reentering an unchanged view preserves its ready table and scroll position.
    if (comparisonState?.key === comparisonKey && comparisonState.version === datasetVersion && comparisonState.status === 'ready') return
    let current = true
    const key = comparisonKey
    setComparisonState({ key, version: datasetVersion, status: 'loading' })
    void loadLeagueUsageRates(manifest, selectedMonth, edition).then(metadata => {
      if (current) setComparisonState({ key, version: datasetVersion, status: 'ready', metadata })
    }).catch(() => {
      if (current) setComparisonState({ key, version: datasetVersion, status: 'error' })
    })
    return () => { current = false }
  }, [view, manifest, selectedMonth, edition, comparisonKey, datasetVersion])

  // Check both edition and month before effects can replace the previous conditions' data.
  const currentComparison = comparisonState?.key === comparisonKey ? comparisonState : null
  const readyMetadata = currentComparison?.status === 'ready' ? currentComparison.metadata : null
  const comparison = useMemo(() => manifest && selection && readyMetadata
    ? createLeagueUsageRates(manifest, selection, readyMetadata) : null, [manifest, selection, readyMetadata])
  const chartCharacters = useMemo(() => {
    const names = new Map(characterManifest?.characters.map(item => [item.id, item.name]) ?? [])
    const characters = new Map(comparison?.rows.map(row => [row.characterId,
      { characterId: row.characterId, name: names.get(row.characterId) ?? row.name }]) ?? [])
    for (const item of characterManifest?.characters ?? []) {
      if (!characters.has(item.id)) characters.set(item.id, { characterId: item.id, name: item.name })
    }
    return [...characters.values()]
  }, [comparison, characterManifest])

  if (manifestLoading) return <LoadState loading message="期間と条件を読み込み中…" />
  if (manifestError) return <LoadState message="期間と条件を読み込めませんでした。" onRetry={() => setManifestVersion(version => version + 1)} />
  if (!manifest || manifest.datasets.length === 0) return <LoadState message="表示できるデータはまだ登録されていません。" />
  if (!selection) return <LoadState message="選択した条件のデータが登録されていません。" onRetry={() => setManifestVersion(version => version + 1)} />

  const editions = USAGE_RATE_EDITIONS.filter(value => manifest.datasets.some(item => usageRateEditionOf(item) === value))
  const months = usageRateMonths(manifest, undefined, edition).reverse()
  const leagues = USAGE_RATE_EDITION_LEAGUES[edition]
  const operationModes = USAGE_RATE_EDITION_OPERATION_MODES[edition]
  const source = edition === 'general' ? manifest.source : USAGE_RATE_EDITION_SOURCES[edition]
  const failedLeagues = comparison?.metadata.filter(item => item.status === 'error').map(item => usageRateLeagueLabel(item.league)) ?? []
  const datasets = comparison?.metadata.flatMap(item => item.dataset ? [item.dataset] : []) ?? []
  const populations = [...new Set(datasets.map(item => item.source.population))]
  const metrics = [...new Set(datasets.map(item => item.source.metric))]
  const units = [...new Set(datasets.map(item => item.source.unit))]
  const notes = [...new Set(datasets.flatMap(item => item.source.notes))]
  const totalMismatches = datasets.flatMap(dataset => dataset.distributions.flatMap(distribution =>
    distribution.totalMismatch ? [{
      key: `${dataset.id}:${distribution.controlType}`,
      label: `${usageRateLeagueLabel(dataset.league)}（${DISTRIBUTION_LABELS[distribution.controlType]}）${(distribution.totalMismatch.observedPercentThousandths / 1000).toFixed(3)}%`,
      evidence: distribution.totalMismatch,
    }] : []))
  const retry = () => setDatasetVersion(version => version + 1)
  const chooseCharacter = (characterId: string) => {
    const character = chartCharacters.find(item => item.characterId === characterId)
    if (character) setSelectedCharacter(character)
  }

  return <section className="win-rates-page usage-rates-page" aria-label="キャラクター別の使用率">
    <div className="win-rates-view-selector" role="group" aria-label="使用率の表示">
      {([['rank', 'ランク比較'], ['history', '月別推移']] as const).map(([value, label]) =>
        <button type="button" className="win-rates-button" key={value} aria-pressed={view === value}
          aria-controls={`${viewId}-${value}`} onClick={() => {
            if (value === 'history') setHasViewedHistory(true)
            setView(value)
          }}>{label}</button>)}
    </div>
    <div className="win-rates-filters">
      <label><span>統計区分</span><select aria-label="統計区分" value={edition}
        onChange={event => {
          const nextEdition = event.target.value as UsageRateEdition
          setPreferredSelection(previous => ({ ...previous, edition: nextEdition, month: selection.month }))
          if (sort.league && !USAGE_RATE_EDITION_LEAGUES[nextEdition].includes(sort.league)) {
            setSort({ league: 'MASTER', direction: 'descending' })
          }
        }}>
        {editions.map(value => <option value={value} key={value}>{value === 'general' ? '総合版' : 'マスター版'}</option>)}
      </select></label>
      {view === 'rank' && <label><span>対象月</span><select aria-label="対象月" value={selection.month}
        onChange={event => setPreferredSelection(previous => ({ ...previous, month: event.target.value }))}>
        {months.map(month => <option value={month} key={month}>{monthLabel(month)}</option>)}
      </select></label>}
      {view === 'rank' && <div className="win-rates-league-summary"><span>リーグ</span><strong>{edition === 'general' ? `全体＋${leagues.length - 1}リーグ` : `全${leagues.length}リーグ`}</strong></div>}
      <label><span>操作タイプ</span><select aria-label="操作タイプ" value={selection.operationMode}
        disabled={operationModes.length === 1}
        onChange={event => setPreferredSelection(previous => ({ ...previous, operationMode: event.target.value as LeagueUsageRateSelection['operationMode'] }))}>
        {operationModes.map(mode => <option value={mode} key={mode}>{OPERATION_LABELS[mode]}</option>)}
      </select></label>
      {view === 'history' && <UsageRateHistoryPeriodFilters manifest={manifest} edition={edition}
        selection={historySelection} onChange={setHistoryPreferred} />}
    </div>
    {characterError && <div className="win-rates-comparison-error" role="alert">
      <span>キャラクター一覧を読み込めませんでした。</span>
      <button type="button" className="win-rates-button" onClick={() => setCharacterVersion(version => version + 1)}>再読み込み</button>
    </div>}
    <div id={`${viewId}-history`} hidden={view !== 'history'}>
      {hasViewedHistory && <UsageRateHistoryView active={view === 'history'} manifest={manifest} edition={edition}
        selection={historySelection} onSelectionChange={setHistoryPreferred}
        operationMode={selection.operationMode} character={selectedCharacter} characters={chartCharacters}
        onCharacterChange={chooseCharacter} />}
    </div>
    <div id={`${viewId}-rank`} hidden={view !== 'rank'}>
    <div className="usage-rates-rank-view">
    <div className="win-rates-view-panel win-rates-total-layout">
      <StatisticsPanel title="ランク別使用率" headerContent={<div className="win-rates-chart-controls">
        <label className="win-rates-character-select"><span>キャラクター</span>
          <select aria-label="グラフのキャラクター" value={selectedCharacter.characterId} disabled={!comparison}
            onChange={event => chooseCharacter(event.target.value)}>
            {!chartCharacters.some(item => item.characterId === selectedCharacter.characterId) &&
              <option value={selectedCharacter.characterId}>{selectedCharacter.name}</option>}
            {chartCharacters.map(character => <option value={character.characterId} key={character.characterId}>{character.name}</option>)}
          </select>
        </label>
        <label className="win-rates-character-select"><span>表示範囲</span>
          <select aria-label="使用率の表示範囲" value={chartRange} onChange={event => setChartRange(event.target.value as UsageRateChartRange)}>
            {USAGE_RATE_CHART_RANGES.map(range => <option value={range.id} key={range.id}>{range.label}</option>)}
          </select>
        </label>
        <label className="win-rates-chart-value-toggle"><input type="checkbox" checked={showChartValues}
          onChange={event => setShowChartValues(event.target.checked)} />数値を表示</label>
      </div>}>
        {(!currentComparison || currentComparison.status === 'loading') && <LoadState loading message="ランク別の使用率を読み込み中…" />}
        {currentComparison?.status === 'error' && <LoadState message="使用率データを読み込めませんでした。" onRetry={retry} />}
        {comparison && <CharacterLeagueUsageRateChart comparison={comparison} characterId={selectedCharacter.characterId}
          characterName={selectedCharacter.name} operationMode={selection.operationMode} showValues={showChartValues} range={chartRange} />}
      </StatisticsPanel>
      <StatisticsPanel title="キャラ別使用率" headerContent={<span className="monthly-statistics-panel-summary">公式使用率（%）</span>}>
        {(!currentComparison || currentComparison.status === 'loading') && <LoadState loading message="全リーグの使用率を読み込み中…" />}
        {currentComparison?.status === 'error' && <LoadState message="使用率データを読み込めませんでした。" onRetry={retry} />}
        {failedLeagues.length > 0 && <div className="win-rates-comparison-error" role="alert">
          <span>読み込めなかったリーグ：{failedLeagues.join('、')}</span>
          <button type="button" className="win-rates-button" onClick={retry}>再読み込み</button>
        </div>}
        {comparison && <LeagueUsageRateTable comparison={comparison} separateControls={selection.operationMode === 'separate'}
          sort={sort} onSortChange={setSort} selectedCharacterId={selectedCharacter.characterId} onCharacterChange={chooseCharacter} />}
      </StatisticsPanel>
    </div>
    {comparison && <>
      {totalMismatches.length > 0 && <p className="win-rates-comparison-error" role="status">
        {`公開値の合計不一致：${totalMismatches.map(item => item.label).join('、')}。元の公表値を表示しています。`}
      </p>}
      <dl className="win-rates-source">
        <div><dt>対象期間</dt><dd>{monthLabel(selection.month)}</dd></div>
        <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}
          <span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
      </dl>
      <details className="win-rates-details"><summary>データの範囲と表記</summary><div className="win-rates-details-content">
        <dl><div><dt>対象</dt><dd>{populations.join('、') || '未確認'}</dd></div>
          <div><dt>指標</dt><dd>{metrics.join('、') || '未確認'}</dd></div>
          <div><dt>単位</dt><dd>{units.join('、') || '未確認'}</dd></div></dl>
        <p>公式の使用率を、小数第3位までの保存された百分率で表示しています。合計100%への再正規化は行っていません。</p>
        {edition === 'general' ? <>
          <p>合算は公式ALLの操作タイプ分布です。クラシックとモダンの平均ではありません。操作タイプ別の使用率は、それぞれの操作タイプ内でのキャラクター分布です。各キャラの使い手に占めるクラシック・モダンの割合ではありません。</p>
          <p>ALL（全体）は全リーグを対象とした公式の分布です。各リーグの割合から合算した値ではありません。</p>
        </> : <p>マスター版は公式が公開した4区分の使用率です。操作タイプ別の分布は公開されていません。</p>}
        <p>表示範囲は0〜20%・0〜10%・0〜100%から選べます。操作タイプ別ではC／M共通の軸を使います。範囲外の値には端のマークと矢印付きの実際の使用率を表示し、数値表示をオフにしても残します。表のキャラ名からもグラフのキャラを選べます。</p>
        <p>「未登録」はその月・リーグの保存データがなく、「未掲載」はその分布にキャラが掲載されていない状態です。「-」「-.---」は公式の欠損表記です。「読込失敗」は取得または検証に失敗した状態です。いずれも0%として扱いません。</p>
        {totalMismatches.length > 0 && <>
          <p>合計不一致の確認記録</p>
          <ul>{totalMismatches.map(item => <li key={item.key}>
            {item.label}：{item.evidence.reason}（確認日時：<time dateTime={item.evidence.verifiedAt}>{timestampLabel(item.evidence.verifiedAt)}</time>）。
            <a href={item.evidence.sourceUrl} target="_blank" rel="noreferrer">公式掲載ページ
              <span className="win-rates-visually-hidden">（新しいタブ）</span></a>
          </li>)}</ul>
        </>}
        <div className="data-table-scroll win-rates-metadata-scroll" role="region" tabIndex={0} aria-label="リーグ別の取得日時・スクロール領域">
          <table className="data-table win-rates-metadata-table"><caption className="win-rates-visually-hidden">リーグ別の取得状態・取得日時・生成日時</caption>
            <thead><tr><th scope="col">リーグ</th><th scope="col">状態</th><th scope="col">取得日時</th><th scope="col">生成日時</th></tr></thead>
            <tbody>{comparison.metadata.map(item => <tr key={item.league}>
              <th scope="row">{usageRateLeagueLabel(item.league)}</th>
              <td>{item.status === 'ready' ? '取得済み' : item.status === 'error' ? '読込失敗' : '未登録'}</td>
              <td>{item.dataset ? <time dateTime={item.dataset.capturedAt}>{timestampLabel(item.dataset.capturedAt)}</time> : '—'}</td>
              <td>{item.dataset ? <time dateTime={item.dataset.generatedAt}>{timestampLabel(item.dataset.generatedAt)}</time> : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {notes.length > 0 && <><p>保存データの注記</p><ul>{notes.map(note => <li key={note}>{note}</li>)}</ul></>}
      </div></details>
    </>}
    </div>
    </div>
  </section>
}
