import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS, parseLegendAnalysisDataset, summarizeLegendMr } from '../../src/lib/legendAnalysis.ts'
import type { LegendAnalysisConditions, LegendAnalysisDataset, LegendMembershipRule } from '../../src/types/legendAnalysis.ts'
import { sanitizeLegendOrderDiagnostic, sanitizeLegendOrderRecheck, sanitizeLegendPageRecoveryDecision, sanitizeLegendPageRecoveryRange } from './legend-order-diagnostics.ts'
import type { LegendOrderDiagnostic, LegendOrderPosition, LegendOrderRecheck, LegendPageRecoveryDecision, LegendPageRecoveryIssue, LegendPageRecoveryRange } from './legend-order-diagnostics.ts'

/** Private transient row. Salted account keys are never persisted. */
export interface LegendAnalysisEntry {
  accountKey: string
  characterId: string
  rank: number
  masterRating: number
  isLegend: boolean
  /** Opt-in visible label for the separate player list; omitted by aggregate-only readers. */
  playerName?: string
  /** Opt-in public profile attributes; aggregate-only results never retain these. */
  playerId?: string
  region?: string
  platform?: string
}
export type LegendAnalysisVerifiedPlayer = Pick<LegendAnalysisEntry, 'characterId' | 'rank' | 'masterRating'> & {
  playerName: string
  playerId: string
  region: string
  platform: string
}
export interface LegendAnalysisPage {
  sourceUrl: string
  page: number
  pageSize: number
  totalCount: number
  from: number
  to: number
  nextPage: number | null
  actId: string
  conditions: LegendAnalysisConditions
  conditionsConfirmed: boolean
  actConfirmed: boolean
  rosterConfirmed: boolean
  entries: LegendAnalysisEntry[]
}
export const LEGEND_ANALYSIS_COLLECTION_ERROR_CODES = ['configuration-invalid', 'evidence-unconfirmed', 'cancelled',
  'request-limit', 'source-changed', 'duplicate-entry', 'read-failed'] as const
export type LegendAnalysisCollectionErrorCode = typeof LEGEND_ANALYSIS_COLLECTION_ERROR_CODES[number]
export const LEGEND_ANALYSIS_COLLECTION_VALIDATION_CHECKS = ['unclassified', 'configuration', 'membership-evidence', 'cancellation',
  'request-budget', 'page-identity', 'source-conditions', 'source-act', 'source-roster', 'page-size', 'pagination',
  'entry-count', 'entry-values', 'character-roster', 'first-rank', 'rank-position', 'rank-order', 'mr-order',
  'duplicate-entry', 'legend-contiguity', 'legend-presence', 'adjacent-recheck', 'end-recheck', 'start-recheck', 'terminal-coverage',
  'range-missing-members', 'range-legend-changed', 'range-recheck', 'range-anchor-recheck',
  'capture-clock', 'completion'] as const
export type LegendAnalysisValidationCheck = typeof LEGEND_ANALYSIS_COLLECTION_VALIDATION_CHECKS[number]
export const LEGEND_ANALYSIS_RECHECK_CHANGE_KINDS = ['legend-entries', 'non-legend-entries', 'metadata'] as const
export type LegendAnalysisRecheckChangeKind = typeof LEGEND_ANALYSIS_RECHECK_CHANGE_KINDS[number]
export class LegendAnalysisCollectionError extends Error {
  readonly code: LegendAnalysisCollectionErrorCode
  readonly validationCheck: LegendAnalysisValidationCheck
  readonly recheckChangeKinds?: LegendAnalysisRecheckChangeKind[]
  constructor(code: LegendAnalysisCollectionErrorCode, validationCheck: LegendAnalysisValidationCheck = 'unclassified', recheckChangeKinds?: LegendAnalysisRecheckChangeKind[]) {
    super(`レジェンド分析の取得を中止しました (${code})。`)
    this.name = 'LegendAnalysisCollectionError'; this.code = code; this.validationCheck = validationCheck
    if (recheckChangeKinds) this.recheckChangeKinds = [...recheckChangeKinds]
  }
}
function fail(code: LegendAnalysisCollectionErrorCode, check: LegendAnalysisValidationCheck, kinds?: LegendAnalysisRecheckChangeKind[]): never {
  throw new LegendAnalysisCollectionError(code, check, kinds)
}
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function stablePage(value: LegendAnalysisPage) {
  const { totalCount: _total, nextPage: _next, ...stable } = value
  return stable
}
const entryKey = (entry: LegendAnalysisEntry): string => `${entry.accountKey}:${entry.characterId}`
const entryPosition = (page: number, index: number, entry: LegendAnalysisEntry): LegendOrderPosition =>
  ({ page, rowIndex: index + 1, rank: entry.rank, masterRating: entry.masterRating })
