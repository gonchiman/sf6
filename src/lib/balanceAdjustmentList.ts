import { balanceAdjustmentCharacterStatus, balanceAdjustmentPatchDetails } from './balanceAdjustmentDetails.ts'
import type { BalanceAdjustment, BalanceAdjustmentCatalog } from '../types/balanceAdjustments.ts'
import type {
  BalanceAdjustmentCharacterDetails, BalanceAdjustmentDetailsCatalog, BalanceAdjustmentListFilters,
  BalanceAdjustmentPatchDetails,
} from '../types/balanceAdjustmentDetails.ts'

function month(value: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) throw new Error('対象月の形式が正しくありません。')
  return value
}

/** Every examined month is selectable, including months with no listed event. */
export function balanceAdjustmentMonthOptions(catalog: BalanceAdjustmentCatalog): string[] {
  const from = month(catalog.coverage.fromMonth)
  const to = month(catalog.coverage.toMonth)
  if (from > to) throw new Error('対象期間の順序が正しくありません。')
  const [fromYear, fromMonth] = from.split('-').map(Number)
  const [toYear, toMonth] = to.split('-').map(Number)
  const result: string[] = []
  for (let index = fromYear * 12 + fromMonth - 1; index <= toYear * 12 + toMonth - 1; index += 1) {
    result.push(`${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`)
  }
  return result
}

export function initialBalanceAdjustmentListFilters(catalog: BalanceAdjustmentCatalog): BalanceAdjustmentListFilters {
  const months = balanceAdjustmentMonthOptions(catalog)
  return { characterId: 'all', fromMonth: months[0], toMonth: months[months.length - 1] }
}

/** The endpoint the user changed wins when the range would be reversed. */
export function updateBalanceAdjustmentPeriod(
  filters: BalanceAdjustmentListFilters, changed: 'fromMonth' | 'toMonth', value: string,
): BalanceAdjustmentListFilters {
  const selected = month(value)
  const result = { ...filters, [changed]: selected }
  if (result.fromMonth > result.toMonth) {
    if (changed === 'fromMonth') result.toMonth = selected
    else result.fromMonth = selected
  }
  return result
}

export function filterBalanceAdjustmentList(
  catalog: BalanceAdjustmentCatalog, details: BalanceAdjustmentDetailsCatalog | null, filters: BalanceAdjustmentListFilters,
): { events: BalanceAdjustment[]; unknownCount: number } {
  const from = month(filters.fromMonth)
  const to = month(filters.toMonth)
  if (from > to) throw new Error('対象期間の順序が正しくありません。')
  let unknownCount = 0
  const events = catalog.events.filter((event) => {
    const eventMonth = event.date.slice(0, 7)
    if (eventMonth < from || eventMonth > to) return false
    if (filters.characterId === 'all') return true
    const patch = details && balanceAdjustmentPatchDetails(details, event)
    const status = balanceAdjustmentCharacterStatus(patch, filters.characterId)
    if (status === 'unimported') unknownCount += 1
    return status === 'ready'
  }).sort((first, second) => second.date.localeCompare(first.date) || first.id.localeCompare(second.id))
  return { events, unknownCount }
}

export function selectBalanceAdjustmentEvent(events: readonly BalanceAdjustment[], selectedId: string | null): BalanceAdjustment | null {
  return events.find((event) => event.id === selectedId) ?? events[0] ?? null
}

export function balanceAdjustmentCharacters(
  patch: BalanceAdjustmentPatchDetails, characterId = 'all',
): BalanceAdjustmentCharacterDetails[] {
  return patch.characters.filter((character) => characterId === 'all' || character.characterId === characterId)
}
