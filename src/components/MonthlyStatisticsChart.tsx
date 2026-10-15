import { useMemo } from 'react'
import {
  formatMonthlyStatisticTick, monthlyLeagueStatisticSeries, monthlyStatisticDefinition, monthlyStatisticValueLabel,
} from '../lib/monthlyWinRateStatisticsChart'
import type { MonthlyStatisticsMetric, MonthlyStatisticsSeries } from '../types/monthlyStatisticsPresentation'
import { MonthlyLineChart } from './MonthlyLineChart'
import { LeagueSeriesKey } from './LeagueSeriesKey'
import '../win-rate-history-chart.css'

type Props = {
  series: readonly MonthlyStatisticsSeries[]
  metric: MonthlyStatisticsMetric
  selectedMonth: string
  onSelect: (month: string) => void
  axis: { start: number; end: number; step: number; ticks: readonly number[] }
  description: string
  reference?: { value: number; label: string }
}

export function MonthlyStatisticsChart({ series, metric, selectedMonth, onSelect, axis, description, reference }: Props) {
  const definition = monthlyStatisticDefinition(metric)
  const chartSeries = useMemo(() => monthlyLeagueStatisticSeries(series, metric), [series, metric])
  const rowsByLeague = useMemo(() => new Map(series.map(item => [
    item.league, new Map(item.statistics.rows.map(row => [row.month, row])),
  ])), [series])
  const legend = <ul className="history-series-legend" aria-label="グラフのリーグ">
    {chartSeries.map(item => <li key={item.id}><LeagueSeriesKey league={item.id} /><span>{item.label}</span></li>)}
  </ul>

  return <MonthlyLineChart series={chartSeries} selectedMonth={selectedMonth} onSelect={onSelect}
    title={`${chartSeries.map(item => item.label).join('・')}の${definition.label}の月別推移`}
    description={description}
    regionLabel={`${definition.label}の推移グラフ`} axisLabel={`${definition.label}（${definition.unit}）`}
    axis={axis} formatTick={tick => formatMonthlyStatisticTick(tick, axis.step)} reference={reference}
    valueLabel={(seriesId, month) => {
      const row = rowsByLeague.get(seriesId)?.get(month)
      return row ? monthlyStatisticValueLabel(row, metric) : '未登録'
    }} legend={legend} />
}