/** A range may move members between pages while retaining each page's observed extent and conditions. */
function samePageMetadata(before: LegendAnalysisPage, after: LegendAnalysisPage): boolean {
  const { entries: _beforeEntries, ...beforeMetadata } = stablePage(before)
  const { entries: _afterEntries, ...afterMetadata } = stablePage(after)
  return equal(beforeMetadata, afterMetadata) && before.entries.length === after.entries.length
}
/** Private rows and keys are compared only in memory; the result is a fixed enum list. */
function recheckChanges(before: LegendAnalysisPage, after: LegendAnalysisPage): LegendAnalysisRecheckChangeKind[] {
  const changes: LegendAnalysisRecheckChangeKind[] = []
  const rows = (page: LegendAnalysisPage, legend: boolean) => page.entries.map((entry, index) => ({ entry, index })).filter(row => row.entry.isLegend === legend)
  if (!equal(rows(before, true), rows(after, true))) changes.push('legend-entries')
  if (!equal(rows(before, false), rows(after, false))) changes.push('non-legend-entries')
  const { entries: _beforeEntries, ...beforeMetadata } = stablePage(before)
  const { entries: _afterEntries, ...afterMetadata } = stablePage(after)
  if (!equal(beforeMetadata, afterMetadata)) changes.push('metadata')
  return changes
}

export interface CollectLegendAnalysisOptions {
  sourceUrl: string
  pageUrl(page: number): string
  fetchPage(page: number, url: string): Promise<LegendAnalysisPage>
  /** One DOM-only observation per order failure before recovery/navigation; never used to accept a page. */
  recheckOrderFailure?: (page: LegendAnalysisPage, rowIndex: number) => Promise<LegendOrderRecheck>
  /** Live reader reopens its original PLAY page before the final ranking rechecks. */
  confirmAct?: () => Promise<void>
  act: { id: string; label: string }
  conditions: LegendAnalysisConditions
  characterIds: string[]
  characterNames: Record<string, string>
  membershipRule: LegendMembershipRule
  /** Independent verified source evidence is required; no default ranking cutoff is inferred. */
  membershipConfirmed: boolean
  definitionVersion?: string
  maxRequests?: number
  maxAttempts?: number
  signal?: AbortSignal
  now?: () => Date
  /** Called when a whole-capture retry actually starts, including retries that later fail. */
  onRetry?: (retryCount: number) => void
  /** Receives fixed diagnostic fields for collection-validation failures, before retry or final throw. */
  onAttemptFailure?: (failure: LegendAnalysisAttemptFailure) => void
  /** Every bounded page-range recovery shares the collection's request budget; fixed states only, never row values. */
  onPageRecovery?: (state: 'started' | 'succeeded') => void
  onPageRecoveryRange?: (range: LegendPageRecoveryRange) => void
  onProgress?: (progress: LegendAnalysisCollectionProgress) => void
  /** Opt-in projection after complete validation; never receives account keys or non-Legend rows. */
  onVerifiedPlayers?: (players: readonly LegendAnalysisVerifiedPlayer[]) => void
}
export const LEGEND_ANALYSIS_COLLECTION_PHASES = ['preparation', 'listing', 'act-recheck', 'end-recheck', 'start-recheck', 'complete'] as const
export type LegendAnalysisCollectionPhase = typeof LEGEND_ANALYSIS_COLLECTION_PHASES[number]
export interface LegendAnalysisCollectionProgress {
  phase: LegendAnalysisCollectionPhase
  /** One-based whole-capture attempt, independent of an individual HTTP 5xx retry. */
  attempt: number
  page: number | null
}
/** No errors, URLs, identities, or names cross this boundary. Order details contain only allowlisted numbers and booleans. */
export interface LegendAnalysisAttemptFailure extends LegendAnalysisCollectionProgress {
  code: LegendAnalysisCollectionErrorCode
  validationCheck: LegendAnalysisValidationCheck
  recheckChangeKinds: LegendAnalysisRecheckChangeKind[] | null
  orderDiagnostic?: LegendOrderDiagnostic
  orderRecheck?: LegendOrderRecheck
  pageRecoveryDecision?: LegendPageRecoveryDecision
}
export interface LegendAnalysisCollectionResult {
  dataset: LegendAnalysisDataset
  requestCount: number
  retryCount: number
  pagesRead: number
}

