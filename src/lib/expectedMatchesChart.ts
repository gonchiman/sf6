import type { ExpectedMatchRow } from '../types/expectedMatchData.ts'

const numberFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })

/** Missing or failed results never become zero-height numeric observations. */
export function expectedMatchValue(row: ExpectedMatchRow): number | null {
  return row.result.status === 'finite' && Number.isFinite(row.result.expectedMatches)
    && row.result.expectedMatches >= 0 ? row.result.expectedMatches : null
}

export function expectedMatchResultText(row: ExpectedMatchRow): string {
  const value = expectedMatchValue(row)
  if (value !== null) return numberFormat.format(value)
  if (row.result.status === 'infinite') return '∞'
  if (row.result.status === 'missing-data') return 'データ不足'
  return '計算不能'
}

/** Pass the complete calculation so choosing characters does not alter the scale. */
export function expectedMatchesAxis(rows: readonly ExpectedMatchRow[]): { maximum: number; ticks: number[] } {
  const maximum = rows.reduce((largest, row) => Math.max(largest, expectedMatchValue(row) ?? 0), 0)
  if (maximum === 0) return { maximum: 1, ticks: [0, 1] }
  const desiredStep = maximum / 5
  const magnitude = 10 ** Math.floor(Math.log10(desiredStep))
  const step = Math.max(1, ([1, 2, 5, 10].find(value => value * magnitude >= desiredStep) ?? 10) * magnitude)
  const count = Math.ceil(maximum / step)
  const end = count * step
  // Keep coordinates finite even for values beyond the calculation engine's range.
  if (!Number.isFinite(end)) return { maximum, ticks: Array.from({ length: 6 }, (_, index) => maximum * (index / 5)) }
  return { maximum: end, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) }
}
