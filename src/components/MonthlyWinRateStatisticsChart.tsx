import { useMemo } from 'react'
import {
  formatMonthlyStatisticTick, monthlyLeagueStatisticAxis, monthlyLeagueStatisticSeries,
  monthlyStatisticDefinition, monthlyStatisticReference, monthlyStatisticValueLabel,
} from '../lib/monthlyWinRateStatisticsChart'
import type { MonthlyWinRateStatisticMetric } from '../types/monthlyWinRateStatistics'
import type { LeagueStatisticsSeries } from '../types/monthlyWinRateStatisticsComparison'
import { MonthlyLineChart } from './MonthlyLineChart'
import { LeagueSeriesKey } from './LeagueSeriesKey'
import '../win-rate-history-chart.css'

type Props = {
  series: readonly LeagueStatisticsSeries[]
  metric: MonthlyWinRateStatisticMetric
  selectedMonth: string
  onSelect: (month: string) => void
}

export function MonthlyWinRateStatisticsChart({ series, metric, selectedMonth, onSelect }: Props) {
  const definition = monthlyStatisticDefinition(metric)
  const chartSeries = useMemo(() => monthlyLeagueStatisticSeries(series, metric), [series, metric])
  const axis = useMemo(() => monthlyLeagueStatisticAxis(series, metric), [series, metric])
  const rowsByLeague = useMemo(() => new Map(series.map(item => [
    item.league, new Map(item.statistics.rows.map(row => [row.month, row])),
  ])), [series])
  const reference = monthlyStatisticReference(metric)
  const legend = <ul className="history-series-legend" aria-label="グラフのリーグ">
    {chartSeries.map(item => <li key={item.id}><LeagueSeriesKey league={item.id} /><span>{item.label}</span></li>)}
  </ul>

  return <MonthlyLineChart series={chartSeries} selectedMonth={selectedMonth} onSelect={onSelect}
    title={`${chartSeries.map(item => item.label).join('・')}の${definition.label}の月別推移`}
    description={`リーグごとにキャラ別公式Totalを百分率に換算した値から求めた${definition.label}の推移。全リーグを同じ縦軸で表示します。${reference ? '破線は比較の基準となる50%。' : '縦軸の単位はポイント。'}数値がない月はそのリーグの線をつなぎません。`}
    regionLabel={`${definition.label}の推移グラフ`} axisLabel={`${definition.label}（${definition.unit}）`}
    axis={axis} formatTick={tick => formatMonthlyStatisticTick(tick, axis.step)} reference={reference}
    valueLabel={(seriesId, month) => {
      const row = rowsByLeague.get(seriesId)?.get(month)
      return row ? monthlyStatisticValueLabel(row, metric) : '未登録'
    }} legend={legend} />
}
