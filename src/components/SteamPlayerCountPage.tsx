import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { timestampLabel } from '../lib/dateTime'
import {
  buildSteamPlayerCountHourlyComparison, filterSteamPlayerCountObservations, getSteamPlayerCountComparisonRange, getSteamPlayerCountJstDate,
  parseSteamPlayerCountDate,
} from '../lib/steamPlayerCount'
import { useSteamPlayerCount } from '../lib/useSteamPlayerCount'
import { createSteamPlayerCountFeed } from '../lib/steamPlayerCountFeed'
import { DEFAULT_STEAM_PLAYER_COUNT_GAME, getSteamPlayerCountGame, STEAM_PLAYER_COUNT_GAMES } from '../lib/steamPlayerCountGames'
import type { SteamPlayerCountAppId, SteamPlayerCountDateRange, SteamPlayerCountDayType, SteamPlayerCountGame, SteamPlayerCountHourlyRow, SteamPlayerCountPeriod, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount'
import { ContentTabs } from './ContentTabs'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import { SteamPlayerCountHourlyChart, SteamPlayerCountTrendChart, steamPlayerCountNumber } from './SteamPlayerCountCharts'
import '../win-rates.css'
import '../table.css'
import '../steam-player-count.css'

const TABS = [['hourly', '時間帯比較'], ['trend', '観測推移'], ['table', '時間帯一覧']] as const
type Tab = (typeof TABS)[number][0]
const staleAfterMs = 90 * 60 * 1000
const PERIODS = [['today', '今日'], ['yesterday', '昨日'], ['7d', '直近7日'], ['30d', '直近30日'], ['all', '全期間'], ['custom', '日付指定']] as const satisfies readonly (readonly [SteamPlayerCountPeriod, string])[]
const dateLabel = (date: string) => date.replaceAll('-', '/')
const rangeLabel = ({ from, to }: SteamPlayerCountDateRange) => from === to ? dateLabel(from) : `${dateLabel(from)} 〜 ${dateLabel(to)}`

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

export function SteamPlayerCountPage({ initialAppId = DEFAULT_STEAM_PLAYER_COUNT_GAME.appId }: { initialAppId?: SteamPlayerCountAppId } = {}) {
  const [game, setGame] = useState(() => getSteamPlayerCountGame(initialAppId))
  const [dayType, setDayType] = useState<SteamPlayerCountDayType>('all')
  const [tab, setTab] = useState<Tab>('hourly')
  const [selection, setSelection] = useState<SteamPlayerCountRangeSelection>('7d')
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
  return <SteamPlayerCountGameView key={game.appId} game={game} onGameChange={changeGame} gameSelectRef={gameSelectRef}
    dayType={dayType} onDayTypeChange={setDayType} tab={tab} onTabChange={setTab} selection={selection} onSelectionChange={setSelection} />
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
  const { status, publication, range, observations, refreshError, refresh } = useSteamPlayerCount(selection, feed)
  const period = typeof selection === 'string' ? selection : 'custom'
  const now = new Date()
  const today = getSteamPlayerCountJstDate(now)
  const manifest = publication?.manifest
  const oldest = manifest?.days.map(day => getSteamPlayerCountJstDate(day.firstObservedAt)).sort()[0]
  const lastObservedAt = manifest?.days.map(day => day.lastObservedAt).sort().at(-1)
  const newest = lastObservedAt ? getSteamPlayerCountJstDate(lastObservedAt) : undefined
  const stale = lastObservedAt ? now.getTime() - Date.parse(lastObservedAt) > staleAfterMs : false
  const filtered = useMemo(() => filterSteamPlayerCountObservations(observations, range, dayType), [observations, range, dayType])
  const hourly = buildSteamPlayerCountHourlyComparison(observations, getSteamPlayerCountComparisonRange(range, manifest ?? null, now), dayType, now)
  const observedSlots = hourly.reduce((sum, row) => sum + row.observedSlots, 0)
  const expectedSlots = hourly.reduce((sum, row) => sum + row.expectedSlots, 0)
  const coverage = `観測 ${steamPlayerCountNumber(observedSlots)} / ${steamPlayerCountNumber(expectedSlots)} 区間`
  const available = !!manifest?.days.length
  const changeDate = (key: keyof SteamPlayerCountDateRange, value: string) => {
    if (!value) return
    try { parseSteamPlayerCountDate(value) } catch { return }
    const bounded = value > today ? today : value
    const next = { ...(typeof selection === 'string' ? range : selection), [key]: bounded }
    if (next.from > next.to) {
      if (key === 'from') next.to = bounded
      else next.from = bounded
    }
    onSelectionChange(next)
  }

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
      <div className="win-rates-filters steam-player-count-filters">
        <label className="steam-player-count-game-filter"><span>ゲーム</span><select aria-label="ゲーム" ref={gameSelectRef} value={game.appId}
          onChange={event => {
            const next = STEAM_PLAYER_COUNT_GAMES.find(item => String(item.appId) === event.target.value)
            if (next) onGameChange(next.appId)
          }}>
          {STEAM_PLAYER_COUNT_GAMES.map(item => <option key={item.appId} value={item.appId}>{item.label}</option>)}
        </select></label>
        <label><span>曜日</span><select aria-label="曜日" value={dayType}
          onChange={event => onDayTypeChange(event.target.value as SteamPlayerCountDayType)}>
          <option value="all">すべて</option><option value="weekday">月〜金</option><option value="weekend">土・日</option>
        </select></label>
        <div className="steam-player-count-period">
          <span className="steam-player-count-filter-label">期間</span>
          <div className="win-rates-view-selector steam-player-count-period-buttons" role="group" aria-label="期間">
            {PERIODS.map(([value, label]) => <button key={value} className="win-rates-button" type="button" aria-pressed={period === value}
              onClick={() => { if (period !== value) onSelectionChange(value === 'custom' ? { ...range } : value) }}>{label}</button>)}
          </div>
        </div>
        {typeof selection !== 'string' && <div className="steam-player-count-custom-dates">
          <label><span>開始日</span><input type="date" aria-label="開始日" value={selection.from} max={today}
            onChange={event => changeDate('from', event.target.value)} /></label>
          <label><span>終了日</span><input type="date" aria-label="終了日" value={selection.to} max={today}
            onChange={event => changeDate('to', event.target.value)} /></label>
        </div>}
        <dl className="steam-player-count-range-summary" aria-live="polite" aria-atomic="true">
          <div><dt>表示期間</dt><dd>{period === 'all' && !available ? '—' : rangeLabel(range)}</dd></div>
          <div><dt>データ範囲</dt><dd>{oldest && newest ? rangeLabel({ from: oldest, to: newest }) : manifest ? '未取得' : status === 'error' ? '読込失敗' : '読込中'}</dd></div>
        </dl>
      </div>
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
