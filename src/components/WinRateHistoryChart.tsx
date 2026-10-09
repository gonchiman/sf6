import { useMemo } from 'react'
import { formatHistoryValue } from '../lib/winRateHistory'
import { characterSeriesStyle } from '../lib/seriesColors'
import { monthlyPercentAxis } from '../lib/monthlyLineChart'
import type { MonthlyLineChartSeries } from '../types/monthlyLineChart'
import type { WinRateHistoryPoint, WinRateHistorySeries } from '../types/winRateHistory'
import { CharacterSeriesKey } from './CharacterSeriesKey'
import { MonthlyLineChart } from './MonthlyLineChart'
import '../win-rate-history-chart.css'

type Props = {
  series: readonly WinRateHistorySeries[]
  selectedMonth: string
  onSelect: (month: string) => void
}

function percentValue(point: WinRateHistoryPoint): number | null {
  return point.status === 'value' && point.percentHundredths !== null
    && Number.isFinite(point.percentHundredths) && point.percentHundredths >= 0 && point.percentHundredths <= 10000
    ? point.percentHundredths / 100 : null
}

export function WinRateHistoryChart({ series, selectedMonth, onSelect }: Props) {
  const chartSeries = useMemo<MonthlyLineChartSeries[]>(() => series.map(item => ({
    id: item.characterId, label: item.characterName, style: characterSeriesStyle(item.characterId),
    points: item.points.map(point => ({ month: point.month, value: percentValue(point) })),
  })), [series])
  const axis = useMemo(() => monthlyPercentAxis(chartSeries.flatMap(item => item.points.flatMap(point => point.value === null ? [] : [point.value]))), [chartSeries])
  const legend = <ul className="history-series-legend" aria-label="グラフのキャラクター">
    {series.map(item => <li key={item.characterId}><CharacterSeriesKey characterId={item.characterId} /><span>{item.characterName}</span></li>)}
  </ul>

  return <MonthlyLineChart series={chartSeries} selectedMonth={selectedMonth} onSelect={onSelect}
    title={`${series.map(item => item.characterName).join('・')}の月別勝率推移`}
    description="公式Totalの百分率換算値。破線は比較の基準となる50%。数値がない月は線をつなぎません。"
    regionLabel="勝率推移グラフ" axisLabel="Total（%）" axis={axis}
    formatTick={value => value.toFixed(axis.step < 1 ? 1 : 0)}
    valueLabel={(seriesId, month) => {
      const point = series.find(item => item.characterId === seriesId)?.points.find(point => point.month === month)
      return point ? formatHistoryValue(point) : '未登録'
    }}
    reference={{ value: 50, label: '50% 基準' }} legend={legend} />
}
