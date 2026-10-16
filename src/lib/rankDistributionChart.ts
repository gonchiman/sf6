import type { RankDistributionRow } from '../types/rankDistribution.ts'

export type RankDistributionChartMetric = 'percent' | 'count'

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })

function validValue(value: unknown, metric: RankDistributionChartMetric): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  if (metric === 'percent' ? value > 100 : metric !== 'count' || !Number.isSafeInteger(value)) return null
  return value === 0 ? 0 : value
}

/** Use the shared row's unrounded value, including its global percentage denominator. */
export function rankDistributionChartValue(row: RankDistributionRow, metric: RankDistributionChartMetric): number | null {
  return validValue(metric === 'percent' ? row.percent : metric === 'count' ? row.count : null, metric)
}

function tidy(value: number): number {
  // Remove multiplication noise in tick labels without rounding the observations.
  return Number(value.toPrecision(15))
}

/** Zero-based 1/2/5 ticks, following the existing count-chart scale. */
export function rankDistributionChartAxis(rows: readonly RankDistributionRow[], metric: RankDistributionChartMetric): {
  maximum: number
  ticks: number[]
} {
  const observedMaximum = rows.reduce((largest, row) => Math.max(largest, rankDistributionChartValue(row, metric) ?? 0), 0)
  if (observedMaximum === 0) return { maximum: 1, ticks: [0, 1] }
  const desiredStep = Math.max(Number.MIN_VALUE, observedMaximum / 5)
  const magnitude = Math.max(Number.MIN_VALUE, 10 ** Math.floor(Math.log10(desiredStep)))
  const multiple = [1, 2, 5, 10].find(value => value * magnitude >= desiredStep) ?? 10
  const step = metric === 'count' ? Math.max(1, multiple * magnitude) : multiple * magnitude
  const limit = metric === 'percent' ? 100 : Number.MAX_SAFE_INTEGER
  const maximum = Math.max(observedMaximum, Math.min(limit, tidy(Math.ceil(observedMaximum / step) * step)))
  const ticks = [0]
  for (let index = 1; index <= Math.floor(maximum / step); index += 1) {
    const tick = tidy(index * step)
    if (tick <= maximum && tick > ticks[ticks.length - 1]) ticks.push(tick)
  }
  if (ticks[ticks.length - 1] !== maximum) ticks.push(maximum)
  return { maximum, ticks }
}

/** Only labels are rounded; the value and axis helpers retain numeric precision. */
export function rankDistributionChartValueLabel(value: number | null, metric: RankDistributionChartMetric): string {
  const valid = validValue(value, metric)
  if (valid === null) return '—'
  return metric === 'percent' ? `${valid.toFixed(2)}%` : `${integerFormat.format(valid)} 件`
}
