import type { MonthlyLineChartAxis, MonthlyLineChartPoint, MonthlyLineChartSeries } from '../types/monthlyLineChart.ts'

export const MONTHLY_LINE_CHART_LAYOUT = Object.freeze({
  height: 322, top: 34, bottom: 274, left: 48, rightInset: 18, minimumWidth: 240,
  monthLabelWidth: 56, monthLabelGap: 16,
})

function monthNumber(month: string): number {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('対象月はYYYY-MM形式で指定してください。')
  const [year, value] = month.split('-').map(Number)
  return year * 12 + value - 1
}

function indexedMonth(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`
}

/** Keep every calendar month, including months without a point in any series. */
export function monthlyChartMonths(series: readonly MonthlyLineChartSeries[]): string[] {
  const values = series.flatMap(item => item.points.map(point => monthNumber(point.month)))
  if (!values.length) return []
  const first = Math.min(...values)
  const last = Math.max(...values)
  return Array.from({ length: last - first + 1 }, (_, index) => indexedMonth(first + index))
}

/** Shared rate axis: always include 50%, preserve 0% and 100%, and add space around the data. */
export function monthlyPercentAxis(values: readonly number[]): MonthlyLineChartAxis & { readonly step: number } {
  const finite = values.filter(value => Number.isFinite(value) && value >= 0 && value <= 100)
  const minimum = Math.min(50, ...finite)
  const maximum = Math.max(50, ...finite)
  const span = Math.max(2, maximum - minimum)
  const middle = (minimum + maximum) / 2
  const low = Math.max(0, middle - span * 0.62)
  const high = Math.min(100, middle + span * 0.62)
  const step = [0.5, 1, 2, 5, 10, 20, 25].find(value => value >= (high - low) / 5) ?? 25
  const start = Math.max(0, Math.floor(low / step) * step)
  const end = Math.min(100, Math.ceil(high / step) * step)
  const ticks = Array.from({ length: Math.round((end - start) / step) + 1 }, (_, index) => start + index * step)
  return { start, end, ticks, step }
}

export function monthlyChartCoordinates(months: readonly string[], width: number, axis: MonthlyLineChartAxis) {
  const { left, rightInset, top, bottom } = MONTHLY_LINE_CHART_LAYOUT
  const right = width - rightInset
  const first = months.length ? monthNumber(months[0]) : 0
  const last = months.length ? monthNumber(months[months.length - 1]) : first
  return {
    right,
    x: (month: string) => first === last ? (left + right) / 2
      : left + (monthNumber(month) - first) / (last - first) * (right - left),
    y: (value: number) => bottom - (value - axis.start) / (axis.end - axis.start) * (bottom - top),
  }
}

export function monthlyChartLabelIndices(months: readonly string[], x: (month: string) => number): number[] {
  const { monthLabelWidth, monthLabelGap } = MONTHLY_LINE_CHART_LAYOUT
  const indices = months.length ? [0] : []
  if (months.length > 1) {
    // End labels extend inward; reserve their full width before centered labels.
    const lastLabelLeft = x(months[months.length - 1]) - monthLabelWidth
    let previousLabelRight = x(months[0]) + monthLabelWidth
    for (let index = 1; index < months.length - 1; index += 1) {
      const labelLeft = x(months[index]) - monthLabelWidth / 2
      const labelRight = x(months[index]) + monthLabelWidth / 2
      if (labelLeft >= previousLabelRight + monthLabelGap && labelRight <= lastLabelLeft - monthLabelGap) {
        indices.push(index)
        previousLabelRight = labelRight
      }
    }
    indices.push(months.length - 1)
  }
  return indices
}

export function hasMonthlyChartValue(point: MonthlyLineChartPoint): point is MonthlyLineChartPoint & { value: number } {
  return point.value !== null && Number.isFinite(point.value)
}

/** Split each series at missing values and non-consecutive calendar months; never round coordinates. */
export function monthlyChartSegments(
  points: readonly MonthlyLineChartPoint[], x: (month: string) => number, y: (value: number) => number,
): string[] {
  const segments: string[] = []
  let previousMonth: number | null = null
  for (const point of [...points].sort((left, right) => left.month.localeCompare(right.month))) {
    if (!hasMonthlyChartValue(point)) {
      previousMonth = null
      continue
    }
    const currentMonth = monthNumber(point.month)
    const coordinate = `${x(point.month)} ${y(point.value)}`
    if (previousMonth === null || currentMonth !== previousMonth + 1) segments.push(`M ${coordinate}`)
    else segments[segments.length - 1] += ` L ${coordinate}`
    previousMonth = currentMonth
  }
  return segments
}
