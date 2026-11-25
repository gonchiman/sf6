import { useMemo, useState, type CSSProperties } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { STEAM_PLAYER_COUNT_PAGE_TITLE } from '../lib/navigation'
import {
  buildSteamPlayerCountHourlyComparison, filterSteamPlayerCountObservations, resolveSteamPlayerCountTimeWindow,
} from '../lib/steamPlayerCount'
import { steamPlayerCountComparisonAppIds, type SteamPlayerCountComparisonEntry, type SteamPlayerCountComparisonState } from '../lib/steamPlayerCountComparisonFeed'
import { steamPlayerCountGameLabel, steamPlayerCountGameStyle } from '../lib/steamPlayerCountGameColors'
import { DEFAULT_STEAM_PLAYER_COUNT_GAME, getSteamPlayerCountGame } from '../lib/steamPlayerCountGames'
import { useSteamPlayerCountComparison } from '../lib/useSteamPlayerCountComparison'
import type { SteamPlayerCountAppId, SteamPlayerCountDayType, SteamPlayerCountHourlyRow, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount'
import { SteamPlayerCountGamePicker } from './SteamPlayerCountGamePicker'
import { ContentTabs } from './ContentTabs'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import { SteamPlayerCountHourlyChart, SteamPlayerCountTrendChart, steamPlayerCountNumber } from './SteamPlayerCountCharts'
import { SteamPlayerCountFilters, SteamPlayerCountRangeSummary } from './SteamPlayerCountFilters'
import { SteamPlayerCountComparisonView } from './SteamPlayerCountComparisonView'
import { SteamCollectionHistoryPanel } from './SteamCollectionHistoryPanel'
import { SteamCollectionVersionHistory } from './SteamCollectionVersionHistory'
import { ElementLocationCopyButton } from './ElementLocationCopyButton'
import {
  STEAM_COMPARISON_METRICS, steamHourlyLocationSegments,
  SteamPlayerCountHourlyViewControls, type SteamHourlyView, type SteamComparisonScale, type SteamComparisonMetric,
} from './SteamPlayerCountViewControls'
import '../win-rates.css'
import '../table.css'
import '../steam-player-count.css'

const SINGLE_TABS = [['hourly', '時間帯比較'], ['trend', '観測推移'], ['history', '取得履歴']] as const
const COMPARISON_TABS = [['hourly', '時間帯比較'], ['summary', '期間比較'], ['history', '取得履歴']] as const
type SingleTab = (typeof SINGLE_TABS)[number][0]
type Tab = SingleTab | (typeof COMPARISON_TABS)[number][0]
const CONDITIONS_TITLE = '表示条件'
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
  const [hourlyView, setHourlyView] = useState<SteamHourlyView>('chart')
  const [selection, setSelection] = useState<SteamPlayerCountRangeSelection>('24h')
  const [scale, setScale] = useState<SteamComparisonScale>('people')
  const [metric, setMetric] = useState<SteamComparisonMetric>('mean')
  const state = useSteamPlayerCountComparison(appIds, selection)
  const game = appIds.length === 1 ? getSteamPlayerCountGame(appIds[0]) : null
  const entry = game ? state.entries[0] : undefined
  const publications = state.entries.map(item => {
    const lastObservedAt = item.publication.manifest.days.map(day => day.lastObservedAt).sort().at(-1)
    return { entry: item, lastObservedAt, stale: !!lastObservedAt && state.now.getTime() - Date.parse(lastObservedAt) > staleAfterMs }
  })
  const bundledLabels = publications.filter(item => item.entry.publication.source === 'bundled').map(item => steamPlayerCountGameLabel(item.entry.game.appId)).join('・')
  const staleLabels = publications.filter(item => item.stale).map(item => steamPlayerCountGameLabel(item.entry.game.appId)).join('・')
  const failedLabels = state.failedAppIds.map(steamPlayerCountGameLabel).join('・')
  const tabs = game ? SINGLE_TABS : COMPARISON_TABS
  const outputLocation = [STEAM_PLAYER_COUNT_PAGE_TITLE, tabs.find(([id]) => id === tab)?.[1] ?? tabs[0][1],
    ...(state.status === 'ready' && tab === 'hourly' ? steamHourlyLocationSegments(hourlyView, game ? undefined : scale)
      : state.status === 'ready' && tab === 'summary' ? [STEAM_COMPARISON_METRICS.find(([id]) => id === metric)![1]] : [])]

  function changeGames(next: SteamPlayerCountAppId[]) {
    setAppIds(next)
    const nextTabs = next.length === 1 ? SINGLE_TABS : COMPARISON_TABS
    setTab(current => nextTabs.some(([id]) => id === current) ? current : 'hourly')
  }

  return <section className="steam-player-count-page" aria-label={STEAM_PLAYER_COUNT_PAGE_TITLE} data-steam-app-id={game?.appId}
    style={game ? { '--steam-player-count-series': steamPlayerCountGameStyle(game.appId).color } as CSSProperties : undefined}>
    <StatisticsPanel id="steam-player-count-conditions" title={CONDITIONS_TITLE} headerContent={
      <ElementLocationCopyButton segments={[STEAM_PLAYER_COUNT_PAGE_TITLE, CONDITIONS_TITLE]} />}>
      <SteamPlayerCountFilters dayType={dayType} onDayTypeChange={setDayType} selection={selection}
        onSelectionChange={setSelection} range={state.range} now={state.now}>
        <SteamPlayerCountGamePicker appIds={appIds} onChange={changeGames} />
      </SteamPlayerCountFilters>
    </StatisticsPanel>
    <div className="steam-player-count-output-nav">
      <ContentTabs id="steam-player-count" label="表示内容" options={tabs} value={tab} onChange={setTab} className="steam-player-count-tabs" />
      <ElementLocationCopyButton segments={outputLocation} />
    </div>
    {(state.refreshError || bundledLabels || staleLabels) && <div className="steam-player-count-message" role="status">
      {state.refreshError && <span>更新確認失敗{!game && failedLabels ? `：${failedLabels}` : ''}</span>}
      {!game && state.refreshError && <span>前回確認済みデータ</span>}
      {bundledLabels && <span>同梱データ{!game ? `：${bundledLabels}` : ''}</span>}
      {staleLabels && <span>最終観測から90分以上{!game ? `：${staleLabels}` : ''}</span>}
      <button className="win-rates-button" type="button" onClick={state.refresh}>更新を確認</button>
    </div>}
    {tab === 'history' || state.status !== 'ready'
      ? tabs.filter(([id]) => id !== 'history').map(([id]) => <section key={id} className="steam-player-count-panel"
        id={`steam-player-count-panel-${id}`} role="tabpanel" aria-labelledby={`steam-player-count-tab-${id}`} hidden={tab !== id}>
        {tab === id && (state.status === 'loading'
          ? <DataLoadState loading message={`${game?.label ?? '選択したゲーム'}の観測データを読み込み中…`} />
          : <DataLoadState message={game ? `${game.label}の観測データを読み込めませんでした。` : `比較データの読込失敗${failedLabels ? `：${failedLabels}` : ''}`}
            onRetry={state.refresh} />)}
      </section>)
      : entry ? <SteamPlayerCountGameView key={entry.game.appId} entry={entry} state={state} dayType={dayType}
        tab={tab === 'summary' ? 'hourly' : tab} selection={selection} hourlyView={hourlyView} onHourlyViewChange={setHourlyView} />
        : <SteamPlayerCountComparisonView state={state} dayType={dayType} selection={selection} tab={tab === 'trend' ? 'hourly' : tab}
          scale={scale} onScaleChange={setScale} metric={metric} onMetricChange={setMetric}
          hourlyView={hourlyView} onHourlyViewChange={setHourlyView} />}
    <section className="steam-player-count-panel" id="steam-player-count-panel-history" role="tabpanel"
      aria-labelledby="steam-player-count-tab-history" hidden={tab !== 'history'}>
      {tab === 'history' && <SteamCollectionHistoryPanel state={state} selection={selection} dayType={dayType} appIds={appIds} onRefreshObservations={state.refresh} />}
    </section>
    <footer className="steam-player-count-footer">
      <SteamPlayerCountRangeSummary selection={selection} range={state.range} dataRange={state.dataRange} status={state.status}
        dataRangeLabel={game ? 'データ範囲' : '共通データ範囲'} now={state.now} />
      <div className="steam-player-count-context">
        <span>対象：Steam・世界全体・全モード</span><span>時刻：JST</span><span>取得予定：15分ごと</span>
        <span>出典：{game ? <a href={game.sourceUrl} target="_blank" rel="noreferrer">Steam<span className="win-rates-visually-hidden">（新しいタブ）</span></a> : 'Steam'}</span>
      </div>
      <SteamCollectionVersionHistory />
      <details className="steam-player-count-details">
        <summary>データ詳細</summary>
        {publications.length > 0 ? <dl className="steam-player-count-collection steam-player-count-game-updates">
          {publications.map(({ entry: item, lastObservedAt }) => <div key={item.game.appId}>
            <dt><a href={item.game.sourceUrl} target="_blank" rel="noreferrer" aria-label={`${item.game.label}の取得元（新しいタブ）`}>
              {steamPlayerCountGameLabel(item.game.appId)}</a></dt>
            <dd><span>最終観測 {lastObservedAt ? <time dateTime={lastObservedAt}>{timestampLabel(lastObservedAt)}</time> : '未取得'}</span>
              <span>公開日時 <time dateTime={item.publication.manifest.generatedAt}>{timestampLabel(item.publication.manifest.generatedAt)}</time></span></dd>
          </div>)}
        </dl> : <p className="steam-player-count-meta" role="status">{state.status === 'loading' ? '読込中' : state.status === 'error' ? '読込失敗' : '未取得'}</p>}
      </details>
    </footer>
  </section>
}

