import type { BalanceAdjustmentPatchDetails } from '../types/balanceAdjustmentDetails.ts'

export interface BalanceAdjustmentOverviewCategory {
  key: string
  label: string
}

export interface BalanceAdjustmentOverviewRow {
  characterId: string | null
  name: string
  counts: number[]
  total: number
}

export interface BalanceAdjustmentOverview {
  categories: BalanceAdjustmentOverviewCategory[]
  rows: BalanceAdjustmentOverviewRow[]
  totals: number[]
  total: number
  commonCount: number
  characterCount: number
  characterItemCount: number
}

const CATEGORY_ORDER = ['調整', '不具合修正', '調整・不具合修正']

/** Count official rows once under their unchanged category label, without interpreting their impact. */
export function buildBalanceAdjustmentOverview(patch: BalanceAdjustmentPatchDetails): BalanceAdjustmentOverview {
  const subjects = [
    ...(patch.common.changes.length > 0
      ? [{ characterId: null, name: '共通', changes: patch.common.changes }]
      : []),
    ...patch.characters.filter((character) => character.status === 'ready' && character.changes.length > 0),
  ]
  const encountered = new Set(subjects.flatMap((subject) => subject.changes.map((change) => change.categoryLabel)))
  const preferred = CATEGORY_ORDER.filter((key) => encountered.has(key))
  const keys = [...preferred, ...[...encountered].filter((key) => !CATEGORY_ORDER.includes(key))]
  const categories = keys.map((key) => ({ key, label: key === '' ? '—' : key }))
  const rows = subjects.map((subject): BalanceAdjustmentOverviewRow => {
    const counts = new Map<string, number>()
    for (const change of subject.changes) {
      counts.set(change.categoryLabel, (counts.get(change.categoryLabel) ?? 0) + 1)
    }
    return {
      characterId: subject.characterId, name: subject.name,
      counts: keys.map((key) => counts.get(key) ?? 0), total: subject.changes.length,
    }
  })
  const totals = keys.map((_, index) => rows.reduce((sum, row) => sum + row.counts[index], 0))
  const commonCount = patch.common.changes.length
  const characterRows = rows.filter((row) => row.characterId !== null)
  const characterItemCount = characterRows.reduce((sum, row) => sum + row.total, 0)
  return {
    categories, rows, totals, total: commonCount + characterItemCount,
    commonCount, characterCount: characterRows.length, characterItemCount,
  }
}
