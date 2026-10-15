import { balanceAdjustmentPatchDetails } from './balanceAdjustmentDetails.ts'
import { buildBalanceAdjustmentOverview } from './balanceAdjustmentOverview.ts'
import { countBalanceAdjustmentChanges, type CategoryFilter } from './balanceAdjustmentCategories.ts'
import type { BalanceAdjustment } from '../types/balanceAdjustments.ts'
import type { BalanceAdjustmentDetailsCatalog } from '../types/balanceAdjustmentDetails.ts'

export interface BalanceAdjustmentCountRow {
  event: BalanceAdjustment
  itemCount: number | null
  status: 'ready' | 'unimported' | 'unlisted' | 'category-unlisted' | 'no-category-selected'
}

export function balanceAdjustmentCountStateLabel(status: BalanceAdjustmentCountRow['status']): string {
  switch (status) {
    case 'ready': return ''
    case 'unimported': return '未取込'
    case 'unlisted': return '未掲載'
    case 'category-unlisted': return '分類記載なし'
    case 'no-category-selected': return '分類未選択'
  }
}

/** Preserve supplied events and missing states; character counts contain only that character's official rows. */
export function buildBalanceAdjustmentCountRows(
  events: readonly BalanceAdjustment[], details: BalanceAdjustmentDetailsCatalog | null, characterId = 'all',
  categoryFilter: CategoryFilter = { mode: 'all' },
): BalanceAdjustmentCountRow[] {
  return [...events].sort((first, second) => first.date.localeCompare(second.date) || first.id.localeCompare(second.id))
    .map((event): BalanceAdjustmentCountRow => {
      const patch = details && balanceAdjustmentPatchDetails(details, event)
      if (!patch) return { event, itemCount: null, status: 'unimported' }
      if (characterId === 'all') {
        if (categoryFilter.mode === 'all') return { event, itemCount: buildBalanceAdjustmentOverview(patch).total, status: 'ready' }
        const changes = [
          ...patch.common.changes,
          ...patch.characters.filter((character) => character.status === 'ready').flatMap((character) => character.changes),
        ]
        return { event, ...countBalanceAdjustmentChanges(changes, categoryFilter) }
      }
      const character = patch.characters.find((item) => item.characterId === characterId)
      if (!character) return { event, itemCount: null, status: 'unimported' }
      if (character.status === 'unlisted') return { event, itemCount: null, status: 'unlisted' }
      return { event, ...countBalanceAdjustmentChanges(character.changes, categoryFilter) }
    })
}

/** Use the expected-matches chart's zero-based 1/2/5 scale with whole-item ticks. */
export function balanceAdjustmentCountAxis(rows: readonly BalanceAdjustmentCountRow[]): { maximum: number; ticks: number[] } {
  const maximum = rows.reduce((largest, row) => row.status === 'ready'
    && row.itemCount !== null && Number.isSafeInteger(row.itemCount) && row.itemCount >= 0
    ? Math.max(largest, row.itemCount) : largest, 0)
  if (maximum === 0) return { maximum: 1, ticks: [0, 1] }
  const desiredStep = maximum / 5
  const magnitude = 10 ** Math.floor(Math.log10(desiredStep))
  const step = Math.max(1, ([1, 2, 5, 10].find(value => value * magnitude >= desiredStep) ?? 10) * magnitude)
  const count = Math.ceil(maximum / step)
  return { maximum: count * step, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) }
}
