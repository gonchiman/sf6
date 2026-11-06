import { useMemo, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import {
  buildSteamPlayerCountHourlyComparison, filterSteamPlayerCountObservations, resolveSteamPlayerCountTimeWindow,
} from '../lib/steamPlayerCount'
import { steamPlayerCountComparisonAppIds, type SteamPlayerCountComparisonEntry, type SteamPlayerCountComparisonState } from '../lib/steamPlayerCountComparisonFeed'
import { steamPlayerCountGameLabel } from '../lib/steamPlayerCountGameColors'
import { DEFAULT_STEAM_PLAYER_COUNT_GAME, getSteamPlayerCountGame, STEAM_PLAYER_COUNT_GAMES } from '../lib/steamPlayerCountGames'
import { useSteamPlayerCountComparison } from '../lib/useSteamPlayerCountComparison'
import type { SteamPlayerCountAppId, SteamPlayerCountDayType, SteamPlayerCountHourlyRow, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount'
import { ComparisonSelection } from './ComparisonSelection'
import { ContentTabs } from './ContentTabs'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import { SteamPlayerCountHourlyChart, SteamPlayerCountTrendChart, steamPlayerCountNumber } from './SteamPlayerCountCharts'
import { SteamPlayerCountFilters, SteamPlayerCountRangeSummary } from './SteamPlayerCountFilters'
import { SteamPlayerCountComparisonView } from './SteamPlayerCountComparisonView'
import { SteamPlayerCountGameKey } from './SteamPlayerCountComparisonCharts'
import { SteamCollectionHistoryPanel } from './SteamCollectionHistoryPanel'
import { SteamCollectionVersionHistory } from './SteamCollectionVersionHistory'
import '../win-rates.css'
import '../table.css'
import '../steam-player-count.css'

const SINGLE_TABS = [['hourly', '時間帯比較'], ['trend', '観測推移'], ['table', '時間帯一覧'], ['history', '取得履歴']] as const
const COMPARISON_TABS = [['hourly', '時間帯比較'], ['summary', '期間比較'], ['table', '時間帯一覧'], ['history', '取得履歴']] as const
type SingleTab = Exclude<(typeof SINGLE_TABS)[number][0], 'history'>
type Tab = SingleTab | (typeof COMPARISON_TABS)[number][0]
const GAME_OPTIONS = STEAM_PLAYER_COUNT_GAMES.map(game => ({ id: String(game.appId), name: steamPlayerCountGameLabel(game.appId) }))
const staleAfterMs = 90 * 60 * 1000

function SteamPlayerCountTable({ rows }: { rows: readonly SteamPlayerCountHourlyRow[] }) {
  return <div className="data-table-scroll steam-player-count-table-scroll" role="region" aria-label="時間帯別の集計" tabIndex={0}>
    <table className="data-table steam-player-count-table">
      <caption className="win-rates-visually-hidden">時間帯別の平均同時接続数、比較日数と観測区間</caption>
      <thead><tr><th scope="col">時間帯（JST）</th><th scope="col">平均（人）</th><th scope="col">比較日数</th><th scope="col">観測区間／予定</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.hour}>
        <th scope="row">{String(row.hour).padStart(2, '0')}:00〜{String(row.hour).padStart(2, '0')}:59</th>
        <td className={row.mean === null ? 'is-unavailable' : undefined}>
          {row.mean === null ? <><span aria-hidden="true">—</span><span className="win-rates-visually-hidden">算出不可</span></> : steamPlayerCountNumber(row.mean)}
        </td>
        <td>{row.validDays} / {row.totalDays} 日</td><td>{steamPlayerCountNumber(row.observedSlots)} / {steamPlayerCountNumber(row.expectedSlots)}</td>
      </tr>)}</tbody>
    </table>
  </div>
}

