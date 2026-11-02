/** Only numeric observations and fixed states may leave the private ranking reader. */
export interface LegendOrderValues {
  rank: number
  masterRating: number
}
export interface LegendOrderPosition extends LegendOrderValues {
  page: number
  /** One-based position within the displayed page. */
  rowIndex: number
}
export interface LegendOrderDiagnostic {
  boundary: 'within-page' | 'between-pages'
  previous: LegendOrderPosition
  current: LegendOrderPosition
  sameEntry: boolean
  duplicateInAccepted: boolean
  duplicateWithinCurrentPage: boolean
}
export type LegendOrderRecheck = { status: 'failed' } | { status: 'unavailable'; elapsedMs: number } | {
  status: 'observed'
  elapsedMs: number
  page: number
  from: number
  to: number
  totalCount: number
  sameEntries: boolean
  sameRanksAndMr: boolean
  previous: LegendOrderValues | null
  current: LegendOrderValues | null
  currentSameEntry: boolean
  previousSameEntry: boolean | null
  rankInversionWithinPage: boolean
  mrInversionWithinPage: boolean
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, min: number, max = 1000000000): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
const bool = (value: unknown): value is boolean => typeof value === 'boolean'
function values(value: unknown): LegendOrderValues | undefined {
  if (!record(value)) return undefined
  const { rank, masterRating } = value
  if (!integer(rank, 1) || !integer(masterRating, 0)) return undefined
  return { rank, masterRating }
}
function position(value: unknown): LegendOrderPosition | undefined {
  const numeric = values(value)
  if (!numeric || !record(value)) return undefined
  const { page, rowIndex } = value
  if (!integer(page, 1, 1000000) || !integer(rowIndex, 1, 20)) return undefined
  return { page, rowIndex, ...numeric }
}

/** Rebuild the allowlist rather than forwarding nested objects, custom serializers, or unknown fields. */
export function sanitizeLegendOrderDiagnostic(value: unknown): LegendOrderDiagnostic | undefined {
  try {
    if (!record(value)) return undefined
    const { boundary, sameEntry, duplicateInAccepted, duplicateWithinCurrentPage } = value
    if ((boundary !== 'within-page' && boundary !== 'between-pages')
      || !bool(sameEntry) || !bool(duplicateInAccepted) || !bool(duplicateWithinCurrentPage)) return undefined
    const previous = position(value.previous), current = position(value.current)
    if (!previous || !current) return undefined
    return { boundary, previous, current, sameEntry, duplicateInAccepted, duplicateWithinCurrentPage }
  } catch { return undefined }
}

/** Malformed observations are omitted; their enclosing validation failure is still reported. */
export function sanitizeLegendOrderRecheck(value: unknown): LegendOrderRecheck | undefined {
  try {
    if (!record(value)) return undefined
    const { status } = value
    if (status === 'failed') return { status: 'failed' }
    const { elapsedMs } = value
    if (!integer(elapsedMs, 0, 10000)) return undefined
    if (status === 'unavailable') return { status: 'unavailable', elapsedMs }
    const { page, from, to, totalCount, sameEntries, sameRanksAndMr, currentSameEntry, previousSameEntry,
      rankInversionWithinPage, mrInversionWithinPage, previous: previousValue, current: currentValue } = value
    if (status !== 'observed' || !integer(page, 1, 1000000)
      || !integer(from, 1) || !integer(to, 1) || !integer(totalCount, 1)
      || !bool(sameEntries) || !bool(sameRanksAndMr) || !bool(currentSameEntry)
      || !(previousSameEntry === null || bool(previousSameEntry))
      || !bool(rankInversionWithinPage) || !bool(mrInversionWithinPage)) return undefined
    const previous = previousValue === null ? null : values(previousValue)
    const current = currentValue === null ? null : values(currentValue)
    if (previous === undefined || current === undefined) return undefined
    return { status: 'observed', elapsedMs, page, from, to, totalCount, sameEntries, sameRanksAndMr,
      previous, current, currentSameEntry, previousSameEntry, rankInversionWithinPage, mrInversionWithinPage }
  } catch { return undefined }
}
