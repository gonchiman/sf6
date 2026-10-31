import { useMemo, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import {
  buildSteamPlayerCountHourlyComparison, filterSteamPlayerCountObservations, getSteamPlayerCountJstDate,
} from '../lib/steamPlayerCount'
import { useSteamPlayerCount } from '../lib/useSteamPlayerCount'
import type { SteamPlayerCountDateRange, SteamPlayerCountDayType, SteamPlayerCountHourlyRow } from '../types/steamPlayerCount'
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

export function SteamPlayerCountPage() {
  const [requestedRange, setRequestedRange] = useState<SteamPlayerCountDateRange | null>(null)
  const [dayType, setDayType] = useState<SteamPlayerCountDayType>('all')
  const [tab, setTab] = useState<Tab>('hourly')
  const { status, publication, range, observations, refreshError, refresh } = useSteamPlayerCount(requestedRange)
  const now = new Date()
  const today = getSteamPlayerCountJstDate(now)
  const manifest = publication?.manifest
  const oldest = manifest?.days.map(day => getSteamPlayerCountJstDate(day.firstObservedAt)).sort()[0]
  const lastObservedAt = manifest?.days.map(day => day.lastObservedAt).sort().at(-1)
  const stale = lastObservedAt ? now.getTime() - Date.parse(lastObservedAt) > staleAfterMs : false
  const filtered = useMemo(() => filterSteamPlayerCountObservations(observations, range, dayType), [observations, range, dayType])
  const hourly = buildSteamPlayerCountHourlyComparison(observations, range, dayType, now)
  const observedSlots = hourly.reduce((sum, row) => sum + row.observedSlots, 0)
  const expectedSlots = hourly.reduce((sum, row) => sum + row.expectedSlots, 0)
  const coverage = `観測 ${steamPlayerCountNumber(observedSlots)} / ${steamPlayerCountNumber(expectedSlots)} 区間`
  const available = !!manifest?.days.length
  const changeDate = (key: keyof SteamPlayerCountDateRange, value: string) => {
    if (!value) return
    const bounded = value > today ? today : oldest && value < oldest ? oldest : value
    const next = { ...range, [key]: bounded }
    if (next.from > next.to) {
      if (key === 'from') next.to = bounded
      else next.from = bounded
    }
    setRequestedRange(next)
  }

  return <section className="steam-player-count-page" aria-label="Steam同時接続数">
    <div className="steam-player-count-context"><span>対象：Steam・世界全体・全モード</span><span>時刻：JST</span>
      {manifest && <span>出典：<a href={manifest.sourceUrl} target="_blank" rel="noreferrer">Steam<span className="win-rates-visually-hidden">（新しいタブ）</span></a></span>}
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
        <label><span>開始日</span><input type="date" aria-label="開始日" value={range.from} min={oldest} max={today}
          disabled={!available} onChange={event => changeDate('from', event.target.value)} /></label>
        <label><span>終了日</span><input type="date" aria-label="終了日" value={range.to} min={oldest} max={today}
          disabled={!available} onChange={event => changeDate('to', event.target.value)} /></label>
        <label><span>曜日</span><select aria-label="曜日" value={dayType} disabled={!available}
          onChange={event => setDayType(event.target.value as SteamPlayerCountDayType)}>
          <option value="all">すべて</option><option value="weekday">月〜金</option><option value="weekend">土・日</option>
        </select></label>
      </div>
    </StatisticsPanel>
    {status === 'loading' ? <DataLoadState loading message="Steamの観測データを読み込み中…" />
      : status === 'error' ? <DataLoadState message="Steamの観測データを読み込めませんでした。" onRetry={refresh} />
        : <>
          <ContentTabs id="steam-player-count" label="表示内容" options={TABS} value={tab} onChange={setTab} className="steam-player-count-tabs" />
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
