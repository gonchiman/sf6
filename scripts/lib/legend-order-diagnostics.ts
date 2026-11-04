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
export interface LegendPageRecoveryDecision {
  trigger: 'rank-order' | 'mr-order' | 'duplicate-entry'
  eligible: boolean
  reason: 'eligible' | 'within-page-order' | 'recovery-already-used' | 'previous-page-missing' | 'nonadjacent-page'
    | 'within-page-rank-order' | 'within-page-mr-order' | 'within-page-duplicate' | 'earlier-page-duplicate' | 'recovery-range-too-wide'
  page: number
  previousPage: number | null
  recoveryUsed: boolean
  conflict?: { previous: LegendOrderPosition; current: LegendOrderPosition }
}
export interface LegendMissingMemberDetail {
  firstSeen: LegendOrderPosition
  lastSeen: LegendOrderPosition
  firstSeenSource: 'saved-page' | 'trigger-page' | 'range-reread' | 'right-baseline' | 'left-probe'
  observations: number
  accountPresence: 'other-character-in-range' | 'absent-from-range'
  sameAccountRowsCount: number
  sameAccountPositions: LegendOrderPosition[]
}
export interface LegendMissingEdgeProbe {
  side: 'left' | 'right'
  page: number
  unchanged: boolean | null
  missingFoundCount: number
  found: { previous: LegendOrderPosition; current: LegendOrderPosition }[]
}
export interface LegendPageRecoveryIssue {
  kind: 'fixed-prefix-duplicate' | 'recovery-range-duplicate' | 'within-page-duplicate' | 'missing-members'
  fromPage: number
  toPage: number
  conflict?: { previous: LegendOrderPosition; current: LegendOrderPosition }
  missingCount?: number
  missingPositions?: LegendOrderPosition[]
  missingDetails?: LegendMissingMemberDetail[]
  edgeProbes?: LegendMissingEdgeProbe[]
  expansion?: { fromPage: number; toPage: number }
}
export interface LegendPageRecoveryRange {
  attempt: number
  fromPage: number
  toPage: number
  lastValidatedPage: number | null
  status: 'started' | 'succeeded' | 'failed'
  issues?: LegendPageRecoveryIssue[]
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

/** Fixed eligibility reason and numeric conflict only; identity lookup maps never leave the collector. */
export function sanitizeLegendPageRecoveryDecision(value: unknown): LegendPageRecoveryDecision | undefined {
  try {
    if (!record(value)) return undefined
    const { trigger, eligible, reason, page, previousPage, recoveryUsed, conflict } = value
    if (!['rank-order', 'mr-order', 'duplicate-entry'].includes(trigger as string) || !bool(eligible)
      || !['eligible', 'within-page-order', 'recovery-already-used', 'previous-page-missing', 'nonadjacent-page',
        'within-page-rank-order', 'within-page-mr-order', 'within-page-duplicate', 'earlier-page-duplicate', 'recovery-range-too-wide'].includes(reason as string)
      || eligible !== (reason === 'eligible') || !integer(page, 1, 1000000)
      || !(previousPage === null || integer(previousPage, 1, 1000000)) || !bool(recoveryUsed)) return undefined
    const decision: LegendPageRecoveryDecision = { trigger: trigger as LegendPageRecoveryDecision['trigger'], eligible,
      reason: reason as LegendPageRecoveryDecision['reason'], page, previousPage, recoveryUsed }
    if (conflict !== undefined) {
      if (!record(conflict)) return undefined
      const previous = position(conflict.previous), current = position(conflict.current)
      if (!previous || !current) return undefined
      decision.conflict = { previous, current }
    }
    return decision
  } catch { return undefined }
}

function recoveryIssue(value: unknown): LegendPageRecoveryIssue | undefined {
  if (!record(value)) return undefined
  const { kind, fromPage, toPage, conflict, missingCount, missingPositions, missingDetails, edgeProbes, expansion } = value
  if (!['fixed-prefix-duplicate', 'recovery-range-duplicate', 'within-page-duplicate', 'missing-members'].includes(kind as string)
    || !integer(fromPage, 1, 1000000) || !integer(toPage, fromPage + 1, 1000000) || toPage - fromPage + 1 > 6) return undefined
  const issue: LegendPageRecoveryIssue = { kind: kind as LegendPageRecoveryIssue['kind'], fromPage, toPage }
  if (kind === 'missing-members') {
    if (conflict !== undefined || !integer(missingCount, 1, 20000)) return undefined
    issue.missingCount = missingCount
    if (missingPositions !== undefined) {
      if (!Array.isArray(missingPositions)) return undefined
      const length = missingPositions.length
      if (!integer(length, 0, 3) || length > missingCount) return undefined
      const positions: LegendOrderPosition[] = []
      for (let index = 0; index < length; index++) {
        const item = position(missingPositions[index])
        if (!item || item.page < fromPage || item.page > toPage) return undefined
        positions.push(item)
      }
      issue.missingPositions = positions
    }
    if (missingDetails !== undefined) {
      if (!Array.isArray(missingDetails)) return undefined
      const length = missingDetails.length
      if (!integer(length, 0, 3) || length > missingCount) return undefined
      const details: LegendMissingMemberDetail[] = []
      for (let index = 0; index < length; index++) {
        const item = missingDetails[index]
        if (!record(item)) return undefined
        const firstSeen = position(item.firstSeen), lastSeen = position(item.lastSeen)
        const { firstSeenSource, observations, accountPresence, sameAccountRowsCount, sameAccountPositions } = item
        if (!firstSeen || !lastSeen || firstSeen.page < fromPage || firstSeen.page > toPage
          || lastSeen.page < fromPage || lastSeen.page > toPage
          || !['saved-page', 'trigger-page', 'range-reread', 'right-baseline', 'left-probe'].includes(firstSeenSource as string)
          || !integer(observations, 1, 20000) || !integer(sameAccountRowsCount, 0, 120)
          || !['other-character-in-range', 'absent-from-range'].includes(accountPresence as string)
          || (accountPresence === 'absent-from-range') !== (sameAccountRowsCount === 0)
          || !Array.isArray(sameAccountPositions)) return undefined
        const positionsLength = sameAccountPositions.length
        if (!integer(positionsLength, 0, 3) || positionsLength > sameAccountRowsCount) return undefined
        const positions: LegendOrderPosition[] = []
        for (let offset = 0; offset < positionsLength; offset++) {
          const observed = position(sameAccountPositions[offset])
          if (!observed || observed.page < fromPage || observed.page > toPage) return undefined
          positions.push(observed)
        }
        details.push({ firstSeen, lastSeen, firstSeenSource: firstSeenSource as LegendMissingMemberDetail['firstSeenSource'],
          observations, accountPresence: accountPresence as LegendMissingMemberDetail['accountPresence'], sameAccountRowsCount,
          sameAccountPositions: positions })
      }
      issue.missingDetails = details
    }
    if (edgeProbes !== undefined) {
      if (!Array.isArray(edgeProbes)) return undefined
      const length = edgeProbes.length
      if (!integer(length, 0, 2)) return undefined
      const probes: LegendMissingEdgeProbe[] = []
      for (let index = 0; index < length; index++) {
        const item = edgeProbes[index]
        if (!record(item)) return undefined
        const { side, page, unchanged, missingFoundCount, found } = item
        if (!['left', 'right'].includes(side as string) || !integer(page, 1, 1000000)
          || page !== (side === 'left' ? fromPage - 1 : toPage + 1)
          || !(side === 'left' ? bool(unchanged) : unchanged === null)
          || !integer(missingFoundCount, 0, missingCount) || !Array.isArray(found)
          || probes.some(probe => probe.side === side)) return undefined
        const foundLength = found.length
        if (!integer(foundLength, 0, 3) || foundLength > missingFoundCount) return undefined
        const pairs: LegendMissingEdgeProbe['found'] = []
        for (let offset = 0; offset < foundLength; offset++) {
          const pair = found[offset]
          if (!record(pair)) return undefined
          const previous = position(pair.previous), current = position(pair.current)
          if (!previous || !current || previous.page < fromPage || previous.page > toPage || current.page !== page) return undefined
          pairs.push({ previous, current })
        }
        probes.push({ side: side as LegendMissingEdgeProbe['side'], page, unchanged: unchanged as boolean | null, missingFoundCount, found: pairs })
      }
      issue.edgeProbes = probes
    }
  } else {
    if (!record(conflict) || missingCount !== undefined || missingPositions !== undefined
      || missingDetails !== undefined || edgeProbes !== undefined) return undefined
    const previous = position(conflict.previous), current = position(conflict.current)
    if (!previous || !current || current.page < fromPage || current.page > toPage) return undefined
    if (kind === 'fixed-prefix-duplicate' && previous.page >= fromPage) return undefined
    if (kind === 'recovery-range-duplicate' && (previous.page < fromPage || previous.page >= current.page)) return undefined
    if (kind === 'within-page-duplicate' && (previous.page !== current.page || previous.rowIndex >= current.rowIndex)) return undefined
    issue.conflict = { previous, current }
  }
  if (expansion !== undefined) {
    if (!record(expansion)) return undefined
    const expandedFrom = expansion.fromPage, expandedTo = expansion.toPage
    if (!integer(expandedFrom, 1, fromPage) || !integer(expandedTo, toPage, 1000000)
      || expandedTo - expandedFrom + 1 > 6 || expandedFrom === fromPage && expandedTo === toPage) return undefined
    issue.expansion = { fromPage: expandedFrom, toPage: expandedTo }
  }
  return issue
}

export function sanitizeLegendPageRecoveryRange(value: unknown): LegendPageRecoveryRange | undefined {
  try {
    if (!record(value)) return undefined
    const { attempt, fromPage, toPage, lastValidatedPage, status, issues: rawIssues } = value
    if (!integer(attempt, 1, 3) || !integer(fromPage, 1, 1000000) || !integer(toPage, fromPage + 1, 1000000)
      || toPage - fromPage + 1 > 6 || !['started', 'succeeded', 'failed'].includes(status as string)
      || !(lastValidatedPage === null || integer(lastValidatedPage, fromPage, toPage))
      || status === 'succeeded' && lastValidatedPage !== toPage) return undefined
    const range: LegendPageRecoveryRange = { attempt, fromPage, toPage, lastValidatedPage, status: status as LegendPageRecoveryRange['status'] }
    if (rawIssues !== undefined) {
      if (!Array.isArray(rawIssues)) return undefined
      const length = rawIssues.length
      if (!integer(length, 0, 5)) return undefined
      const issues: LegendPageRecoveryIssue[] = []
      for (let index = 0; index < length; index++) {
        const issue = recoveryIssue(rawIssues[index])
        if (!issue) return undefined
        issues.push(issue)
      }
      range.issues = issues
    }
    return range
  } catch { return undefined }
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
