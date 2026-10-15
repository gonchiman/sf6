import {
  parseRankDistributionDataset, RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_SOURCE,
  RANK_DISTRIBUTION_VALIDATION_CHECKS,
} from '../../src/lib/rankDistribution.ts'
import type { RankDistributionDataset } from '../../src/types/rankDistribution.ts'
import { rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'
import type { RankBoundaryPage } from './rank-distribution-boundaries.ts'
import {
  RankDistributionCollectionError, validateRankDistributionCollectionEvidence,
} from './rank-distribution-collector.ts'
import type { RankDistributionCollectionEvidence, RankDistributionCollectionErrorCode } from './rank-distribution-collector.ts'
import { parseRankDistributionCheckpoint } from './rank-distribution-checkpoint.ts'
import type { RankDistributionCheckpoint, RankDistributionCheckpointHint } from './rank-distribution-checkpoint.ts'

export interface RankDistributionEstimateOptions {
  fetchPage: (page: number, url: string) => Promise<RankBoundaryPage>
  currentMappingEvidence: RankDistributionCollectionEvidence
  maxLpAccountUnitEvidence: RankDistributionCollectionEvidence
  unrankedTailEvidence: RankDistributionCollectionEvidence
  now?: () => Date
  maxRequests?: number
  signal?: AbortSignal
  /** Safe progress only; no partial aggregate is returned or published. */
  onBoundary?: (confirmedCount: number) => void
  /** Previous observations are candidate positions only; every boundary must be observed again. */
  checkpoint?: RankDistributionCheckpoint
  /** Persist only aggregate hints after each newly confirmed boundary. */
  onCheckpoint?: (checkpoint: RankDistributionCheckpoint) => void | Promise<void>
}

type BoundaryObservation = RankDistributionCheckpointHint

function fail(code: RankDistributionCollectionErrorCode): never {
  throw new RankDistributionCollectionError(code)
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

/**
 * Observe all rank boundaries over a capture interval. Previous pages only guide
 * the search: each accepted boundary is checked with newly read adjacent rows.
 * Changing totals and within-rank identity/LP changes are expected. This does not
 * claim a simultaneous population, sampling confidence, or an error bound.
 */
export async function collectRankDistributionEstimate(
  options: RankDistributionEstimateOptions,
): Promise<RankDistributionDataset> {
  const checkCancelled = (): void => { if (options.signal?.aborted) fail('cancelled') }
  checkCancelled()
  if (typeof options.fetchPage !== 'function' || (options.now !== undefined && typeof options.now !== 'function')
    || (options.onBoundary !== undefined && typeof options.onBoundary !== 'function')
    || (options.onCheckpoint !== undefined && typeof options.onCheckpoint !== 'function')
    || Object.hasOwn(options, 'ranks') || Object.hasOwn(options, 'mode')) fail('invalid-options')
  const mapping = validateRankDistributionCollectionEvidence(options.currentMappingEvidence)
  const accountUnit = validateRankDistributionCollectionEvidence(options.maxLpAccountUnitEvidence)
  const tailEvidence = validateRankDistributionCollectionEvidence(options.unrankedTailEvidence)
  const maxRequests = options.maxRequests ?? 600
  if (!integer(maxRequests, 1)) fail('invalid-options')
  const now = options.now ?? (() => new Date())
  let previousTime = -Infinity
  const time = (): string => {
    let result: string
    try {
      const value = Date.prototype.getTime.call(now())
      if (!Number.isFinite(value) || value < previousTime) fail('invalid-time')
      result = new Date(value).toISOString()
      if (!/^\d{4}-\d{2}-\d{2}T/.test(result)) fail('invalid-time')
      previousTime = value
    } catch { return fail('invalid-time') }
    return result
  }
  const captureStartedAt = time()
  let checkpoint: RankDistributionCheckpoint | null = null
  if (options.checkpoint !== undefined) {
    try { checkpoint = parseRankDistributionCheckpoint(options.checkpoint) } catch { fail('invalid-options') }
    if (Date.parse(checkpoint!.savedAt) > Date.parse(captureStartedAt)) fail('invalid-options')
  }
  const previousHints = new Map((checkpoint?.hints ?? []).map(hint => [hint.rankId, { ...hint }]))
  const checkpointHints = new Map(previousHints)
  let requestCount = 0
  let pageSize: number | null = null
  let latestTotal = 0
  let minTotal = Infinity
  let maxTotal = 0
  const hints = new Map<number, RankBoundaryPage>()

  async function readPage(pageNumber: number, fresh = false): Promise<RankBoundaryPage> {
    checkCancelled()
    if (!fresh && hints.has(pageNumber)) return hints.get(pageNumber)!
    if (!integer(pageNumber, 1)) fail('invalid-page')
    if (requestCount >= maxRequests) fail('request-limit')
    requestCount++
    let value: RankBoundaryPage
    try { value = await options.fetchPage(pageNumber, rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, pageNumber)) }
    catch { checkCancelled(); return fail('page-read-failed') }
    checkCancelled()
    if (!value || value.page !== pageNumber || !integer(value.totalCount, 1) || !integer(value.pageSize, 1)
      || !integer(value.totalPages, 1) || !Array.isArray(value.entries)) fail('invalid-page')
    try {
      const url = new URL(value.sourceUrl)
      if (url.searchParams.getAll('page').length !== 1 || url.searchParams.get('page') !== String(pageNumber)
        || rankBoundaryPageUrl(value.sourceUrl, pageNumber) !== rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, pageNumber)) {
        fail('conditions-changed')
      }
    } catch { return fail('conditions-changed') }
    if (pageSize !== null && value.pageSize !== pageSize) fail('invalid-page')
    if (value.totalPages !== Math.max(1, Math.ceil(value.totalCount / value.pageSize))
      || pageNumber > value.totalPages) fail('invalid-page')
    const offset = (pageNumber - 1) * value.pageSize
    if (value.entries.length !== Math.min(value.pageSize, value.totalCount - offset)) fail('invalid-page')
    const observedKeys = new Set<string>()
    const entries = value.entries.map((entry, index) => {
      if (!entry || !integer(entry.rankId, 1) || entry.rankId > 36) fail('unknown-rank')
      if (!integer(entry.leaguePoint)) fail('invalid-page')
      if (index > 0 && (value.entries[index - 1].leaguePoint < entry.leaguePoint
        || value.entries[index - 1].rankId < entry.rankId)) fail('observation-changed')
      if (entry.accountKey !== undefined) {
        if (typeof entry.accountKey !== 'string' || !entry.accountKey || observedKeys.has(entry.accountKey)) fail('invalid-page')
        observedKeys.add(entry.accountKey)
      }
      // Identities are deliberately not retained by the search or final dataset.
      return { rankId: entry.rankId, leaguePoint: entry.leaguePoint }
    })
    pageSize ??= value.pageSize
    latestTotal = value.totalCount
    minTotal = Math.min(minTotal, value.totalCount)
    maxTotal = Math.max(maxTotal, value.totalCount)
    const normalized: RankBoundaryPage = {
      sourceUrl: value.sourceUrl, page: pageNumber, pageSize: value.pageSize,
      totalCount: value.totalCount, totalPages: value.totalPages, entries,
    }
    hints.set(pageNumber, normalized)
    return normalized
  }

  const first = await readPage(1, true)
  if (checkpoint && checkpoint.pageSize !== first.pageSize) fail('invalid-page')
  const totalAtStart = first.totalCount
  await readPage(first.totalPages, true)

  async function hintedBoundary(rankId: number): Promise<number> {
    let lower = 0
    let upper = latestTotal
    // Pages observed for other ranks can eliminate large irrelevant intervals.
    for (const page of hints.values()) {
      const offset = (page.page - 1) * page.pageSize
      for (let index = 0; index < page.entries.length; index++) {
        const position = offset + index
        if (position >= latestTotal) continue
        if (page.entries[index].rankId >= rankId) lower = Math.max(lower, position + 1)
        else upper = Math.min(upper, position)
      }
    }
    // Contradictory old observations are not proof that a live source is invalid.
    if (lower > upper) { lower = 0; upper = latestTotal }
    while (lower < upper) {
      const position = lower + Math.floor((upper - lower) / 2)
      const page = await readPage(Math.floor(position / first.pageSize) + 1)
      const entry = page.entries[position % first.pageSize]
      if (!entry) { upper = Math.min(upper, page.totalCount); continue }
      if (entry.rankId >= rankId) lower = position + 1
      else upper = position
    }
    return lower
  }

  /** Only these new observations, never hint cache hits, can accept a boundary. */
  async function confirmBoundary(rankId: number, candidate: number): Promise<{
    confirmed: boolean; candidate: number; totalCount: number
  }> {
    const position = Math.max(0, Math.min(candidate, latestTotal))
    const beforePageNumber = Math.floor(Math.max(0, position - 1) / first.pageSize) + 1
    const before = await readPage(beforePageNumber, true)
    const actualPosition = Math.min(position, before.totalCount)
    const afterPageNumber = Math.floor(actualPosition / first.pageSize) + 1
    const after = actualPosition === before.totalCount || afterPageNumber === before.page
      ? before : await readPage(afterPageNumber, true)
    const left = actualPosition > 0 ? before.entries[(actualPosition - 1) % first.pageSize] : null
    const right = actualPosition < after.totalCount ? after.entries[actualPosition % first.pageSize] : null
    if (actualPosition > 0 && !left) return { confirmed: false, candidate: actualPosition, totalCount: after.totalCount }
    if (actualPosition < after.totalCount && !right) return { confirmed: false, candidate: actualPosition, totalCount: after.totalCount }
    const confirmed = (!left || left.rankId >= rankId) && (!right || right.rankId < rankId)
    if (confirmed && left && right && (left.leaguePoint < right.leaguePoint || left.rankId < right.rankId)) fail('observation-changed')
    return { confirmed, candidate: actualPosition, totalCount: after.totalCount }
  }

  /** Exponential page bracketing and binary refinement, never a full row/page scan. */
  async function findNearby(rankId: number, candidate: number): Promise<number> {
    let lower: RankBoundaryPage | null = null
    let upper: RankBoundaryPage | null = null
    let pageNumber = Math.min(Math.ceil(latestTotal / first.pageSize), Math.floor(candidate / first.pageSize) + 1)
    let step = 1
    for (let probe = 0; probe < 64; probe++) {
      const page = await readPage(Math.max(1, pageNumber), true)
      const prefix = page.entries.findIndex(entry => entry.rankId < rankId)
      const above = prefix < 0 ? page.entries.length : prefix
      const offset = (page.page - 1) * page.pageSize
      if (above > 0 && above < page.entries.length) return offset + above
      if (above === 0) {
        upper = page
        if (page.page === 1) return 0
        if (lower && lower.page >= upper.page) return hintedBoundary(rankId)
      } else {
        lower = page
        if (page.page === page.totalPages) return page.totalCount
        if (upper && upper.page <= lower.page) return hintedBoundary(rankId)
      }
      if (lower && upper) {
        if (upper.page === lower.page + 1) return (upper.page - 1) * page.pageSize
        pageNumber = lower.page + Math.floor((upper.page - lower.page) / 2)
      } else {
        pageNumber = above === 0 ? Math.max(1, page.page - step) : Math.min(page.totalPages, page.page + step)
        step *= 2
      }
    }
    return fail('observation-changed')
  }

  const currentBoundaries = new Map<number, BoundaryObservation>()
  const allRankIds = Array.from({ length: 35 }, (_, index) => index + 2)
  // Gather missing hints first so repeated interrupted captures do not search the same early ranks.
  const rankOrder = [...allRankIds.filter(rankId => !previousHints.has(rankId)),
    ...allRankIds.filter(rankId => previousHints.has(rankId))]
  for (const rankId of rankOrder) {
    const previous = previousHints.get(rankId)
    let candidate = previous ? previous.countAtOrAbove : await hintedBoundary(rankId)
    let accepted = false
    for (let attempt = 0; attempt < 3; attempt++) {
      const observed = await confirmBoundary(rankId, candidate)
      if (observed.confirmed) {
        if (observed.candidate > observed.totalCount) fail('observation-changed')
        const boundary = { rankId, countAtOrAbove: observed.candidate, totalCount: observed.totalCount, observedAt: time() }
        currentBoundaries.set(rankId, boundary)
        checkpointHints.set(rankId, { ...boundary })
        if (options.onCheckpoint) {
          const value: RankDistributionCheckpoint = {
            schemaVersion: 1, method: 'boundary-search-estimate', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
            pageSize: first.pageSize, savedAt: time(),
            hints: [...checkpointHints.values()].sort((a, b) => a.rankId - b.rankId).map(hint => ({ ...hint })),
          }
          checkCancelled()
          try { await options.onCheckpoint(parseRankDistributionCheckpoint(value)) } catch { fail('collection-rejected') }
          checkCancelled()
        }
        try { options.onBoundary?.(currentBoundaries.size) } catch { fail('collection-rejected') }
        accepted = true
        break
      }
      candidate = await findNearby(rankId, observed.candidate)
    }
    if (!accepted) fail('observation-changed')
  }
  // Capture order can prioritize missing hints; published counts always use rank order.
  const boundaries = [...currentBoundaries.values()].sort((a, b) => a.rankId - b.rankId)

  // Verify the current tail, following a changed last-page number only a bounded number of times.
  const endingFirst = await readPage(1, true)
  let endingTail = await readPage(endingFirst.totalPages, true)
  for (let attempt = 0; endingTail.page !== endingTail.totalPages && attempt < 2; attempt++) {
    endingTail = await readPage(endingTail.totalPages, true)
  }
  if (endingTail.page !== endingTail.totalPages) fail('observation-changed')
  const totalAtEnd = endingTail.totalCount
  const cumulative = [totalAtEnd, ...boundaries.map(boundary => boundary.countAtOrAbove), 0]
  const entries = Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, count: cumulative[index] - cumulative[index + 1] }))
  if (entries.some(entry => !integer(entry.count)) || entries.reduce((sum, entry) => sum + entry.count, 0) !== totalAtEnd) {
    fail('observation-changed')
  }
  checkCancelled()
  const captureEndedAt = time()
  const dataset = {
    schemaVersion: 1, id: `max-lp-estimate-${captureStartedAt.replace(/[:.]/g, '-')}`,
    captureStartedAt, captureEndedAt, generatedAt: captureEndedAt,
    source: {
      ...RANK_DISTRIBUTION_SOURCE, population: '総合・最大LP条件で掲載されたファイターアカウント',
      metric: '取得期間内に観測したLPランク別の掲載アカウント数の概数', unit: 'fighter-account',
      notes: ['同じ人の別プラットフォームのアカウントを統合した実人数や、直近の活動人口ではない。'],
    },
    conditions: { ...RANK_DISTRIBUTION_CONDITIONS }, method: 'boundary-search-estimate', totalCount: totalAtEnd, entries,
    validation: {
      status: 'estimated', coverage: 'all-rank-boundaries',
      checks: RANK_DISTRIBUTION_VALIDATION_CHECKS.map(check => check === 'total-count-stable' ? 'changes-recorded' : check),
      notes: [
        `公式ランクID・表示名対応の確認: ${mapping.note} 出典: ${mapping.sourceUrl}`,
        `最大LPのアカウント単位の確認: ${accountUnit.note} 出典: ${accountUnit.sourceUrl}`,
        `未ランク・不明区分と末尾の確認: ${tailEvidence.note} 出典: ${tailEvidence.sourceUrl}`,
        `全35境界の前後を新規読取で確認した。読取回数: ${requestCount}。`,
        '各境界を異なる時刻に観測した取得期間内の概数であり、単一時点の正確な人口分布ではない。',
        '保存済みの途中記録は探索候補の位置としてのみ使い、今回の全35境界の件数と日時は新しい読取で確認した。',
        '割合の分母は取得終了時に最終ページで観測した総件数。総件数の変化から誤差上限や信頼区間は算出していない。',
      ],
    },
    observation: { totalAtStart, totalAtEnd, minTotal, maxTotal, boundaries },
  }
  try { return parseRankDistributionDataset(dataset) } catch { return fail('collection-rejected') }
}
