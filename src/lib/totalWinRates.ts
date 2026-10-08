import type { WinRateCell, WinRateDataset, WinRateFighter } from '../types/winRates.ts'

export type TotalWinRateSort = 'official' | 'ascending' | 'descending'

/** Convert the published Total to hundredths of a percent without adding precision. */
export function totalPercentHundredths(text: string): number | null {
  if (text === '-' || text === '-.---') return null
  if (!/^(?:[0-9]\.\d{3}|10\.000)$/.test(text)) {
    throw new Error('Totalの数値形式が正しくありません。')
  }
  return Number(text.replace('.', ''))
}

export function formatTotalPercent(text: string): string {
  const value = totalPercentHundredths(text)
  if (value === null) return text
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}%`
}

export function createTotalWinRateRows(
  dataset: WinRateDataset,
  sort: TotalWinRateSort,
): { fighter: WinRateFighter; total: WinRateCell }[] {
  const rowsById = new Map(dataset.rows.map((row) => [row.fighterId, row]))
  const rows = dataset.fighters.map((fighter) => {
    const row = rowsById.get(fighter.id)
    if (!row) throw new Error('キャラクターに対応するTotalがありません。')
    return { fighter, total: row.total }
  })
  if (sort === 'official') return rows

  const direction = sort === 'ascending' ? 1 : -1
  return rows.map((row, index) => ({ row, index, value: totalPercentHundredths(row.total.text) }))
    .sort((left, right) => {
      // Keep missing values last in both directions, then preserve the official order for ties.
      if (left.value === null) return right.value === null ? left.index - right.index : 1
      if (right.value === null) return -1
      return (left.value - right.value) * direction || left.index - right.index
    })
    .map(({ row }) => row)
}
