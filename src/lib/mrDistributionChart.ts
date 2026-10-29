import { createMrDistributionRows, mrDistributionBinLabel } from './mrDistribution.ts'
import { rankDistributionChartValueLabel } from './rankDistributionChart.ts'
import type { MrDistributionDataset, MrDistributionEntry, MrDistributionRow } from '../types/mrDistribution.ts'

export type MrDistributionChartLabelStyle = 'axis' | 'range' | 'range-two-line' | 'lower'
export type MrDistributionChartRange = 'focus' | 'all'
export type MrDistributionChartInterval = Pick<MrDistributionEntry, 'minimum' | 'maximum'>

/** Keep a positive tail distinct from a confirmed zero after display rounding. */
export function mrDistributionChartPercentLabel(value: number | null): string {
  return value !== null && value > 0 && value < .01 ? '0.01%未満' : rankDistributionChartValueLabel(value, 'percent')
}

export interface MrDistributionChartView {
  rows: MrDistributionRow[]
  /** Bounds have the same ordering as rows; maximum is exclusive or null for 2500+. */
  intervals: MrDistributionChartInterval[]
  visibleCount: number
  excludedCount: number
  /** Percent of the complete MR listing, null when its denominator is zero. */
  excludedPercent: number | null
}

/** Change the visible bins without renormalizing their all-listing percentages. */
export function createMrDistributionChartView(
  dataset: MrDistributionDataset,
  range: MrDistributionChartRange,
): MrDistributionChartView {
  // This also validates all bins before the chart selects a subset.
  const completeRows = createMrDistributionRows(dataset)
  const bins = new Map(dataset.entries.map(bin => [`mr-${bin.minimum}`, bin]))
  const rows = completeRows.filter(row => {
    const bin = bins.get(row.id)!
    return range === 'all' || bin.minimum >= 1000 && bin.minimum < 2200
  })
  const intervals = rows.map(row => {
    const { minimum, maximum } = bins.get(row.id)!
    return { minimum, maximum }
  })
  const visibleCount = rows.reduce((sum, row) => sum + row.count, 0)
  const excludedCount = dataset.totalCount - visibleCount
  return {
    rows,
    intervals,
    visibleCount,
    excludedCount,
    excludedPercent: dataset.totalCount > 0 ? excludedCount / dataset.totalCount * 100 : null,
  }
}

/** Labels belong to the center of their bar; numeric axis mode supplies its own ticks. */
export function mrDistributionChartLabelLines(
  interval: MrDistributionChartInterval,
  style: MrDistributionChartLabelStyle,
): string[] {
  const { minimum, maximum } = interval
  const rangeLabel = mrDistributionBinLabel(minimum, maximum)
  switch (style) {
    case 'axis': return []
    case 'range': return [rangeLabel]
    case 'range-two-line': return [String(minimum), maximum === null ? '以上' : `〜${maximum - 1}`]
    case 'lower': return [maximum === null ? rangeLabel : String(minimum)]
  }
}
