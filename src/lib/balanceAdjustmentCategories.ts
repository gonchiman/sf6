import type { BalanceAdjustmentChange, BalanceAdjustmentDetailsCatalog } from '../types/balanceAdjustmentDetails.ts'

export type CategoryFilter = { mode: 'all' } | { mode: 'selected'; keys: readonly string[] }

export interface BalanceAdjustmentCategoryOption {
  key: string
  label: string
}

export interface BalanceAdjustmentCategoryCount {
  itemCount: number | null
  status: 'ready' | 'category-unlisted' | 'no-category-selected'
}

const CATEGORY_ORDER = [
  '調整', '不具合修正', '調整・不具合修正', '共通調整',
  '調整（強調）', '不具合修正（強調）', '調整・不具合修正（強調）', '共通調整（取消線）',
]

/** Use the complete imported catalog so date and character filters do not remove selected options. */
export function balanceAdjustmentCategoryOptions(details: BalanceAdjustmentDetailsCatalog | null): BalanceAdjustmentCategoryOption[] {
  const categories = new Set(details?.patches.flatMap((patch) => [
    ...patch.common.changes,
    ...patch.characters.filter((character) => character.status === 'ready').flatMap((character) => character.changes),
  ]).map((change) => change.categoryLabel) ?? [])
  const known = CATEGORY_ORDER.filter((key) => categories.has(key))
  const others = [...categories].filter((key) => key !== '' && !CATEGORY_ORDER.includes(key)).sort((first, second) => first.localeCompare(second, 'ja'))
  return [...known, ...others, ...(categories.has('') ? [''] : [])].map((key) => ({ key, label: key === '' ? '分類記載なし' : key }))
}

/** Match original labels once per official row; composite and annotated labels remain independent. */
export function filterBalanceAdjustmentChanges(
  changes: readonly BalanceAdjustmentChange[], categoryFilter: CategoryFilter = { mode: 'all' },
): BalanceAdjustmentChange[] {
  if (categoryFilter.mode === 'all') return [...changes]
  const selected = new Set(categoryFilter.keys)
  return changes.filter((change) => selected.has(change.categoryLabel))
}

/** An absent official classification cannot establish zero for a selected named category. */
export function countBalanceAdjustmentChanges(
  changes: readonly BalanceAdjustmentChange[], categoryFilter: CategoryFilter = { mode: 'all' },
): BalanceAdjustmentCategoryCount {
  if (categoryFilter.mode === 'all') return { itemCount: changes.length, status: 'ready' }
  if (categoryFilter.keys.length === 0) return { itemCount: null, status: 'no-category-selected' }
  if (!categoryFilter.keys.includes('') && changes.some((change) => change.categoryLabel === '')) {
    return { itemCount: null, status: 'category-unlisted' }
  }
  return { itemCount: filterBalanceAdjustmentChanges(changes, categoryFilter).length, status: 'ready' }
}
