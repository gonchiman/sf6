import { useMemo } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { buildSteamPlayerCountGameComparison } from '../lib/steamPlayerCountComparison'
import { resolveSteamPlayerCountTimeWindow } from '../lib/steamPlayerCount'
import { steamPlayerCountGameLabel } from '../lib/steamPlayerCountGameColors'
import type { SteamPlayerCountComparisonState } from '../lib/steamPlayerCountComparisonFeed'
import type { SteamPlayerCountDayType, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount'
import type { SteamPlayerCountGameComparison } from '../types/steamPlayerCountComparison'
import { StatisticsPanel } from './StatisticsPanel'
import { steamPlayerCountNumber } from './SteamPlayerCountCharts'
import { SteamPlayerCountGameHourlyChart, SteamPlayerCountGameKey, SteamPlayerCountGameSummaryChart } from './SteamPlayerCountComparisonCharts'

export function SteamPlayerCountGameComparisonTable({ comparison }: { comparison: SteamPlayerCountGameComparison }) {
  return <div className="data-table-scroll steam-player-count-table-scroll" role="region" aria-label="ゲーム別・時間帯別の集計" tabIndex={0}>
    <table className="data-table steam-player-count-table steam-player-count-comparison-table">
      <caption className="win-rates-visually-hidden">共通観測によるゲーム別の時間帯平均同時接続数と比較日数</caption>
      <thead><tr><th scope="col">時間帯（JST）</th>
        {comparison.series.map(series => <th scope="col" key={series.game.appId}>
          <span className="steam-player-count-game-key"><SteamPlayerCountGameKey appId={series.game.appId} />{steamPlayerCountGameLabel(series.game.appId)}</span>
          <span className="steam-player-count-table-unit">平均（人）</span>
        </th>)}
        <th scope="col">共通比較日数</th><th scope="col">共通観測／予定</th>
      </tr></thead>
      <tbody>{comparison.hourly.map(row => <tr key={row.hour}>
        <th scope="row">{String(row.hour).padStart(2, '0')}時台</th>
        {comparison.series.map(series => {
          const value = series.hourly.find(item => item.hour === row.hour)?.mean ?? null
          return <td key={series.game.appId} className={value === null ? 'is-unavailable' : undefined}>
            {value === null ? <><span aria-hidden="true">—</span><span className="win-rates-visually-hidden">算出不可</span></> : steamPlayerCountNumber(value)}
          </td>
        })}
        <td>{row.validDays} / {row.totalDays} 日</td>
        <td>{steamPlayerCountNumber(row.observedSlots)} / {steamPlayerCountNumber(row.expectedSlots)} 区間</td>
      </tr>)}</tbody>
    </table>
  </div>
}

export function SteamPlayerCountComparisonView({ state, dayType, selection, tab, scale, onScaleChange, metric, onMetricChange }: {
  state: SteamPlayerCountComparisonState
  dayType: SteamPlayerCountDayType
  selection: SteamPlayerCountRangeSelection
  tab: 'hourly' | 'summary' | 'table'
  scale: 'people' | 'index'
  onScaleChange: (value: 'people' | 'index') => void
  metric: 'mean' | 'peak'
  onMetricChange: (value: 'mean' | 'peak') => void
}) {
  const comparison = useMemo(() => buildSteamPlayerCountGameComparison(state.entries, state.comparisonRange, dayType, state.now,
    resolveSteamPlayerCountTimeWindow(selection, state.now)), [state.entries, state.comparisonRange, state.now, dayType, selection])
  const coverage = `共通観測 ${comparison.commonDays} 日・${steamPlayerCountNumber(comparison.commonHours)} 時間（${steamPlayerCountNumber(comparison.commonSlots)} 区間）`
  const unavailable = <div className="steam-player-count-empty" role="status">算出不可</div>

  return <>
    <section className="steam-player-count-panel" id="steam-player-count-panel-hourly" role="tabpanel"
      aria-labelledby="steam-player-count-tab-hourly" hidden={tab !== 'hourly'}>
      <StatisticsPanel title="時間帯別の平均同時接続数" headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
        <div className="win-rates-view-selector steam-player-count-comparison-controls" role="group" aria-label="折れ線の表示尺度">
          <button type="button" className="win-rates-button" aria-pressed={scale === 'people'} onClick={() => onScaleChange('people')}>人数</button>
          <button type="button" className="win-rates-button" aria-pressed={scale === 'index'} onClick={() => onScaleChange('index')}>各ゲーム平均＝100</button>
        </div>
        {comparison.commonHours > 0 ? <SteamPlayerCountGameHourlyChart series={comparison.series} scale={scale} /> : unavailable}
      </StatisticsPanel>
    </section>
    <section className="steam-player-count-panel" id="steam-player-count-panel-summary" role="tabpanel"
      aria-labelledby="steam-player-count-tab-summary" hidden={tab !== 'summary'}>
      <StatisticsPanel title={metric === 'mean' ? '期間平均の同時接続数' : '期間内の観測最大同時接続数'}
        headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
        <div className="win-rates-view-selector steam-player-count-comparison-controls" role="group" aria-label="棒グラフの集計値">
          <button type="button" className="win-rates-button" aria-pressed={metric === 'mean'} onClick={() => onMetricChange('mean')}>期間平均</button>
          <button type="button" className="win-rates-button" aria-pressed={metric === 'peak'} onClick={() => onMetricChange('peak')}>観測最大</button>
        </div>
        {comparison.commonHours > 0 ? <SteamPlayerCountGameSummaryChart series={comparison.series} metric={metric} /> : unavailable}
      </StatisticsPanel>
    </section>
    <section className="steam-player-count-panel" id="steam-player-count-panel-table" role="tabpanel"
      aria-labelledby="steam-player-count-tab-table" hidden={tab !== 'table'}>
      <StatisticsPanel title="時間帯別の集計" headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
        <SteamPlayerCountGameComparisonTable comparison={comparison} />
      </StatisticsPanel>
    </section>
    <p className="steam-player-count-meta steam-player-count-basis">対象：全選択ゲームで1時間4区間がそろった日時・平均：日ごとに等重み
      {tab === 'hourly' && scale === 'index' ? '・指数の基準：ゲーム別の期間平均＝100' : ''}</p>
    {state.entries.length > 0 && <dl className="steam-player-count-collection steam-player-count-game-updates">
      {state.entries.map(entry => {
        const latest = entry.publication.manifest.days.map(day => day.lastObservedAt).sort().at(-1)
        return <div key={entry.game.appId}><dt><a href={entry.game.sourceUrl} target="_blank" rel="noreferrer"
          aria-label={`${entry.game.label}の取得元（新しいタブ）`}>{steamPlayerCountGameLabel(entry.game.appId)}</a></dt>
          <dd>{latest ? <>最終観測 <time dateTime={latest}>{timestampLabel(latest)}</time></> : '未取得'}
            {entry.publication.source === 'bundled' ? '・同梱データ' : ''}
            {latest && state.now.getTime() - Date.parse(latest) > 90 * 60 * 1000 ? '・90分以上更新なし' : ''}</dd></div>
      })}
    </dl>}
  </>
}
