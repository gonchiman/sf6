import type { MonthlyLineChartAxis } from '../types/monthlyLineChart.ts'
import type { WinRateHistoryPoint } from '../types/winRateHistory.ts'

export type CharacterLeagueChartRange = '0-100' | '40-60' | '45-55'

export const CHARACTER_LEAGUE_CHART_RANGES = [
  { id: '0-100', label: '0〜100%' },
  { id: '40-60', label: '40〜60%' },
  { id: '45-55', label: '45〜55%' },
] as const

export interface CharacterLeagueChartAxis extends MonthlyLineChartAxis {
  readonly step: number
}

const AXES: Readonly<Record<CharacterLeagueChartRange, CharacterLeagueChartAxis>> = Object.freeze({
  '0-100': Object.freeze({ start: 0, end: 100, step: 25, ticks: Object.freeze([0, 25, 50, 75, 100]) }),
  '40-60': Object.freeze({ start: 40, end: 60, step: 5, ticks: Object.freeze([40, 45, 50, 55, 60]) }),
  '45-55': Object.freeze({ start: 45, end: 55, step: 2.5, ticks: Object.freeze([45, 47.5, 50, 52.5, 55]) }),
})

/** Fixed presets share one axis across characters and control types, independent of their values. */
export function characterLeagueChartAxis(range: CharacterLeagueChartRange): CharacterLeagueChartAxis {
  const axis = AXES[range]
  if (!axis) throw new Error('表示範囲の指定が正しくありません。')
  return axis
}

export interface CharacterLeagueChartValue {
  /** The original percentage; clipping only affects displayValue. */
  value: number | null
  displayValue: number | null
  outside: 'below' | 'above' | null
}

/** Retain genuine zero and missing states; clip drawing positions without rounding published values. */
export function characterLeagueChartValue(
  point: WinRateHistoryPoint | undefined,
  axis: Pick<MonthlyLineChartAxis, 'start' | 'end'>,
): CharacterLeagueChartValue {
  const hundredths = point?.percentHundredths
  if (point?.status !== 'value' || hundredths === null || hundredths === undefined
    || !Number.isInteger(hundredths) || hundredths < 0 || hundredths > 10_000
    || !Number.isFinite(axis.start) || !Number.isFinite(axis.end) || axis.start >= axis.end) {
    return { value: null, displayValue: null, outside: null }
  }
  const value = hundredths / 100
  return {
    value,
    displayValue: Math.min(axis.end, Math.max(axis.start, value)),
    outside: value < axis.start ? 'below' : value > axis.end ? 'above' : null,
  }
}
