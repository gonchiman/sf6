import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS, parseLegendAnalysisDataset, summarizeLegendMr } from '../../src/lib/legendAnalysis.ts'
import type { LegendAnalysisConditions, LegendAnalysisDataset, LegendMembershipRule } from '../../src/types/legendAnalysis.ts'

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
  /** At most one adjacent-page recovery across all attempts; fixed states only, never row values. */
  onPageRecovery?: (state: 'started' | 'succeeded') => void
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
/** No errors, URLs, identities, names, or observed row values cross this boundary. */
export interface LegendAnalysisAttemptFailure extends LegendAnalysisCollectionProgress {
  code: LegendAnalysisCollectionErrorCode
  validationCheck: LegendAnalysisValidationCheck
  recheckChangeKinds: LegendAnalysisRecheckChangeKind[] | null
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
  let pageRecoveryUsed = false
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
  const attemptFailed = (error: LegendAnalysisCollectionError): void => {
    const kinds = error.recheckChangeKinds
    const failure: LegendAnalysisAttemptFailure = {
      attempt: captureAttempt, phase: currentPhase,
      page: integer(currentPage, 1) && currentPage <= 1000000 ? currentPage : null,
      code: LEGEND_ANALYSIS_COLLECTION_ERROR_CODES.includes(error.code) ? error.code : 'read-failed',
      validationCheck: LEGEND_ANALYSIS_COLLECTION_VALIDATION_CHECKS.includes(error.validationCheck) ? error.validationCheck : 'unclassified',
      recheckChangeKinds: Array.isArray(kinds) && kinds.length >= 1 && kinds.length <= LEGEND_ANALYSIS_RECHECK_CHANGE_KINDS.length
        && new Set(kinds).size === kinds.length && kinds.every(kind => LEGEND_ANALYSIS_RECHECK_CHANGE_KINDS.includes(kind)) ? [...kinds] : null,
    }
    // Diagnostics must not change the collection's retry decision or replace its original error.
    try { options.onAttemptFailure?.(failure) } catch {}
  }
  const pageRecovery = (state: 'started' | 'succeeded'): void => {
    try { options.onPageRecovery?.(state) } catch { /* Diagnostic failures cannot change acceptance. */ }
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
    currentPhase = 'preparation'; currentPage = null
    if (attempt > 0) options.onRetry?.(attempt)
    const startedAt = clock()
    try {
      const first = await read(1)
      const accepted: LegendAnalysisEntry[] = []
      const seen = new Set<string>()
      let current = first, previous: LegendAnalysisEntry | null = null, boundary = false
      let previousPage: LegendAnalysisPage | null = null
      let pagesRead = 0
      // Validate a whole candidate before mutating any accepted prefix, including its last row and Legend boundary.
      const inspect = (page: LegendAnalysisPage) => {
        if (page.pageSize !== first.pageSize) fail('source-changed', 'page-size')
        const keys = new Set<string>(), additions: LegendAnalysisEntry[] = []
        const precedingKeys = new Set(previousPage?.entries.map(entry => `${entry.accountKey}:${entry.characterId}`) ?? [])
        let nextPrevious = previous, nextBoundary = boundary, duplicate = false, withinPageDuplicate = false, earlierPageDuplicate = false
        for (const [index, entry] of page.entries.entries()) {
          if (page.page === 1 && index === 0 && entry.rank !== 1) fail('source-changed', 'first-rank')
          if (entry.rank > page.from + index) fail('source-changed', 'rank-position')
          if (nextPrevious && entry.rank < nextPrevious.rank) fail('source-changed', 'rank-order')
          if (nextPrevious && entry.masterRating > nextPrevious.masterRating) fail('source-changed', 'mr-order')
          const key = `${entry.accountKey}:${entry.characterId}`
          if (keys.has(key)) { duplicate = true; withinPageDuplicate = true }
          if (seen.has(key)) { duplicate = true; if (!precedingKeys.has(key)) earlierPageDuplicate = true }
          keys.add(key)
          if (!entry.isLegend) nextBoundary = true
          else {
            if (nextBoundary) fail('source-changed', 'legend-contiguity')
            additions.push(entry)
          }
          nextPrevious = entry
        }
        return { keys, additions, nextPrevious, nextBoundary, duplicate, withinPageDuplicate, earlierPageDuplicate }
      }
      while (true) {
        pagesRead++
        let candidate = inspect(current)
        if (candidate.duplicate) {
          if (pageRecoveryUsed || !previousPage || previousPage.page + 1 !== current.page || candidate.withinPageDuplicate || candidate.earlierPageDuplicate) {
            fail('duplicate-entry', 'duplicate-entry')
          }
          pageRecoveryUsed = true
          pageRecovery('started')
          const adjacentAgain = await read(previousPage.page)
          if (!equal(stablePage(previousPage), stablePage(adjacentAgain))) fail('source-changed', 'adjacent-recheck', recheckChanges(previousPage, adjacentAgain))
          current = await read(current.page)
          candidate = inspect(current)
          if (candidate.duplicate) fail('duplicate-entry', 'duplicate-entry')
          pageRecovery('succeeded')
        }
        for (const key of candidate.keys) seen.add(key)
        accepted.push(...candidate.additions)
        previous = candidate.nextPrevious; boundary = candidate.nextBoundary; previousPage = current
        if (boundary || current.nextPage === null) break
        current = await read(current.nextPage)
      }
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
      if (options.signal?.aborted) fail('cancelled', 'cancellation')
      if (error instanceof LegendAnalysisCollectionError) attemptFailed(error)
      if (!(error instanceof LegendAnalysisCollectionError)
        || !['source-changed', 'duplicate-entry'].includes(error.code) || attempt + 1 >= maxAttempts) throw error
    }
  }
  return fail('read-failed', 'completion')
}
