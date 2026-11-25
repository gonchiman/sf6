import { useMemo } from 'react'
import { buildSteamPlayerCountGameComparison } from '../lib/steamPlayerCountComparison'
import { resolveSteamPlayerCountTimeWindow } from '../lib/steamPlayerCount'
import { steamPlayerCountGameLabel } from '../lib/steamPlayerCountGameColors'
import type { SteamPlayerCountComparisonState } from '../lib/steamPlayerCountComparisonFeed'
import type { SteamPlayerCountDayType, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount'
import type { SteamPlayerCountGameComparison } from '../types/steamPlayerCountComparison'
import { steamPlayerCountNumber } from './SteamPlayerCountCharts'
import { SteamPlayerCountGameHourlyChart, SteamPlayerCountGameKey, SteamPlayerCountGameSummaryChart } from './SteamPlayerCountComparisonCharts'
import {
  STEAM_COMPARISON_SCALES, STEAM_COMPARISON_METRICS, SteamPlayerCountHourlyViewControls,
  type SteamHourlyView, type SteamComparisonScale, type SteamComparisonMetric,
} from './SteamPlayerCountViewControls'

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

export function SteamPlayerCountComparisonView({ state, dayType, selection, tab, scale, onScaleChange, metric, onMetricChange,
  hourlyView, onHourlyViewChange }: {
  state: SteamPlayerCountComparisonState
  dayType: SteamPlayerCountDayType
  selection: SteamPlayerCountRangeSelection
  tab: 'hourly' | 'summary' | 'history'
  scale: SteamComparisonScale
  onScaleChange: (value: SteamComparisonScale) => void
  metric: SteamComparisonMetric
  onMetricChange: (value: SteamComparisonMetric) => void
  hourlyView: SteamHourlyView
  onHourlyViewChange: (value: SteamHourlyView) => void
}) {
  const comparison = useMemo(() => buildSteamPlayerCountGameComparison(state.entries, state.comparisonRange, dayType, state.now,
    resolveSteamPlayerCountTimeWindow(selection, state.now)), [state.entries, state.comparisonRange, state.now, dayType, selection])
  const coverage = `共通観測 ${comparison.commonDays} 日・${steamPlayerCountNumber(comparison.commonHours)} 時間（${steamPlayerCountNumber(comparison.commonSlots)} 区間）`
  const unavailable = <div className="steam-player-count-empty" role="status">算出不可</div>

  return <>
    <section className="steam-player-count-panel" id="steam-player-count-panel-hourly" role="tabpanel"
      aria-labelledby="steam-player-count-tab-hourly" hidden={tab !== 'hourly'}>
      <div className="steam-player-count-result-heading"><h2>時間帯別の平均同時接続数</h2><span className="monthly-statistics-panel-summary">{coverage}</span></div>
      <div className="steam-player-count-view-controls">
        <SteamPlayerCountHourlyViewControls value={hourlyView} onChange={onHourlyViewChange} />
        {hourlyView === 'chart' && <div className="win-rates-view-selector steam-player-count-comparison-controls" role="group" aria-label="折れ線の表示尺度">
          {STEAM_COMPARISON_SCALES.map(([id, label]) => <button key={id} type="button" className="win-rates-button"
            aria-pressed={scale === id} onClick={() => onScaleChange(id)}>{label}</button>)}
        </div>}
      </div>
      <div hidden={hourlyView !== 'chart'}>
        {comparison.commonHours > 0 ? <SteamPlayerCountGameHourlyChart series={comparison.series} scale={scale} /> : unavailable}
      </div>
      <div hidden={hourlyView !== 'table'}><SteamPlayerCountGameComparisonTable comparison={comparison} /></div>
      <p className="steam-player-count-meta steam-player-count-basis">対象：全選択ゲームで1時間4区間がそろった日時・平均：日ごとに等重み
        {hourlyView === 'chart' && scale === 'index' ? '・指数の基準：ゲーム別の期間平均＝100' : ''}</p>
    </section>
    <section className="steam-player-count-panel" id="steam-player-count-panel-summary" role="tabpanel"
      aria-labelledby="steam-player-count-tab-summary" hidden={tab !== 'summary'}>
      <div className="steam-player-count-result-heading">
        <h2>{metric === 'mean' ? '期間平均の同時接続数' : '期間内の観測最大同時接続数'}</h2>
        <span className="monthly-statistics-panel-summary">{coverage}</span>
      </div>
      <div className="steam-player-count-view-controls">
        <div className="win-rates-view-selector steam-player-count-comparison-controls" role="group" aria-label="棒グラフの集計値">
          {STEAM_COMPARISON_METRICS.map(([id, label]) => <button key={id} type="button" className="win-rates-button"
            aria-pressed={metric === id} onClick={() => onMetricChange(id)}>{label}</button>)}
        </div>
      </div>
      {comparison.commonHours > 0 ? <SteamPlayerCountGameSummaryChart series={comparison.series} metric={metric} /> : unavailable}
      <p className="steam-player-count-meta steam-player-count-basis">対象：全選択ゲームで1時間4区間がそろった日時・平均：日ごとに等重み</p>
    </section>
  </>
}
