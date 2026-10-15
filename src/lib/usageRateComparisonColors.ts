import type { MonthlyLineChartSeries } from '../types/monthlyLineChart.ts'

type SeriesStyle = MonthlyLineChartSeries['style']

/** Slots belong to editable comparison rows, rather than characters or control types. */
const SLOT_STYLES: readonly SeriesStyle[] = Object.freeze([
  '#546f8b', '#a07752', '#6c7e67', '#8a6f88', '#6b7c82', '#927963',
].map(color => Object.freeze({ color, marker: 'circle' as const })))

const UNKNOWN_STYLE: SeriesStyle = Object.freeze({ color: '#727272', marker: 'circle' })

/** Keep a row's style when other rows are edited, reordered, added or removed. */
export function usageRateComparisonStyle(colorSlot: number): SeriesStyle {
  return Number.isInteger(colorSlot) && colorSlot >= 0 && colorSlot < SLOT_STYLES.length
    ? SLOT_STYLES[colorSlot] : UNKNOWN_STYLE
}
