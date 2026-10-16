import { MR_DISTRIBUTION_CHECKS, MR_DISTRIBUTION_CONDITIONS, MR_DISTRIBUTION_THRESHOLDS, parseMrDistributionDataset } from '../../src/lib/mrDistribution.ts'
import type { MrDistributionDataset } from '../../src/types/mrDistribution.ts'

/** A caller supplies rendered, authorized ranking pages; displayed tied ranks are never counts. */
export interface MrDistributionEntry { masterRating: number; accountKey?: string }
export interface MrDistributionPage {
  sourceUrl: string; page: number; pageSize: number; totalCount: number; totalPages: number; entries: MrDistributionEntry[]
}
export const MR_DISTRIBUTION_FIXED_URL = 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/master?character_filter=2&character_id=luke&platform=1&home_filter=1&home_category_id=0&home_id=0&season_type=1'
const FILTERS = { character_filter: '2', character_id: 'luke', platform: '1', home_filter: '1', home_category_id: '0', home_id: '0', season_type: '1' }
export type MrDistributionCollectionErrorCode = 'invalid-options' | 'invalid-time' | 'invalid-page' | 'conditions-changed'
  | 'page-read-failed' | 'request-limit' | 'time-limit' | 'cancelled' | 'observation-changed' | 'collection-rejected'
export class MrDistributionCollectionError extends Error {
  readonly code: MrDistributionCollectionErrorCode
  constructor(code: MrDistributionCollectionErrorCode) {
    super(`MR分布の取得を中止しました (${code})。`)
    this.name = 'MrDistributionCollectionError'
    this.code = code
  }
}
function fail(code: MrDistributionCollectionErrorCode): never { throw new MrDistributionCollectionError(code) }
function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum }

/** Only the observed current-Act/max-MR/all-region/all-platform URL is accepted. */
export function mrDistributionPageUrl(page: number, sourceUrl = MR_DISTRIBUTION_FIXED_URL): string {
  if (!integer(page, 1)) fail('invalid-page')
  let url: URL
  try { url = new URL(sourceUrl) } catch { return fail('conditions-changed') }
  if (url.origin !== 'https://www.streetfighter.com' || url.pathname !== '/6/buckler/ja-jp/ranking/master'
    || url.username || url.password || url.hash) fail('conditions-changed')
  for (const [key, expected] of Object.entries(FILTERS)) {
    if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== expected) fail('conditions-changed')
  }
  if ([...url.searchParams.keys()].some(key => key !== 'page' && !Object.hasOwn(FILTERS, key))
    || url.searchParams.getAll('page').length > 1) fail('conditions-changed')
  url.searchParams.set('page', String(page))
  url.searchParams.sort()
  return url.href
}

export interface MrDistributionCollectionOptions {
  fetchPage: (page: number, url: string) => Promise<MrDistributionPage>
  now?: () => Date
  maxRequests?: number
  signal?: AbortSignal
  /** Aggregate progress only. A partial distribution is never returned. */
  onBoundary?: (confirmedCount: number) => void
}

/**
 * Binary search plus bounded nearby refinement. Cached pages guide searches;
 * every accepted boundary has fresh adjacent-row (or fresh end-page) evidence.
 * This interval estimate does not assert a simultaneous population/error bound.
 */
