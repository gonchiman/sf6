import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { timestampLabel } from '../lib/dateTime'
import {
  buildSteamPlayerCountHourlyComparison, filterSteamPlayerCountObservations, getSteamPlayerCountComparisonRange, getSteamPlayerCountJstDate,
  resolveSteamPlayerCountTimeWindow,
} from '../lib/steamPlayerCount'
import { useSteamPlayerCount } from '../lib/useSteamPlayerCount'
import { createSteamPlayerCountFeed } from '../lib/steamPlayerCountFeed'
import { DEFAULT_STEAM_PLAYER_COUNT_GAME, getSteamPlayerCountGame, STEAM_PLAYER_COUNT_GAMES } from '../lib/steamPlayerCountGames'
import type { SteamPlayerCountAppId, SteamPlayerCountDayType, SteamPlayerCountGame, SteamPlayerCountHourlyRow, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount'
import { ContentTabs } from './ContentTabs'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import { SteamPlayerCountHourlyChart, SteamPlayerCountTrendChart, steamPlayerCountNumber } from './SteamPlayerCountCharts'
import { SteamPlayerCountFilters } from './SteamPlayerCountFilters'
import { SteamPlayerCountComparisonView } from './SteamPlayerCountComparisonView'
import { SteamCollectionVersionHistory } from './SteamCollectionVersionHistory'
import '../win-rates.css'
import '../table.css'
import '../steam-player-count.css'

const TABS = [['hourly', '時間帯比較'], ['trend', '観測推移'], ['table', '時間帯一覧']] as const
type Tab = (typeof TABS)[number][0]
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

export function SteamPlayerCountPage({ initialAppId = DEFAULT_STEAM_PLAYER_COUNT_GAME.appId, initialMode = 'single' }: {
  initialAppId?: SteamPlayerCountAppId; initialMode?: 'single' | 'comparison'
} = {}) {
  const [mode, setMode] = useState(initialMode)
  const [comparisonAppIds, setComparisonAppIds] = useState<SteamPlayerCountAppId[]>(STEAM_PLAYER_COUNT_GAMES.map(item => item.appId))
  const [game, setGame] = useState(() => getSteamPlayerCountGame(initialAppId))
  const [dayType, setDayType] = useState<SteamPlayerCountDayType>('all')
  const [tab, setTab] = useState<Tab>('hourly')
  const [selection, setSelection] = useState<SteamPlayerCountRangeSelection>('24h')
  const gameSelectRef = useRef<HTMLSelectElement>(null)
  const restoreGameFocus = useRef(false)
  useEffect(() => {
    if (restoreGameFocus.current) gameSelectRef.current?.focus({ preventScroll: true })
    restoreGameFocus.current = false
  }, [game.appId])
  const changeGame = (appId: SteamPlayerCountAppId) => {
    if (appId === game.appId) return
    restoreGameFocus.current = true
    setGame(getSteamPlayerCountGame(appId))
  }
  // Keep the user's period across games; only the data controller is remounted
  // so the previous game's observations cannot appear under the new title.
  return <div className="steam-player-count-page">
    <div className="steam-player-count-header">
      <div className="win-rates-view-selector steam-player-count-mode" role="group" aria-label="比較対象">
        <button type="button" className="win-rates-button" aria-pressed={mode === 'single'} onClick={() => setMode('single')}>ゲーム別</button>
        <button type="button" className="win-rates-button" aria-pressed={mode === 'comparison'} onClick={() => setMode('comparison')}>ゲーム比較</button>
      </div>
      <SteamCollectionVersionHistory />
    </div>
    {mode === 'single' ? <SteamPlayerCountGameView key={game.appId} game={game} onGameChange={changeGame} gameSelectRef={gameSelectRef}
      dayType={dayType} onDayTypeChange={setDayType} tab={tab} onTabChange={setTab} selection={selection} onSelectionChange={setSelection} />
      : <SteamPlayerCountComparisonView appIds={comparisonAppIds} onAppIdsChange={setComparisonAppIds}
        dayType={dayType} onDayTypeChange={setDayType} selection={selection} onSelectionChange={setSelection} />}
  </div>
}

function SteamPlayerCountGameView({ game, onGameChange, gameSelectRef, dayType, onDayTypeChange, tab, onTabChange, selection, onSelectionChange }: {
  game: SteamPlayerCountGame
  onGameChange: (appId: SteamPlayerCountAppId) => void
  gameSelectRef: Ref<HTMLSelectElement>
  dayType: SteamPlayerCountDayType
  onDayTypeChange: (dayType: SteamPlayerCountDayType) => void
  tab: Tab
  onTabChange: (tab: Tab) => void
  selection: SteamPlayerCountRangeSelection
  onSelectionChange: (selection: SteamPlayerCountRangeSelection) => void
}) {
  const feed = useMemo(() => createSteamPlayerCountFeed({ appId: game.appId }), [game.appId])
  const { status, publication, range, observations, refreshError, refresh, now } = useSteamPlayerCount(selection, feed)
  const manifest = publication?.manifest
  const oldest = manifest?.days.map(day => getSteamPlayerCountJstDate(day.firstObservedAt)).sort()[0]
  const lastObservedAt = manifest?.days.map(day => day.lastObservedAt).sort().at(-1)
  const newest = lastObservedAt ? getSteamPlayerCountJstDate(lastObservedAt) : undefined
  const stale = lastObservedAt ? now.getTime() - Date.parse(lastObservedAt) > staleAfterMs : false
  const timeWindow = useMemo(() => resolveSteamPlayerCountTimeWindow(selection, now), [selection, now])
  const filtered = useMemo(() => filterSteamPlayerCountObservations(observations, range, dayType, timeWindow), [observations, range, dayType, timeWindow])
  const hourly = buildSteamPlayerCountHourlyComparison(observations, getSteamPlayerCountComparisonRange(range, manifest ?? null, now), dayType, now, timeWindow)
  const observedSlots = hourly.reduce((sum, row) => sum + row.observedSlots, 0)
  const expectedSlots = hourly.reduce((sum, row) => sum + row.expectedSlots, 0)
  const coverage = `観測 ${steamPlayerCountNumber(observedSlots)} / ${steamPlayerCountNumber(expectedSlots)} 区間`
  const available = !!manifest?.days.length

  return <section className="steam-player-count-page" aria-label="Steam同時接続数" data-steam-app-id={game.appId}>
    <div className="steam-player-count-context"><span>ゲーム：{game.label}</span><span>対象：Steam・世界全体・全モード</span><span>時刻：JST</span>
      <span>出典：<a href={game.sourceUrl} target="_blank" rel="noreferrer">Steam<span className="win-rates-visually-hidden">（新しいタブ）</span></a></span>
    </div>
    {manifest && <dl className="steam-player-count-collection">
      <div><dt>最終観測</dt><dd>{lastObservedAt ? <time dateTime={lastObservedAt}>{timestampLabel(lastObservedAt)}</time> : '未取得'}</dd></div>
      <div><dt>公開日時</dt><dd><time dateTime={manifest.generatedAt}>{timestampLabel(manifest.generatedAt)}</time></dd></div>
      <div><dt>取得予定</dt><dd>15分ごと</dd></div>
    </dl>}
    {(refreshError || publication?.source === 'bundled' || stale) && <div className="steam-player-count-message" role="status">
      {refreshError && <span>更新確認失敗</span>}
      {publication?.source === 'bundled' && <span>同梱データ</span>}
      {stale && <span>最終観測から90分以上</span>}
      <button className="win-rates-button" type="button" onClick={refresh}>更新を確認</button>
    </div>}
    <StatisticsPanel title="表示条件" headerContent={<span className="monthly-statistics-panel-summary">日本時間</span>}>
      <SteamPlayerCountFilters dayType={dayType} onDayTypeChange={onDayTypeChange} selection={selection}
        onSelectionChange={onSelectionChange} range={range} dataRange={oldest && newest ? { from: oldest, to: newest } : null}
        status={status} available={available} now={now}>
        <label className="steam-player-count-game-filter"><span>ゲーム</span><select aria-label="ゲーム" ref={gameSelectRef} value={game.appId}
          onChange={event => {
            const next = STEAM_PLAYER_COUNT_GAMES.find(item => String(item.appId) === event.target.value)
            if (next) onGameChange(next.appId)
          }}>
          {STEAM_PLAYER_COUNT_GAMES.map(item => <option key={item.appId} value={item.appId}>{item.label}</option>)}
        </select></label>
      </SteamPlayerCountFilters>
    </StatisticsPanel>
    {status === 'loading' ? <DataLoadState loading message={`${game.label}の観測データを読み込み中…`} />
      : status === 'error' ? <DataLoadState message={`${game.label}の観測データを読み込めませんでした。`} onRetry={refresh} />
        : <>
          <ContentTabs id="steam-player-count" label="表示内容" options={TABS} value={tab} onChange={onTabChange} className="steam-player-count-tabs" />
          <section className="steam-player-count-panel" id="steam-player-count-panel-hourly" role="tabpanel"
            aria-labelledby="steam-player-count-tab-hourly" hidden={tab !== 'hourly'}>
            <StatisticsPanel title="時間帯別の平均同時接続数" headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
              {available ? <SteamPlayerCountHourlyChart rows={hourly} /> : <div className="steam-player-count-empty" role="status">未取得</div>}
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
        </>}
  </section>
}
