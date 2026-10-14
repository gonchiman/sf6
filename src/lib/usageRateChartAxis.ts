import type { MonthlyLineChartAxis } from '../types/monthlyLineChart.ts'

export type UsageRateChartRange = '0-20' | '0-10' | '0-100'

export const USAGE_RATE_CHART_RANGES = [
  { id: '0-20', label: '0〜20%' },
  { id: '0-10', label: '0〜10%' },
  { id: '0-100', label: '0〜100%' },
] as const

const AXES: Readonly<Record<UsageRateChartRange, MonthlyLineChartAxis>> = Object.freeze({
  '0-20': Object.freeze({ start: 0, end: 20, ticks: Object.freeze([0, 5, 10, 15, 20]) }),
  '0-10': Object.freeze({ start: 0, end: 10, ticks: Object.freeze([0, 2.5, 5, 7.5, 10]) }),
  '0-100': Object.freeze({ start: 0, end: 100, ticks: Object.freeze([0, 25, 50, 75, 100]) }),
})

export function usageRateChartAxis(range: UsageRateChartRange): MonthlyLineChartAxis {
  const axis = AXES[range]
  if (!axis) throw new Error('使用率の表示範囲の指定が正しくありません。')
  return axis
}