export async function collectMrDistribution(options: MrDistributionCollectionOptions): Promise<MrDistributionDataset> {
  const maxRequests = options.maxRequests ?? 600
  if (typeof options.fetchPage !== 'function' || options.now !== undefined && typeof options.now !== 'function'
    || options.onBoundary !== undefined && typeof options.onBoundary !== 'function'
    || !integer(maxRequests, 2) || maxRequests > 600) fail('invalid-options')
  const now = options.now ?? (() => new Date())
  let previousTime = -Infinity
  let started: number | null = null
  const time = (): string => {
    let value: number
    try { value = Date.prototype.getTime.call(now()) } catch { return fail('invalid-time') }
    if (!Number.isFinite(value) || value < previousTime) fail('invalid-time')
    previousTime = value
    if (started !== null && value - started > 30 * 60_000) fail('time-limit')
    try { return new Date(value).toISOString() } catch { return fail('invalid-time') }
  }
  const captureStartedAt = time()
  started = Date.parse(captureStartedAt)
  const check = (): void => { if (options.signal?.aborted) fail('cancelled'); time() }
  const hints = new Map<number, MrDistributionPage>()
  let requestCount = 0, latestTotal = 0, minTotal = Infinity, maxTotal = 0
  let pageSize: number | null = null
  async function read(pageNumber: number, fresh = false): Promise<MrDistributionPage> {
    check()
    if (!fresh && hints.has(pageNumber)) return hints.get(pageNumber)!
    if (!integer(pageNumber, 1)) fail('invalid-page')
    if (requestCount >= maxRequests) fail('request-limit')
    requestCount++
    let page: MrDistributionPage
    try { page = await options.fetchPage(pageNumber, mrDistributionPageUrl(pageNumber)) }
    catch { check(); return fail('page-read-failed') }
    check()
    if (!page || page.page !== pageNumber || !integer(page.totalCount, 1) || !integer(page.pageSize, 1)
      || page.pageSize > 20 || pageSize !== null && page.pageSize !== pageSize
      || page.totalPages !== Math.ceil(page.totalCount / page.pageSize) || pageNumber > page.totalPages
      || !Array.isArray(page.entries)) fail('invalid-page')
    try {
      const url = new URL(page.sourceUrl)
      if (url.searchParams.getAll('page').length !== 1 || url.searchParams.get('page') !== String(pageNumber)
        || mrDistributionPageUrl(pageNumber, page.sourceUrl) !== mrDistributionPageUrl(pageNumber)) fail('conditions-changed')
    } catch { return fail('conditions-changed') }
    const offset = (pageNumber - 1) * page.pageSize
    if (page.entries.length !== Math.min(page.pageSize, page.totalCount - offset)) fail('invalid-page')
    const identities = new Set<string>()
    const entries = page.entries.map((entry, i) => {
      if (!entry || !integer(entry.masterRating)) fail('invalid-page')
      if (i && page.entries[i - 1].masterRating < entry.masterRating) fail('observation-changed')
      if (entry.accountKey !== undefined) {
        if (typeof entry.accountKey !== 'string' || !entry.accountKey || identities.has(entry.accountKey)) fail('invalid-page')
        identities.add(entry.accountKey)
      }
      return { masterRating: entry.masterRating }
    })
    pageSize ??= page.pageSize
    latestTotal = page.totalCount
    minTotal = Math.min(minTotal, latestTotal)
    maxTotal = Math.max(maxTotal, latestTotal)
    const normalized = { sourceUrl: page.sourceUrl, page: page.page, pageSize: page.pageSize, totalCount: page.totalCount, totalPages: page.totalPages, entries }
    hints.set(pageNumber, normalized)
    return normalized
  }
  const first = await read(1, true)
  const totalAtStart = first.totalCount
  const initialTail = await read(first.totalPages, true)
  if (initialTail.page > 1 && first.entries.at(-1)!.masterRating < initialTail.entries[0].masterRating) fail('observation-changed')
  async function candidate(minimumMr: number): Promise<number> {
    let low = 0, high = latestTotal
    for (const page of hints.values()) {
      const offset = (page.page - 1) * page.pageSize
      for (let i = 0; i < page.entries.length; i++) {
        const position = offset + i
        if (position >= latestTotal) continue
        if (page.entries[i].masterRating >= minimumMr) low = Math.max(low, position + 1)
        else high = Math.min(high, position)
      }
    }
    if (low > high) { low = 0; high = latestTotal }
    while (low < high) {
      const position = low + Math.floor((high - low) / 2)
      const page = await read(Math.floor(position / first.pageSize) + 1)
      const entry = page.entries[position % first.pageSize]
      if (!entry) { high = Math.min(high, page.totalCount); continue }
      if (entry.masterRating >= minimumMr) low = position + 1
      else high = position
    }
    return low
  }
  const within = (page: MrDistributionPage, minimumMr: number): number | null => {
    const prefix = page.entries.findIndex(entry => entry.masterRating < minimumMr)
    return prefix > 0 && prefix < page.entries.length ? (page.page - 1) * page.pageSize + prefix : null
  }
  const endpoint = (page: MrDistributionPage, minimumMr: number): number | null => {
    if (page.page === 1 && page.entries[0].masterRating < minimumMr) return 0
    if (page.page === page.totalPages && page.entries.at(-1)!.masterRating >= minimumMr) return page.totalCount
    return null
  }
  async function confirm(minimumMr: number, hinted: number): Promise<{ confirmed: boolean; count: number; totalCount: number }> {
    const position = Math.max(0, Math.min(hinted, latestTotal))
    const before = await read(Math.floor(Math.max(0, position - 1) / first.pageSize) + 1, true)
    const beforeEndpoint = endpoint(before, minimumMr)
    if (beforeEndpoint !== null) return { confirmed: true, count: beforeEndpoint, totalCount: before.totalCount }
    const crossed = within(before, minimumMr)
    if (crossed !== null) return { confirmed: true, count: crossed, totalCount: before.totalCount }
    const actual = Math.min(position, before.totalCount)
    const afterPage = Math.floor(actual / first.pageSize) + 1
    const after = actual === before.totalCount || afterPage === before.page ? before : await read(afterPage, true)
    const afterEndpoint = endpoint(after, minimumMr)
    if (afterEndpoint !== null) return { confirmed: true, count: afterEndpoint, totalCount: after.totalCount }
    const crossedAfter = within(after, minimumMr)
    if (crossedAfter !== null) return { confirmed: true, count: crossedAfter, totalCount: after.totalCount }
    const left = actual > 0 ? before.entries[(actual - 1) % first.pageSize] : null
    const right = actual < after.totalCount ? after.entries[actual % first.pageSize] : null
    const confirmed = (actual === 0 || !!left && left.masterRating >= minimumMr)
      && (actual === after.totalCount || !!right && right.masterRating < minimumMr)
    if (confirmed && left && right && left.masterRating < right.masterRating) fail('observation-changed')
    return { confirmed, count: actual, totalCount: after.totalCount }
  }
  async function nearby(minimumMr: number, hinted: number): Promise<number> {
    let lower: MrDistributionPage | null = null, upper: MrDistributionPage | null = null
    let pageNumber = Math.max(1, Math.min(Math.ceil(latestTotal / first.pageSize), Math.floor(hinted / first.pageSize) + 1))
    let step = 1
    for (let probe = 0; probe < 64; probe++) {
      const page = await read(pageNumber, true)
      const crossed = within(page, minimumMr)
      if (crossed !== null) return crossed
      const above = page.entries[0].masterRating >= minimumMr
      if (above) { lower = page; if (page.page === page.totalPages) return page.totalCount }
      else { upper = page; if (page.page === 1) return 0 }
      if (lower && upper) {
        if (lower.page >= upper.page) return candidate(minimumMr)
        if (upper.page === lower.page + 1) return (upper.page - 1) * page.pageSize
        pageNumber = lower.page + Math.floor((upper.page - lower.page) / 2)
      } else {
        pageNumber = above ? Math.min(page.totalPages, page.page + step) : Math.max(1, page.page - step)
        step *= 2
      }
    }
    return fail('observation-changed')
  }
  const boundaries: Array<{ minimumMr: number; countAtOrAbove: number; totalCount: number; observedAt: string }> = []
  for (const minimumMr of MR_DISTRIBUTION_THRESHOLDS) {
    let hinted = await candidate(minimumMr)
    let accepted = false
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await confirm(minimumMr, hinted)
      if (result.confirmed) {
        boundaries.push({ minimumMr, countAtOrAbove: result.count, totalCount: result.totalCount, observedAt: time() })
        try { options.onBoundary?.(boundaries.length) } catch { fail('collection-rejected') }
        accepted = true
        break
      }
      hinted = await nearby(minimumMr, result.count)
    }
    if (!accepted) fail('observation-changed')
  }
  const endingFirst = await read(1, true)
  const endingHeadObservedAt = time()
  let tail = await read(endingFirst.totalPages, true)
  for (let attempt = 0; tail.page !== tail.totalPages && attempt < 2; attempt++) tail = await read(tail.totalPages, true)
  if (tail.page !== tail.totalPages || tail.page > 1 && endingFirst.entries.at(-1)!.masterRating < tail.entries[0].masterRating) fail('observation-changed')
  const totalAtEnd = tail.totalCount
  const endingTailObservedAt = time()
  // Out-of-range thresholds share the final fresh endpoint evidence. Keeping an
  // earlier total here could fabricate low-MR bins as the listing grows.
  for (const boundary of boundaries) {
    if (boundary.minimumMr <= tail.entries.at(-1)!.masterRating) {
      boundary.countAtOrAbove = totalAtEnd
      boundary.totalCount = totalAtEnd
      boundary.observedAt = endingTailObservedAt
    } else if (boundary.minimumMr > endingFirst.entries[0].masterRating) {
      boundary.countAtOrAbove = 0
      boundary.totalCount = endingFirst.totalCount
      boundary.observedAt = endingHeadObservedAt
    }
  }
  const cumulative = [totalAtEnd, ...boundaries.map(value => value.countAtOrAbove), 0]
  const entries = Array.from({ length: 26 }, (_, index) => ({ minimum: index * 100, maximum: index === 25 ? null : (index + 1) * 100,
    count: cumulative[index] - cumulative[index + 1] }))
  if (entries.some(entry => !integer(entry.count)) || entries.reduce((sum, entry) => sum + entry.count, 0) !== totalAtEnd) fail('observation-changed')
  check()
  const captureEndedAt = time()
  try {
    return parseMrDistributionDataset({ schemaVersion: 1, id: `max-mr-estimate-${captureStartedAt.replace(/[:.]/g, '-')}`,
      captureStartedAt, captureEndedAt, generatedAt: captureEndedAt,
      source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/master', title: 'Buckler MRランキング',
        population: '今Act・最大MR条件で掲載されたファイターアカウント', metric: '取得期間中に観測した100MR刻みの掲載アカウント数の概数',
        unit: 'fighter-account', notes: ['同じ人の別プラットフォームのアカウントを統合した実人数や、すべてのマスター到達者の人口ではない。'] },
      conditions: { ...MR_DISTRIBUTION_CONDITIONS }, method: 'boundary-search-estimate', binWidth: 100, totalCount: totalAtEnd, entries,
      observation: { totalAtStart, totalAtEnd, minTotal, maxTotal, boundaries },
      validation: { status: 'estimated', coverage: 'all-mr-boundaries', checks: [...MR_DISTRIBUTION_CHECKS], notes: [
        `固定条件のレンダリング済みランキングについて全25閾値の前後を新規読取で確認した。読取回数: ${requestCount}。`,
        '件数は表示順位ではなくページ番号と行位置から算出した。同じMRの掲載行もそれぞれ数える。',
        '各境界を異なる時刻に観測した概数であり、単一時点の正確な分布ではない。総件数の変動から誤差上限や信頼区間は算出していない。',
      ] } })
  } catch { return fail('collection-rejected') }
}
