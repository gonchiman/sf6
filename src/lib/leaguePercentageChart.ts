import type { MonthlyLineChartAxis } from '../types/monthlyLineChart.ts'

/** Bound drawing coordinates without changing the published percentage. */
export function leaguePercentageChartValue(value: number | null | undefined, axis: Pick<MonthlyLineChartAxis, 'start' | 'end'>) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0 || value > 100
    || !Number.isFinite(axis.start) || !Number.isFinite(axis.end) || axis.start >= axis.end) {
    return { value: null, displayValue: null, outside: null }
  }
  return {
    value,
    displayValue: Math.min(axis.end, Math.max(axis.start, value)),
    outside: value < axis.start ? 'below' as const : value > axis.end ? 'above' as const : null,
  }
}

/** Reduced mobile ticks stay inside the chosen axis and retain its actual reference, if any. */
export function leaguePercentageChartTicks(axis: MonthlyLineChartAxis, compact: boolean, referenceValue?: number): readonly number[] {
  if (!compact) return axis.ticks
  const middle = referenceValue !== undefined && referenceValue > axis.start && referenceValue < axis.end
    ? referenceValue : (axis.start + axis.end) / 2
  return [axis.start, middle, axis.end]
}