function SteamPlayerCountGameView({ entry, state, dayType, tab, selection, hourlyView, onHourlyViewChange }: {
  entry: SteamPlayerCountComparisonEntry
  state: SteamPlayerCountComparisonState
  dayType: SteamPlayerCountDayType
  tab: SingleTab
  selection: SteamPlayerCountRangeSelection
  hourlyView: SteamHourlyView
  onHourlyViewChange: (value: SteamHourlyView) => void
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
      <div className="steam-player-count-result-heading"><h2>時間帯別の平均同時接続数</h2><span className="monthly-statistics-panel-summary">{coverage}</span></div>
      <div className="steam-player-count-view-controls"><SteamPlayerCountHourlyViewControls value={hourlyView} onChange={onHourlyViewChange} /></div>
      <div hidden={hourlyView !== 'chart'}>
        {publication.manifest.days.length ? <SteamPlayerCountHourlyChart rows={hourly} /> : <div className="steam-player-count-empty" role="status">未取得</div>}
      </div>
      <div hidden={hourlyView !== 'table'}><SteamPlayerCountTable rows={hourly} /></div>
      <p className="steam-player-count-meta steam-player-count-basis">比較：1時間4区間が揃った日を等重みで集計</p>
    </section>
    <section className="steam-player-count-panel" id="steam-player-count-panel-trend" role="tabpanel"
      aria-labelledby="steam-player-count-tab-trend" hidden={tab !== 'trend'}>
      <div className="steam-player-count-result-heading"><h2>同時接続数の観測推移</h2><span className="monthly-statistics-panel-summary">{coverage}</span></div>
      <SteamPlayerCountTrendChart observations={filtered} />
      <p className="steam-player-count-meta steam-player-count-basis">観測：取得時刻の実測値・欠測は空白</p>
    </section>
  </>
}
