import { useMemo } from 'react'
import { controlTypeBarStyle } from '../lib/controlTypeBarStyles'
import { formatUsageRateHistoryPoint, monthlyUsageRateAxis, type createCharacterUsageRateHistory } from '../lib/usageRateHistory'
import type { MonthlyLineChartSeries } from '../types/monthlyLineChart'
import type { UsageRateBaselinePoint } from '../types/usageRateBaseline'
import { SeriesMarker } from './CharacterSeriesKey'
import { MonthlyLineChart } from './MonthlyLineChart'

type History = ReturnType<typeof createCharacterUsageRateHistory>
type ControlType = History['series'][number]['controlType']
const BASELINE_STYLE = { color: 'var(--text-muted)', dashArray: '1 4' } as const
const CONTROL_TYPE_LINE_COLORS = {
  combined: controlTypeBarStyle('combined').fill,
  classic: '#546f8b',
  modern: '#a07752',
} as const satisfies Readonly<Record<ControlType, string>>

function seriesStyle(controlType: ControlType): MonthlyLineChartSeries['style'] {
  return {
    color: CONTROL_TYPE_LINE_COLORS[controlType],
    marker: 'circle',
  }
}

export function UsageRateHistorySeriesKey({ controlType }: { controlType: ControlType }) {
  const style = seriesStyle(controlType)
  return <svg className="history-series-key" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
    <line x1="1" y1="7" x2="33" y2="7" stroke={style.color} strokeWidth="2" strokeDasharray={style.dashArray} />
    <SeriesMarker shape={style.marker} x={17} y={7} size={3} color={style.color} />
  </svg>
}

export function UsageRateHistoryChart({ history, selectedMonth, onSelect, baseline }: {
  history: History
  selectedMonth: string
  onSelect: (month: string) => void
  baseline?: readonly UsageRateBaselinePoint[]
}) {
  const series = useMemo<MonthlyLineChartSeries[]>(() => history.series.map(item => ({
    id: item.controlType, label: controlTypeBarStyle(item.controlType).label,
    style: seriesStyle(item.controlType),
    points: item.points.map(point => ({ month: point.month, value: point.value })),
  })), [history])
  const referenceSeries = useMemo(() => baseline !== undefined ? {
    id: 'uniform-usage', label: '均等基準', style: BASELINE_STYLE,
    points: baseline.map(point => ({ month: point.month, value: point.status === 'value' ? point.value : null })),
  } : undefined, [baseline])
  const axis = useMemo(() => monthlyUsageRateAxis([
    ...series.flatMap(item => item.points.flatMap(point => point.value === null ? [] : [point.value])),
    ...(referenceSeries?.points.flatMap(point => point.value === null ? [] : [point.value]) ?? []),
  ]), [series, referenceSeries])
  const legend = history.series.length > 1 || referenceSeries ? <ul className="history-series-legend" aria-label="グラフの系列">
    {history.series.map(item => <li key={item.controlType}>
      <UsageRateHistorySeriesKey controlType={item.controlType} />{controlTypeBarStyle(item.controlType).label}
    </li>)}
    {referenceSeries && <li><svg className="history-series-key usage-rate-baseline-key" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
      <line x1="1" y1="7" x2="33" y2="7" stroke={BASELINE_STYLE.color} strokeWidth="1.25" strokeDasharray={BASELINE_STYLE.dashArray} strokeLinecap="round" />
    </svg>均等基準</li>}
  </ul> : undefined
  return <MonthlyLineChart series={series} selectedMonth={selectedMonth} onSelect={onSelect}
    title={`${history.characterName}の月別使用率推移`} description="公式の使用率を百分率で表示します。数値がない月は線をつなぎません。"
    regionLabel="使用率推移グラフ" axisLabel="使用率（%）" axis={axis} formatTick={value => String(value)}
    valueLabel={(controlType, month) => {
      const point = history.series.find(item => item.controlType === controlType)?.points.find(item => item.month === month)
      return point ? formatUsageRateHistoryPoint(point) : '未登録'
    }} legend={legend} referenceSeries={referenceSeries} />
}