export function SteamPlayerCountPage({ initialAppIds = [DEFAULT_STEAM_PLAYER_COUNT_GAME.appId] }: {
  initialAppIds?: readonly SteamPlayerCountAppId[]
} = {}) {
  const [appIds, setAppIds] = useState(() => steamPlayerCountComparisonAppIds(initialAppIds))
  const [dayType, setDayType] = useState<SteamPlayerCountDayType>('all')
  const [tab, setTab] = useState<Tab>('hourly')
  const [selection, setSelection] = useState<SteamPlayerCountRangeSelection>('24h')
  const [scale, setScale] = useState<'people' | 'index'>('people')
  const [metric, setMetric] = useState<'mean' | 'peak'>('mean')
  const state = useSteamPlayerCountComparison(appIds, selection)
  const game = appIds.length === 1 ? getSteamPlayerCountGame(appIds[0]) : null
  const entry = game ? state.entries[0] : undefined
  const manifest = entry?.publication.manifest
  const lastObservedAt = manifest?.days.map(day => day.lastObservedAt).sort().at(-1)
  const stale = lastObservedAt ? state.now.getTime() - Date.parse(lastObservedAt) > staleAfterMs : false
  const bundled = entry?.publication.source === 'bundled'
  const failedLabels = state.failedAppIds.map(steamPlayerCountGameLabel).join('・')
  const tabs = game ? SINGLE_TABS : COMPARISON_TABS

  function changeGames(ids: string[]) {
    const next = STEAM_PLAYER_COUNT_GAMES.filter(game => ids.includes(String(game.appId))).map(game => game.appId)
    if (!next.length) return
    setAppIds(next)
    const nextTabs = next.length === 1 ? SINGLE_TABS : COMPARISON_TABS
    setTab(current => nextTabs.some(([id]) => id === current) ? current : 'hourly')
  }

  return <section className="steam-player-count-page" aria-label="Steam同時接続数" data-steam-app-id={game?.appId}>
    <div className="steam-player-count-header">
      <SteamCollectionVersionHistory />
    </div>
    <div className="steam-player-count-context">
      {game && <span>ゲーム：{game.label}</span>}
      <span>対象：Steam・世界全体・全モード</span><span>時刻：JST</span>
      {game ? <span>出典：<a href={game.sourceUrl} target="_blank" rel="noreferrer">Steam<span className="win-rates-visually-hidden">（新しいタブ）</span></a></span>
        : <span>取得予定：15分ごと</span>}
    </div>
    {manifest && <dl className="steam-player-count-collection">
      <div><dt>最終観測</dt><dd>{lastObservedAt ? <time dateTime={lastObservedAt}>{timestampLabel(lastObservedAt)}</time> : '未取得'}</dd></div>
      <div><dt>公開日時</dt><dd><time dateTime={manifest.generatedAt}>{timestampLabel(manifest.generatedAt)}</time></dd></div>
      <div><dt>取得予定</dt><dd>15分ごと</dd></div>
    </dl>}
    {(state.refreshError || bundled || stale) && <div className="steam-player-count-message" role="status">
      {state.refreshError && <span>更新確認失敗{!game && failedLabels ? `：${failedLabels}` : ''}</span>}
      {!game && state.refreshError && <span>前回確認済みデータ</span>}
      {bundled && <span>同梱データ</span>}
      {stale && <span>最終観測から90分以上</span>}
      <button className="win-rates-button" type="button" onClick={state.refresh}>更新を確認</button>
    </div>}
    <StatisticsPanel id="steam-player-count-conditions" title="表示条件" headerContent={<span className="monthly-statistics-panel-summary">日本時間</span>}>
      <ComparisonSelection items={GAME_OPTIONS} selectedIds={appIds.map(String)} onChange={changeGames}
        label="ゲーム" selectionLabel="選択中のゲーム" pickerLabel="ゲームを選択" legendLabel="ゲーム"
        renderKey={id => <SteamPlayerCountGameKey appId={Number(id) as SteamPlayerCountAppId} />}
        layout="grid" showOptionKeys minimumSelectionLabel={null} selectionCountLabel={count => `${count}作品`}
        gridActions={<div className="steam-player-count-game-actions" role="group" aria-label="ゲーム選択の操作">
          <button type="button" className="win-rates-button" disabled={game?.appId === DEFAULT_STEAM_PLAYER_COUNT_GAME.appId}
            onClick={() => changeGames([String(DEFAULT_STEAM_PLAYER_COUNT_GAME.appId)])}>リセット</button>
          <button type="button" className="win-rates-button" disabled={appIds.length === GAME_OPTIONS.length}
            onClick={() => changeGames(GAME_OPTIONS.map(option => option.id))}>全選択</button>
        </div>} />
      <SteamPlayerCountFilters dayType={dayType} onDayTypeChange={setDayType} selection={selection}
        onSelectionChange={setSelection} range={state.range} now={state.now} />
    </StatisticsPanel>
    <ContentTabs id="steam-player-count" label="表示内容" options={tabs} value={tab} onChange={setTab} className="steam-player-count-tabs" />
    {tab === 'history' || state.status !== 'ready'
      ? tabs.filter(([id]) => id !== 'history').map(([id]) => <section key={id} className="steam-player-count-panel"
        id={`steam-player-count-panel-${id}`} role="tabpanel" aria-labelledby={`steam-player-count-tab-${id}`} hidden={tab !== id}>
        {tab === id && (state.status === 'loading'
          ? <DataLoadState loading message={`${game?.label ?? '選択したゲーム'}の観測データを読み込み中…`} />
          : <DataLoadState message={game ? `${game.label}の観測データを読み込めませんでした。` : `比較データの読込失敗${failedLabels ? `：${failedLabels}` : ''}`}
            onRetry={state.refresh} />)}
      </section>)
      : entry ? <SteamPlayerCountGameView key={entry.game.appId} entry={entry} state={state} dayType={dayType}
        tab={tab === 'summary' ? 'hourly' : tab} selection={selection} />
        : <SteamPlayerCountComparisonView state={state} dayType={dayType} selection={selection} tab={tab === 'trend' ? 'hourly' : tab}
          scale={scale} onScaleChange={setScale} metric={metric} onMetricChange={setMetric} />}
    <section className="steam-player-count-panel" id="steam-player-count-panel-history" role="tabpanel"
      aria-labelledby="steam-player-count-tab-history" hidden={tab !== 'history'}>
      {tab === 'history' && <SteamCollectionHistoryPanel state={state} selection={selection} dayType={dayType} appIds={appIds} onRefreshObservations={state.refresh} />}
    </section>
    <SteamPlayerCountRangeSummary selection={selection} range={state.range} dataRange={state.dataRange} status={state.status}
      dataRangeLabel={game ? 'データ範囲' : '共通データ範囲'} now={state.now} />
  </section>
}

