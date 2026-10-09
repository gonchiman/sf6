import { useMemo } from 'react'
import {
  formatMonthlyStatisticTick, monthlyStatisticAxis, monthlyStatisticDefinition,
  monthlyStatisticPoints, monthlyStatisticReference, monthlyStatisticValueLabel,
} from '../lib/monthlyWinRateStatisticsChart'
import type { MonthlyLineChartSeries } from '../types/monthlyLineChart'
import type { MonthlyWinRateStatisticMetric, MonthlyWinRateStatisticsRow } from '../types/monthlyWinRateStatistics'
import { MonthlyLineChart } from './MonthlyLineChart'

type Props = {
  rows: readonly MonthlyWinRateStatisticsRow[]
  metric: MonthlyWinRateStatisticMetric
  selectedMonth: string
  onSelect: (month: string) => void
}

export function MonthlyWinRateStatisticsChart({ rows, metric, selectedMonth, onSelect }: Props) {
  const definition = monthlyStatisticDefinition(metric)
  const points = useMemo(() => monthlyStatisticPoints(rows, metric), [rows, metric])
  const axis = useMemo(() => monthlyStatisticAxis(rows, metric), [rows, metric])
  const rowsByMonth = useMemo(() => new Map(rows.map(row => [row.month, row])), [rows])
  const series = useMemo<MonthlyLineChartSeries[]>(() => [{
    id: metric, label: definition.label, points, style: { color: 'var(--link)', marker: 'circle' },
  }], [metric, definition.label, points])
  const reference = monthlyStatisticReference(metric)

  return <MonthlyLineChart series={series} selectedMonth={selectedMonth} onSelect={onSelect}
    title={`${definition.label}の月別推移`}
    description={`キャラ別公式Totalを百分率に換算した値から求めた${definition.label}の推移。${reference ? '破線は比較の基準となる50%。' : '縦軸の単位はポイント。'}数値がない月は線をつなぎません。`}
    regionLabel={`${definition.label}の推移グラフ`} axisLabel={`${definition.label}（${definition.unit}）`}
    axis={axis} formatTick={tick => formatMonthlyStatisticTick(tick, axis.step)} reference={reference}
    valueLabel={(_seriesId, month) => {
      const row = rowsByMonth.get(month)
      return row ? monthlyStatisticValueLabel(row, metric) : '未登録'
    }} />
}
