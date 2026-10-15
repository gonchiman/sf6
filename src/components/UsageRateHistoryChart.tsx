import { useMemo } from 'react'
import { usageRateComparisonStyle } from '../lib/usageRateComparisonColors'
import { formatUsageRateHistoryPoint, monthlyUsageRateAxis } from '../lib/usageRateHistory'
import type { MonthlyLineChartSeries } from '../types/monthlyLineChart'
import type { UsageRateBaselinePoint } from '../types/usageRateBaseline'
import type { UsageRateComparisonSeries } from '../types/usageRateComparison'
import { SeriesMarker } from './CharacterSeriesKey'
import { MonthlyLineChart } from './MonthlyLineChart'

const BASELINE_STYLE = { color: 'var(--text-muted)', dashArray: '1 4' } as const

export function UsageRateHistorySeriesKey({ colorSlot }: { colorSlot: number }) {
  const style = usageRateComparisonStyle(colorSlot)
  return <svg className="history-series-key" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
    <line x1="1" y1="7" x2="33" y2="7" stroke={style.color} strokeWidth="2" strokeDasharray={style.dashArray} />
    <SeriesMarker shape={style.marker} x={17} y={7} size={3} color={style.color} />
  </svg>
}

export function UsageRateHistoryChart({ series, selectedMonth, onSelect, baseline }: {
  series: readonly UsageRateComparisonSeries[]
  selectedMonth: string
  onSelect: (month: string) => void
  baseline?: readonly UsageRateBaselinePoint[]
}) {
  const chartSeries = useMemo<MonthlyLineChartSeries[]>(() => series.map(item => ({
    id: item.seriesId, label: item.label,
    style: usageRateComparisonStyle(item.colorSlot),
    points: item.points.map(point => ({ month: point.month, value: point.value })),
  })), [series])
  const referenceSeries = useMemo(() => baseline !== undefined ? {
    id: 'uniform-usage', label: '均等基準', style: BASELINE_STYLE,
    points: baseline.map(point => ({ month: point.month, value: point.status === 'value' ? point.value : null })),
  } : undefined, [baseline])
  const axis = useMemo(() => monthlyUsageRateAxis([
    ...chartSeries.flatMap(item => item.points.flatMap(point => point.value === null ? [] : [point.value])),
    ...(referenceSeries?.points.flatMap(point => point.value === null ? [] : [point.value]) ?? []),
  ]), [chartSeries, referenceSeries])
  const legend = <ul className="history-series-legend usage-rate-comparison-legend" aria-label="グラフの系列">
    {series.map(item => <li key={item.seriesId}>
      <UsageRateHistorySeriesKey colorSlot={item.colorSlot} /><span>{item.label}</span>
    </li>)}
    {referenceSeries && <li><svg className="history-series-key usage-rate-baseline-key" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
      <line x1="1" y1="7" x2="33" y2="7" stroke={BASELINE_STYLE.color} strokeWidth="1.25" strokeDasharray={BASELINE_STYLE.dashArray} strokeLinecap="round" />
    </svg>均等基準</li>}
  </ul>
  return <MonthlyLineChart series={chartSeries} selectedMonth={selectedMonth} onSelect={onSelect}
    title="月別使用率推移" description="公式の使用率を百分率で表示します。数値がない月は線をつなぎません。"
    regionLabel="使用率推移グラフ" axisLabel="使用率（%）" axis={axis} formatTick={value => String(value)}
    valueLabel={(seriesId, month) => {
      const point = series.find(item => item.seriesId === seriesId)?.points.find(item => item.month === month)
      return point ? formatUsageRateHistoryPoint(point) : '未登録'
    }} legend={legend} referenceSeries={referenceSeries} />
}