function SteamPlayerCountGameView({ entry, state, dayType, tab, selection }: {
  entry: SteamPlayerCountComparisonEntry
  state: SteamPlayerCountComparisonState
  dayType: SteamPlayerCountDayType
  tab: SingleTab
  selection: SteamPlayerCountRangeSelection
}) {
  const { range, comparisonRange, now } = state
  const { observations, publication } = entry
  const timeWindow = useMemo(() => resolveSteamPlayerCountTimeWindow(selection, now), [selection, now])
  const filtered = useMemo(() => filterSteamPlayerCountObservations(observations, range, dayType, timeWindow), [observations, range, dayType, timeWindow])
  const hourly = buildSteamPlayerCountHourlyComparison(observations, comparisonRange, dayType, now, timeWindow)
  const observedSlots = hourly.reduce((sum, row) => sum + row.observedSlots, 0)
  const expectedSlots = hourly.reduce((sum, row) => sum + row.expectedSlots, 0)
  const coverage = `観測 ${steamPlayerCountNumber(observedSlots)} / ${steamPlayerCountNumber(expectedSlots)} 区間`

  return <>
    <section className="steam-player-count-panel" id="steam-player-count-panel-hourly" role="tabpanel"
      aria-labelledby="steam-player-count-tab-hourly" hidden={tab !== 'hourly'}>
      <StatisticsPanel title="時間帯別の平均同時接続数" headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
        {publication.manifest.days.length ? <SteamPlayerCountHourlyChart rows={hourly} /> : <div className="steam-player-count-empty" role="status">未取得</div>}
      </StatisticsPanel>
    </section>
    <section className="steam-player-count-panel" id="steam-player-count-panel-trend" role="tabpanel"
      aria-labelledby="steam-player-count-tab-trend" hidden={tab !== 'trend'}>
      <StatisticsPanel title="同時接続数の観測推移" headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
        <SteamPlayerCountTrendChart observations={filtered} />
      </StatisticsPanel>
    </section>
    <section className="steam-player-count-panel" id="steam-player-count-panel-table" role="tabpanel"
      aria-labelledby="steam-player-count-tab-table" hidden={tab !== 'table'}>
      <StatisticsPanel title="時間帯別の集計" headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
        <SteamPlayerCountTable rows={hourly} />
      </StatisticsPanel>
    </section>
    <p className="steam-player-count-meta steam-player-count-basis">{tab === 'trend'
      ? '観測：取得時刻の実測値・欠測は空白' : '比較：1時間4区間が揃った日を等重みで集計'}</p>
  </>
}
