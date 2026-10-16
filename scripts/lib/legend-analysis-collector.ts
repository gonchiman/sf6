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
export type LegendAnalysisCollectionErrorCode = 'configuration-invalid' | 'evidence-unconfirmed' | 'cancelled'
  | 'request-limit' | 'source-changed' | 'duplicate-entry' | 'read-failed'
export class LegendAnalysisCollectionError extends Error {
  readonly code: LegendAnalysisCollectionErrorCode
  constructor(code: LegendAnalysisCollectionErrorCode) {
    super(`レジェンド分析の取得を中止しました (${code})。`)
    this.name = 'LegendAnalysisCollectionError'; this.code = code
  }
}
function fail(code: LegendAnalysisCollectionErrorCode): never { throw new LegendAnalysisCollectionError(code) }
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function stablePage(value: LegendAnalysisPage) {
  const { totalCount: _total, nextPage: _next, ...stable } = value
  return stable
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
    || !['official-legend-badge', 'official-ranking-cutoff'].includes(options.membershipRule)) fail('configuration-invalid')
  if (options.membershipConfirmed !== true) fail('evidence-unconfirmed')
  let requestCount = 0
  const now = options.now ?? (() => new Date())
  const clock = (): string => { try { return now().toISOString() } catch { return fail('configuration-invalid') } }
  const cancelled = (): void => { if (options.signal?.aborted) fail('cancelled') }
  const read = async (page: number): Promise<LegendAnalysisPage> => {
    cancelled()
    if (requestCount >= maxRequests) fail('request-limit')
    const url = options.pageUrl(page)
    requestCount++
    const value = await options.fetchPage(page, url)
    cancelled()
    if (!value || value.sourceUrl !== url || value.page !== page || value.conditionsConfirmed !== true
      || value.actConfirmed !== true || value.rosterConfirmed !== true || value.actId !== options.act.id
      || !equal(value.conditions, options.conditions) || !integer(value.pageSize, 1) || value.pageSize > 20
      || !integer(value.totalCount, 1) || !integer(value.from, 1) || !integer(value.to, 1)
      || value.from !== (page - 1) * value.pageSize + 1 || value.to !== Math.min(page * value.pageSize, value.totalCount)
      || value.to < value.from || value.nextPage !== (value.to < value.totalCount ? page + 1 : null)
      || !Array.isArray(value.entries) || value.entries.length !== value.to - value.from + 1) fail('source-changed')
    for (const entry of value.entries) {
      if (!entry || !integer(entry.rank, 1) || !integer(entry.masterRating) || typeof entry.isLegend !== 'boolean'
        || !options.characterIds.includes(entry.characterId) || typeof entry.accountKey !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.accountKey)) fail('source-changed')
    }
    return value
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    cancelled()
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
        if (current.pageSize !== first.pageSize) fail('source-changed')
        for (const [index, entry] of current.entries.entries()) {
          if (current.page === 1 && index === 0 && entry.rank !== 1
            || entry.rank > current.from + index
            || previous && (entry.rank < previous.rank || entry.masterRating > previous.masterRating)) fail('source-changed')
          const key = `${entry.accountKey}:${entry.characterId}`
          if (seen.has(key)) fail('duplicate-entry')
          seen.add(key)
          if (!entry.isLegend) boundary = true
          else {
            if (boundary) fail('source-changed')
            accepted.push(entry)
          }
          previous = entry
        }
        if (boundary || current.nextPage === null) break
        current = await read(current.nextPage)
      }
      if (!accepted.length) fail('evidence-unconfirmed')
      // Re-read the last observed page and then the start; comparison includes every private row.
      await options.confirmAct?.()
      const lastAgain = await read(current.page)
      if (!equal(stablePage(current), stablePage(lastAgain)) || !boundary && lastAgain.nextPage !== null
        || !equal(stablePage(first), stablePage(await read(1)))) fail('source-changed')
      const endedAt = clock()
      if (Date.parse(endedAt) < Date.parse(startedAt)) fail('configuration-invalid')
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
      return { dataset, requestCount, retryCount: attempt, pagesRead }
    } catch (error) {
      if (options.signal?.aborted) fail('cancelled')
      if (!(error instanceof LegendAnalysisCollectionError)
        || !['source-changed', 'duplicate-entry'].includes(error.code) || attempt + 1 >= maxAttempts) throw error
    }
  }
  return fail('read-failed')
}
