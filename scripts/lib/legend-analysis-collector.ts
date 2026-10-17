import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS, parseLegendAnalysisDataset, summarizeLegendMr } from '../../src/lib/legendAnalysis.ts'
import type { LegendAnalysisConditions, LegendAnalysisDataset, LegendMembershipRule } from '../../src/types/legendAnalysis.ts'

/** Private transient row. Neither rows nor salted account keys may be persisted. */
export interface LegendAnalysisEntry {
  accountKey: string
  characterId: string
  rank: number
  masterRating: number
  isLegend: boolean
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
  'duplicate-entry', 'legend-contiguity', 'legend-presence', 'end-recheck', 'start-recheck', 'terminal-coverage',
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
  onProgress?: (progress: LegendAnalysisCollectionProgress) => void
}
export const LEGEND_ANALYSIS_COLLECTION_PHASES = ['preparation', 'listing', 'act-recheck', 'end-recheck', 'start-recheck', 'complete'] as const
export type LegendAnalysisCollectionPhase = typeof LEGEND_ANALYSIS_COLLECTION_PHASES[number]
export interface LegendAnalysisCollectionProgress {
  phase: LegendAnalysisCollectionPhase
  /** One-based whole-capture attempt, independent of an individual HTTP 5xx retry. */
  attempt: number
  page: number | null
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
  let captureAttempt = 0
  const now = options.now ?? (() => new Date())
  const clock = (): string => { try { return now().toISOString() } catch { return fail('configuration-invalid', 'capture-clock') } }
  const cancelled = (): void => { if (options.signal?.aborted) fail('cancelled', 'cancellation') }
  const progress = (phase: LegendAnalysisCollectionPhase, page: number | null): void => {
    options.onProgress?.({ phase, attempt: captureAttempt, page })
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
    }
    return value
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    cancelled()
    captureAttempt = attempt + 1
    if (attempt > 0) options.onRetry?.(attempt)
    const startedAt = clock()
    try {
      const first = await read(1)
      const accepted: LegendAnalysisEntry[] = []
      const seen = new Set<string>()
      let current = first, previous: LegendAnalysisEntry | null = null, boundary = false
      let pagesRead = 0
      while (true) {
        pagesRead++
        if (current.pageSize !== first.pageSize) fail('source-changed', 'page-size')
        for (const [index, entry] of current.entries.entries()) {
          if (current.page === 1 && index === 0 && entry.rank !== 1) fail('source-changed', 'first-rank')
          if (entry.rank > current.from + index) fail('source-changed', 'rank-position')
          if (previous && entry.rank < previous.rank) fail('source-changed', 'rank-order')
          if (previous && entry.masterRating > previous.masterRating) fail('source-changed', 'mr-order')
          const key = `${entry.accountKey}:${entry.characterId}`
          if (seen.has(key)) fail('duplicate-entry', 'duplicate-entry')
          seen.add(key)
          if (!entry.isLegend) boundary = true
          else {
            if (boundary) fail('source-changed', 'legend-contiguity')
            accepted.push(entry)
          }
          previous = entry
        }
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
      progress('complete', null)
      return { dataset, requestCount, retryCount: attempt, pagesRead }
    } catch (error) {
      if (options.signal?.aborted) fail('cancelled', 'cancellation')
      if (!(error instanceof LegendAnalysisCollectionError)
        || !['source-changed', 'duplicate-entry'].includes(error.code) || attempt + 1 >= maxAttempts) throw error
    }
  }
  return fail('read-failed', 'completion')
}