/** Exhaustive Legend-prefix capture, with finite whole-capture retries and endpoint rechecks. */
export async function collectLegendAnalysisDataset(options: CollectLegendAnalysisOptions): Promise<LegendAnalysisCollectionResult> {
  const maxRequests = options.maxRequests ?? 120, maxAttempts = options.maxAttempts ?? 2
  if (!integer(maxRequests, 3) || maxRequests > 1000 || !integer(maxAttempts, 1) || maxAttempts > 3
    || options.sourceUrl !== LEGEND_ANALYSIS_SOURCE.url || !options.act?.id || !options.act.label
    || !Array.isArray(options.characterIds) || !options.characterIds.length || new Set(options.characterIds).size !== options.characterIds.length
    || !options.characterNames || options.characterIds.some(id => typeof options.characterNames[id] !== 'string' || !options.characterNames[id])
    || !['official-legend-badge', 'official-ranking-cutoff'].includes(options.membershipRule)) fail('configuration-invalid', 'configuration')
  if (options.membershipConfirmed !== true) fail('evidence-unconfirmed', 'membership-evidence')
  let requestCount = 0
  // Historical diagnostic only: any earlier range started in this run, including earlier whole attempts.
  let pageRecoveryUsed = false
  let pageRecoveryDecision: LegendPageRecoveryDecision | undefined
  let captureAttempt = 0
  let currentPhase: LegendAnalysisCollectionPhase = 'preparation'
  let currentPage: number | null = null
  const now = options.now ?? (() => new Date())
  const clock = (): string => { try { return now().toISOString() } catch { return fail('configuration-invalid', 'capture-clock') } }
  const cancelled = (): void => { if (options.signal?.aborted) fail('cancelled', 'cancellation') }
  const progress = (phase: LegendAnalysisCollectionPhase, page: number | null): void => {
    currentPhase = phase
    currentPage = page
    options.onProgress?.({ phase, attempt: captureAttempt, page })
  }
  const attemptFailed = (error: LegendAnalysisCollectionError, diagnostic?: LegendOrderDiagnostic, recheck?: LegendOrderRecheck): void => {
    const kinds = error.recheckChangeKinds
    const orderDiagnostic = sanitizeLegendOrderDiagnostic(diagnostic), orderRecheck = sanitizeLegendOrderRecheck(recheck)
    const recoveryDecision = sanitizeLegendPageRecoveryDecision(pageRecoveryDecision)
    const failure: LegendAnalysisAttemptFailure = {
      attempt: captureAttempt, phase: currentPhase,
      page: integer(currentPage, 1) && currentPage <= 1000000 ? currentPage : null,
      code: LEGEND_ANALYSIS_COLLECTION_ERROR_CODES.includes(error.code) ? error.code : 'read-failed',
      validationCheck: LEGEND_ANALYSIS_COLLECTION_VALIDATION_CHECKS.includes(error.validationCheck) ? error.validationCheck : 'unclassified',
      recheckChangeKinds: Array.isArray(kinds) && kinds.length >= 1 && kinds.length <= LEGEND_ANALYSIS_RECHECK_CHANGE_KINDS.length
        && new Set(kinds).size === kinds.length && kinds.every(kind => LEGEND_ANALYSIS_RECHECK_CHANGE_KINDS.includes(kind)) ? [...kinds] : null,
      ...(orderDiagnostic ? { orderDiagnostic } : {}), ...(orderRecheck ? { orderRecheck } : {}),
      ...(recoveryDecision ? { pageRecoveryDecision: recoveryDecision } : {}),
    }
    // Diagnostics must not change the collection's retry decision or replace its original error.
    try { options.onAttemptFailure?.(failure) } catch {}
  }
  const pageRecovery = (state: 'started' | 'succeeded'): void => {
    try { options.onPageRecovery?.(state) } catch { /* Diagnostic failures cannot change acceptance. */ }
  }
  const reportRecoveryRange = (range: LegendPageRecoveryRange): void => {
    const safe = sanitizeLegendPageRecoveryRange(range)
    try { if (safe) options.onPageRecoveryRange?.(safe) } catch { /* Diagnostics cannot change acceptance. */ }
  }
  const read = async (page: number, phase: LegendAnalysisCollectionPhase = 'listing'): Promise<LegendAnalysisPage> => {
    cancelled()
    progress(phase, page)
    if (requestCount >= maxRequests) fail('request-limit', 'request-budget')
    const url = options.pageUrl(page)
    requestCount++
    const value = await options.fetchPage(page, url)
    cancelled()
    if (!value || value.sourceUrl !== url || value.page !== page) fail('source-changed', 'page-identity')
    if (value.conditionsConfirmed !== true || !equal(value.conditions, options.conditions)) fail('source-changed', 'source-conditions')
    if (value.actConfirmed !== true || value.actId !== options.act.id) fail('source-changed', 'source-act')
    if (value.rosterConfirmed !== true) fail('source-changed', 'source-roster')
    if (!integer(value.pageSize, 1) || value.pageSize > 20) fail('source-changed', 'page-size')
    if (!integer(value.totalCount, 1) || !integer(value.from, 1) || !integer(value.to, 1)
      || value.from !== (page - 1) * value.pageSize + 1 || value.to !== Math.min(page * value.pageSize, value.totalCount)
      || value.to < value.from || value.nextPage !== (value.to < value.totalCount ? page + 1 : null)) fail('source-changed', 'pagination')
    if (!Array.isArray(value.entries) || value.entries.length !== value.to - value.from + 1) fail('source-changed', 'entry-count')
    for (const entry of value.entries) {
      if (!entry || !integer(entry.rank, 1) || !integer(entry.masterRating) || typeof entry.isLegend !== 'boolean'
        || !options.characterIds.includes(entry.characterId) || typeof entry.accountKey !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.accountKey)) {
        if (entry && !options.characterIds.includes(entry.characterId)) fail('source-changed', 'character-roster')
        fail('source-changed', 'entry-values')
      }
      if (options.onVerifiedPlayers && entry.isLegend && (typeof entry.playerName !== 'string'
        || !entry.playerName.trim() || entry.playerName !== entry.playerName.trim() || entry.playerName.length > 128
        || /\p{Cc}/u.test(entry.playerName)
        || typeof entry.playerId !== 'string' || !/^\d{1,20}$/.test(entry.playerId)
        || [entry.region, entry.platform].some(value => typeof value !== 'string' || !value.trim()
          || value !== value.trim() || value.length > 64 || /\p{Cc}/u.test(value)))) fail('evidence-unconfirmed', 'entry-values')
    }
    return value
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    cancelled()
    captureAttempt = attempt + 1
    pageRecoveryDecision = undefined
    currentPhase = 'preparation'; currentPage = null
    if (attempt > 0) options.onRetry?.(attempt)
    const startedAt = clock()
    let orderFailure: { error: LegendAnalysisCollectionError; page: LegendAnalysisPage; rowIndex: number; diagnostic: LegendOrderDiagnostic;
      observed?: boolean; reported?: boolean; recheck?: LegendOrderRecheck } | undefined
    const observeOrderFailure = async (): Promise<void> => {
      const failure = orderFailure
      if (!failure || failure.observed) return
      // Mark before awaiting so the original document is never observed twice or after a recovery navigation.
      failure.observed = true
      if (!options.recheckOrderFailure) return
      try {
        cancelled()
        failure.recheck = sanitizeLegendOrderRecheck(await options.recheckOrderFailure(failure.page, failure.rowIndex)) ?? { status: 'failed' }
        cancelled()
      } catch (error) {
        failure.recheck = { status: 'failed' }
        attemptFailed(failure.error, failure.diagnostic, failure.recheck)
        failure.reported = true
        throw error
      }
    }
    try {
      let first = await read(1), current = first
      interface Prefix {
        accepted: LegendAnalysisEntry[]
        seen: Set<string>
        positions: Map<string, LegendOrderPosition>
        previous: LegendAnalysisEntry | null
        boundary: boolean
        previousPage: LegendAnalysisPage | null
      }
      let prefix: Prefix = { accepted: [], seen: new Set(), positions: new Map(), previous: null, boundary: false, previousPage: null }
      // Immutable snapshots let a bounded range be rebuilt without changing any accepted rows until validation completes.
      const savedPages = new Map<number, LegendAnalysisPage>()
      const prefixes = new Map<number, Prefix>([[0, prefix]])
      let pagesRead = 0
      // Validate a whole candidate before mutating any accepted prefix, including its last row and Legend boundary.
      const inspect = (page: LegendAnalysisPage, base: Prefix) => {
        if (page.pageSize !== first.pageSize) fail('source-changed', 'page-size')
        const keys = new Set<string>(), additions: LegendAnalysisEntry[] = []
        const positions = new Map<string, LegendOrderPosition>()
        let withinPageDuplicateConflict: LegendPageRecoveryDecision['conflict'], earlierPageDuplicateConflict: LegendPageRecoveryDecision['conflict']
        const precedingKeys = new Set(base.previousPage?.entries.map(entryKey) ?? [])
        let nextPrevious = base.previous, nextBoundary = base.boundary, duplicate = false, withinPageDuplicate = false, earlierPageDuplicate = false
        for (const [index, entry] of page.entries.entries()) {
          if (page.page === 1 && index === 0 && entry.rank !== 1) fail('source-changed', 'first-rank')
          if (entry.rank > page.from + index) fail('source-changed', 'rank-position')
          const key = entryKey(entry)
          const orderCheck = nextPrevious && (entry.rank < nextPrevious.rank ? 'rank-order'
            : entry.masterRating > nextPrevious.masterRating ? 'mr-order' : null)
          if (nextPrevious && orderCheck) {
            const error = new LegendAnalysisCollectionError('source-changed', orderCheck)
            orderFailure ??= { error, page, rowIndex: index + 1, diagnostic: {
              boundary: index === 0 ? 'between-pages' : 'within-page',
              previous: { page: index === 0 ? base.previousPage!.page : page.page,
                rowIndex: index === 0 ? base.previousPage!.entries.length : index,
                rank: nextPrevious.rank, masterRating: nextPrevious.masterRating },
              current: { page: page.page, rowIndex: index + 1, rank: entry.rank, masterRating: entry.masterRating },
              sameEntry: key === entryKey(nextPrevious),
              duplicateInAccepted: base.seen.has(key), duplicateWithinCurrentPage: keys.has(key),
            } }
            throw error
          }
          const currentPosition = entryPosition(page.page, index, entry)
          if (keys.has(key)) {
            duplicate = true; withinPageDuplicate = true
            withinPageDuplicateConflict ??= { previous: positions.get(key)!, current: currentPosition }
          }
          if (base.seen.has(key)) {
            duplicate = true
            if (!precedingKeys.has(key)) {
              earlierPageDuplicate = true
              earlierPageDuplicateConflict ??= { previous: base.positions.get(key)!, current: currentPosition }
            }
          }
          keys.add(key)
          if (!positions.has(key)) positions.set(key, currentPosition)
          if (!entry.isLegend) nextBoundary = true
          else {
            if (nextBoundary) fail('source-changed', 'legend-contiguity')
            additions.push(entry)
          }
          nextPrevious = entry
        }
        return { keys, positions, additions, nextPrevious, nextBoundary, duplicate, withinPageDuplicate, earlierPageDuplicate,
          withinPageDuplicateConflict, earlierPageDuplicateConflict }
      }
      const appendPage = (base: Prefix, page: LegendAnalysisPage, candidate: ReturnType<typeof inspect>): Prefix => ({
        accepted: [...base.accepted, ...candidate.additions], seen: new Set([...base.seen, ...candidate.keys]),
        positions: new Map([...base.positions, ...candidate.positions]),
        previous: candidate.nextPrevious, boundary: candidate.nextBoundary, previousPage: page,
      })
      const internalOrderConflict = (page: LegendAnalysisPage): Pick<LegendPageRecoveryDecision, 'reason' | 'conflict'> | undefined => {
        const positions = new Map<string, LegendOrderPosition>()
        for (const [index, entry] of page.entries.entries()) {
          const key = entryKey(entry), prior = page.entries[index - 1]
          const current = entryPosition(page.page, index, entry)
          if (prior && entry.rank < prior.rank) return { reason: 'within-page-rank-order', conflict: { previous: entryPosition(page.page, index - 1, prior), current } }
          if (prior && entry.masterRating > prior.masterRating) return { reason: 'within-page-mr-order', conflict: { previous: entryPosition(page.page, index - 1, prior), current } }
          if (positions.has(key)) return { reason: 'within-page-duplicate', conflict: { previous: positions.get(key)!, current } }
          positions.set(key, current)
        }
        return undefined
      }
      const recoveryStart = (page: LegendAnalysisPage): { fromPage: number; conflict?: LegendPageRecoveryDecision['conflict'] } => {
        let fromPage = page.page - 1
        let conflict: LegendPageRecoveryDecision['conflict']
        for (const [index, entry] of page.entries.entries()) {
          const previous = prefix.positions.get(entryKey(entry))
          if (previous && (previous.page < fromPage || previous.page === fromPage && !conflict)) {
            fromPage = previous.page
            conflict = { previous, current: entryPosition(page.page, index, entry) }
          }
        }
        return { fromPage, ...(conflict ? { conflict } : {}) }
      }
      while (true) {
        pagesRead++
        const previousPage = prefix.previousPage
        const rangeStart = recoveryStart(current)
        const tooWide = current.page - rangeStart.fromPage + 1 > 6
        let candidate: ReturnType<typeof inspect> | undefined
        try { candidate = inspect(current, prefix) } catch (error) {
          if (!orderFailure || error !== orderFailure.error) throw error
          const rejection: Pick<LegendPageRecoveryDecision, 'reason' | 'conflict'> | undefined =
            orderFailure.diagnostic.boundary !== 'between-pages' ? { reason: 'within-page-order', conflict: {
              previous: orderFailure.diagnostic.previous, current: orderFailure.diagnostic.current } }
            : !previousPage ? { reason: 'previous-page-missing' }
              : previousPage.page + 1 !== current.page ? { reason: 'nonadjacent-page' } : internalOrderConflict(current)
                ?? (tooWide ? { reason: 'recovery-range-too-wide', conflict: rangeStart.conflict } : undefined)
          pageRecoveryDecision = { trigger: orderFailure.error.validationCheck as 'rank-order' | 'mr-order', eligible: !rejection,
            reason: 'eligible', page: current.page, previousPage: previousPage?.page ?? null, recoveryUsed: pageRecoveryUsed, ...rejection }
          if (rejection) throw error
        }
        if (!candidate || candidate.duplicate) {
          if (candidate) {
            const rejection: Pick<LegendPageRecoveryDecision, 'reason' | 'conflict'> | undefined =
              !previousPage ? { reason: 'previous-page-missing' }
                : previousPage.page + 1 !== current.page ? { reason: 'nonadjacent-page' }
                  : candidate.withinPageDuplicate ? { reason: 'within-page-duplicate', conflict: candidate.withinPageDuplicateConflict }
                    : tooWide ? { reason: 'recovery-range-too-wide', conflict: rangeStart.conflict } : undefined
            pageRecoveryDecision = { trigger: 'duplicate-entry', eligible: !rejection, reason: 'eligible', page: current.page,
              previousPage: previousPage?.page ?? null, recoveryUsed: pageRecoveryUsed, ...rejection }
          }
          if (!previousPage || previousPage.page + 1 !== current.page || candidate?.withinPageDuplicate || tooWide) {
            fail('duplicate-entry', 'duplicate-entry')
          }
          let fromPage = rangeStart.fromPage, toPage = current.page
          const requiredReads = toPage - fromPage + 1 + (fromPage > 1 ? 1 : 0)
          if (requestCount + requiredReads > maxRequests) fail('request-limit', 'request-budget')
          // Preserve the original document before any range/anchor navigation.
          await observeOrderFailure()
          pageRecoveryUsed = true
          pageRecovery('started')
          const range: LegendPageRecoveryRange = { attempt: captureAttempt, fromPage, toPage, lastValidatedPage: null, status: 'started' }
          reportRecoveryRange(range)
          try {
            const oldPages = new Map<number, LegendAnalysisPage>()
            const requiredMembers = new Map<string, boolean>()
            const requiredPositions = new Map<string, LegendOrderPosition>()
            const rememberMembers = (page: LegendAnalysisPage): void => {
              for (const [index, entry] of page.entries.entries()) {
                const key = entryKey(entry)
                if (requiredMembers.has(key) && requiredMembers.get(key) !== entry.isLegend) fail('source-changed', 'range-legend-changed')
                requiredMembers.set(key, entry.isLegend)
                if (!requiredPositions.has(key)) requiredPositions.set(key, entryPosition(page.page, index, entry))
              }
            }
            const rememberSource = (page: LegendAnalysisPage): void => {
              rememberMembers(page)
              oldPages.set(page.page, page)
            }
            for (let number = fromPage; number <= toPage; number++) {
              const oldPage = number === toPage ? current : savedPages.get(number)
              if (!oldPage) fail('source-changed', 'range-recheck')
              rememberSource(oldPage)
            }
            const recordIssue = (issue: LegendPageRecoveryIssue): void => {
              range.issues ??= []
              range.issues.push(issue)
            }
            const expand = async (issue: LegendPageRecoveryIssue, nextFrom: number, nextTo: number): Promise<void> => {
              recordIssue(issue)
              const missing = issue.kind === 'missing-members'
              if (nextFrom > fromPage || nextTo < toPage || nextFrom === fromPage && nextTo === toPage || nextTo - nextFrom + 1 > 6) {
                fail(missing ? 'source-changed' : 'duplicate-entry', missing ? 'range-missing-members' : 'duplicate-entry')
              }
              const extraReads = nextTo - toPage + (nextTo - nextFrom + 1) + (nextFrom > 1 ? 1 : 0)
              if (requestCount + extraReads > maxRequests) fail('request-limit', 'request-budget')
              // The expansion is approved only after reserving its new baselines, full recapture and left anchor.
              issue.expansion = { fromPage: nextFrom, toPage: nextTo }
              const oldFrom = fromPage, oldTo = toPage
              fromPage = nextFrom; toPage = nextTo
              Object.assign(range, { fromPage, toPage, lastValidatedPage: null })
              reportRecoveryRange(range)
              for (let number = fromPage; number < oldFrom; number++) {
                const original = savedPages.get(number)
                if (!original) fail('source-changed', 'range-recheck')
                rememberSource(original)
              }
              // Future pages have no accepted snapshot. Retain every row from their first observation before recapturing.
              for (let number = oldTo + 1; number <= toPage; number++) {
                const baseline = await read(number)
                const internal = inspect(baseline, prefixes.get(0)!)
                if (internal.withinPageDuplicate) {
                  recordIssue({ kind: 'within-page-duplicate', fromPage, toPage, conflict: internal.withinPageDuplicateConflict! })
                  fail('duplicate-entry', 'duplicate-entry')
                }
                rememberSource(baseline)
              }
            }
            while (true) {
              const fixedPrefix = prefixes.get(fromPage - 1)
              if (!fixedPrefix) fail('source-changed', 'range-recheck')
              let rebuilt = fixedPrefix, expanded = false
              const replacements = new Map<number, { page: LegendAnalysisPage; prefix: Prefix }>()
              const newMembers = new Set<string>()
              for (let number = fromPage; number <= toPage; number++) {
                const oldPage = oldPages.get(number)!
                const replacement = await read(number)
                if (!samePageMetadata(oldPage, replacement)) fail('source-changed', 'range-recheck', recheckChanges(oldPage, replacement))
                // Rows seen in an unsuccessful pass must not silently disappear during a later expansion.
                rememberMembers(replacement)
                const internal = inspect(replacement, prefixes.get(0)!)
                if (internal.withinPageDuplicate) {
                  recordIssue({ kind: 'within-page-duplicate', fromPage, toPage, conflict: internal.withinPageDuplicateConflict! })
                  fail('duplicate-entry', 'duplicate-entry')
                }
                let fixedConflict: LegendPageRecoveryIssue['conflict'], rebuildingConflict: LegendPageRecoveryIssue['conflict']
                for (const [index, entry] of replacement.entries.entries()) {
                  const previous = rebuilt.positions.get(entryKey(entry))
                  if (!previous) continue
                  const conflict = { previous, current: entryPosition(number, index, entry) }
                  if (previous.page >= fromPage) rebuildingConflict ??= conflict
                  else if (!fixedConflict || previous.page < fixedConflict.previous.page) fixedConflict = conflict
                }
                if (rebuildingConflict) {
                  recordIssue({ kind: 'recovery-range-duplicate', fromPage, toPage, conflict: rebuildingConflict })
                  fail('duplicate-entry', 'duplicate-entry')
                }
                if (fixedConflict) {
                  await expand({ kind: 'fixed-prefix-duplicate', fromPage, toPage, conflict: fixedConflict }, fixedConflict.previous.page, toPage)
                  expanded = true; break
                }
                const replacementCandidate = inspect(replacement, rebuilt)
                rebuilt = appendPage(rebuilt, replacement, replacementCandidate)
                replacements.set(number, { page: replacement, prefix: rebuilt })
                for (const entry of replacement.entries) newMembers.add(entryKey(entry))
                range.lastValidatedPage = number
                reportRecoveryRange(range)
              }
              if (expanded) continue
              const missing = [...requiredMembers.keys()].filter(key => !newMembers.has(key))
              if (missing.length) {
                // Missing positions do not reveal which way players moved. Expand both available sides, never guess one.
                const last = replacements.get(toPage)!.page
                await expand({ kind: 'missing-members', fromPage, toPage, missingCount: missing.length,
                  missingPositions: missing.slice(0, 3).map(key => requiredPositions.get(key)!) }, Math.max(1, fromPage - 1), last.nextPage ?? toPage)
                continue
              }
              if (fromPage > 1) {
                const anchor = savedPages.get(fromPage - 1)
                if (!anchor) fail('source-changed', 'range-anchor-recheck')
                const anchorAgain = await read(fromPage - 1)
                if (!equal(stablePage(anchor), stablePage(anchorAgain))) fail('source-changed', 'range-anchor-recheck', recheckChanges(anchor, anchorAgain))
              }
              // Only the complete expanded range can replace accepted rows, after membership, order and anchor validation.
              prefix = rebuilt
              for (const [number, replacement] of replacements) {
                savedPages.set(number, replacement.page); prefixes.set(number, replacement.prefix)
              }
              pagesRead += toPage - current.page
              current = replacements.get(toPage)!.page
              if (fromPage === 1) first = replacements.get(1)!.page
              pageRecovery('succeeded')
              range.status = 'succeeded'; reportRecoveryRange(range)
              orderFailure = undefined
              pageRecoveryDecision = undefined
              break
            }
          } catch (error) {
            range.status = 'failed'; reportRecoveryRange(range)
            throw error
          }
        } else {
          prefix = appendPage(prefix, current, candidate)
          savedPages.set(current.page, current); prefixes.set(current.page, prefix)
        }
        if (prefix.boundary || current.nextPage === null) break
        current = await read(current.nextPage)
      }
      const { accepted, boundary } = prefix
      if (!accepted.length) fail('evidence-unconfirmed', 'legend-presence')
      // Re-read the last observed page and then the start; comparison includes every private row.
      progress('act-recheck', null)
      await options.confirmAct?.()
      const lastAgain = await read(current.page, 'end-recheck')
      if (!equal(stablePage(current), stablePage(lastAgain))) fail('source-changed', 'end-recheck', recheckChanges(current, lastAgain))
      if (!boundary && lastAgain.nextPage !== null) fail('source-changed', 'terminal-coverage', ['metadata'])
      const firstAgain = await read(1, 'start-recheck')
      if (!equal(stablePage(first), stablePage(firstAgain))) fail('source-changed', 'start-recheck', recheckChanges(first, firstAgain))
      const endedAt = clock()
      if (Date.parse(endedAt) < Date.parse(startedAt)) fail('configuration-invalid', 'capture-clock')
      const dataset = parseLegendAnalysisDataset({
        schemaVersion: 1, id: `legend-${startedAt.replace(/[:.]/g, '-')}`, captureStartedAt: startedAt,
        captureEndedAt: endedAt, generatedAt: endedAt, source: { ...LEGEND_ANALYSIS_SOURCE,
          population: '公式MRランキングにレジェンドとして掲載されたアカウント×キャラクターのエントリー',
          metric: '掲載エントリーのキャラクター構成とMR分布', unit: 'account-character',
          notes: ['構成比は対戦試合数に基づく使用率ではない。',
            options.membershipRule === 'official-legend-badge'
              ? '公式のLEGEND画像 rank37_l.png が付いた掲載行を対象とし、掲載順位や件数を500で打ち切っていない。'
              : '独立に確認済みの公式掲載条件で対象行を判定し、掲載件数を推測していない。',
            '取得期間内の掲載断面であり、同一人物の追跡や各対戦時点の所属を表さない。'] },
        act: options.act, definitionVersion: options.definitionVersion ?? 'legend-listed-v1', membershipRule: options.membershipRule,
        conditions: options.conditions, totalCount: accepted.length, characterIds: options.characterIds,
        characters: options.characterIds.map(characterId => { const rows = accepted.filter(value => value.characterId === characterId)
          return { characterId, name: options.characterNames[characterId], count: rows.length, mr: summarizeLegendMr(rows.map(value => value.masterRating)) } }),
        mr: summarizeLegendMr(accepted.map(value => value.masterRating)), validation: { status: 'verified',
          coverage: 'all-listed-legend-entries', checks: [...LEGEND_ANALYSIS_VALIDATION_CHECKS],
          notes: ['全ページの条件・Act・掲載判定・表示範囲・順位・MR順・アカウント×キャラクター重複を検証した。',
            'レジェンド掲載の終端と先頭を再確認した。取得時点が異なる全行の同時点性を保証するものではない。',
            'プレイヤー名、識別子、プロフィールリンク、行データ、照合用一時ハッシュは保存していない。'] },
      })
      options.onVerifiedPlayers?.(accepted.map(({ playerName, playerId, region, platform, characterId, rank, masterRating }) => ({
        playerName: playerName!, playerId: playerId!, region: region!, platform: platform!, characterId, rank, masterRating,
      })))
      progress('complete', null)
      return { dataset, requestCount, retryCount: attempt, pagesRead }
    } catch (error) {
      if (orderFailure) {
        if (!orderFailure.reported) {
          if (error === orderFailure.error) await observeOrderFailure()
          attemptFailed(error instanceof LegendAnalysisCollectionError ? error : orderFailure.error,
            orderFailure.diagnostic, orderFailure.recheck)
        }
      } else {
        if (options.signal?.aborted) {
          if (pageRecoveryDecision) attemptFailed(new LegendAnalysisCollectionError('cancelled', 'cancellation'))
          fail('cancelled', 'cancellation')
        }
        if (error instanceof LegendAnalysisCollectionError) attemptFailed(error)
        else if (pageRecoveryDecision) attemptFailed(new LegendAnalysisCollectionError('read-failed'))
      }
      if (!(error instanceof LegendAnalysisCollectionError)
        || !['source-changed', 'duplicate-entry'].includes(error.code) || attempt + 1 >= maxAttempts) throw error
    }
  }
  return fail('read-failed', 'completion')
}
