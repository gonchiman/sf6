/** Pure collection logic. A caller supplies an authorized, verified page reader. */
export interface RankBoundaryEntry {
  leaguePoint: number
  rankId: number
  /** Private transient key used to reject observed duplicates; never returned. */
  accountKey?: string
}

export interface RankBoundaryPage {
  sourceUrl: string
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
  entries: RankBoundaryEntry[]
}

export interface RankLpBoundary {
  rankId: number
  minimumLp: number
}

export interface RankBoundaryResult {
  totalCount: number
  pageSize: number
  totalPages: number
  entries: Array<{ rankId: number; count: number }>
  /** Count of listed rows with LP at least this rank's minimum; not displayed ranking order. */
  boundaries: Array<{ rankId: number; minimumLp: number; countAtOrAbove: number }>
  requestCount: number
  /** Account-unit confirmation requires separate source evidence. This is not a verified dataset. */
  observedChecks: string[]
}

export interface RankBoundaryOptions {
  sourceUrl: string
  /** Current LP/rank mapping must be confirmed by the caller; no historical defaults. */
  ranks: RankLpBoundary[]
  fetchPage: (page: number, url: string) => Promise<RankBoundaryPage>
  maxRequests?: number
  signal?: AbortSignal
}

const REQUIRED_FILTERS = {
  character_filter: '2', character_id: 'luke', platform: '1', user_status: '1',
  home_filter: '1', home_category_id: '0', home_id: '0', league_rank: '0',
} as const

/** This URL is the observed ALL / MAX LP condition, not a supported API contract. */
export const RANK_BOUNDARY_SOURCE_URL = 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league?character_filter=2&character_id=luke&platform=1&user_status=1&home_filter=1&home_category_id=0&home_id=0&league_rank=0'

function invalid(message: string): never {
  throw new Error(`ランク分布の境界取得を中止しました: ${message}`)
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

export function rankBoundaryPageUrl(sourceUrl: string, page: number): string {
  if (!integer(page, 1)) invalid('ページ番号が不正です。')
  let url: URL
  try { url = new URL(sourceUrl) } catch { return invalid('出典URLが不正です。') }
  if (url.origin !== 'https://www.streetfighter.com'
    || url.pathname !== '/6/buckler/ja-jp/ranking/league'
    || url.username || url.password || url.hash) invalid('公式LPランキング以外のURLは使用できません。')
  for (const [key, expected] of Object.entries(REQUIRED_FILTERS)) {
    if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== expected) {
      invalid('総合・最大LP・全地域・全プラットフォーム・全ユーザーの取得条件が一致しません。')
    }
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'page' && !Object.hasOwn(REQUIRED_FILTERS, key)) invalid('未確認の取得条件が含まれています。')
  }
  if (url.searchParams.getAll('page').length > 1) invalid('ページ番号が重複しています。')
  url.searchParams.set('page', String(page))
  url.searchParams.sort()
  return url.href
}

function validateRanks(values: RankLpBoundary[]): RankLpBoundary[] {
  if (!Array.isArray(values) || values.length !== 36) invalid('1〜36のLP・ランク対応が必要です。')
  const ranks = values.map(({ rankId, minimumLp }) => ({ rankId, minimumLp }))
    .sort((a, b) => a.rankId - b.rankId)
  ranks.forEach((rank, index) => {
    if (rank.rankId !== index + 1 || !integer(rank.minimumLp)
      || (index === 0 ? rank.minimumLp !== 0 : rank.minimumLp <= ranks[index - 1].minimumLp)) {
      invalid('LP・ランク対応に重複、不明区分、または逆転があります。')
    }
  })
  return ranks
}

/**
 * Find all 35 boundaries without enumerating all accounts. Reject observed changes;
 * this cannot prove a single-time snapshot or uniqueness of unobserved rows.
 * No network transport, cookies, retry loop, or full-enumeration fallback is provided.
 */
export async function collectRankDistributionBoundaries(options: RankBoundaryOptions): Promise<RankBoundaryResult> {
  const ranks = validateRanks(options.ranks)
  rankBoundaryPageUrl(options.sourceUrl, 1)
  const maxRequests = options.maxRequests ?? 1000
  if (!integer(maxRequests, 1)) invalid('取得回数の上限が不正です。')
  let requestCount = 0
  let baseline: { totalCount: number; totalPages: number; pageSize: number } | null = null
  const pages = new Map<number, RankBoundaryPage>()
  const seenAccounts = new Map<string, number>()

  function classify(lp: number): number {
    return ranks.findLast((rank) => lp >= rank.minimumLp)!.rankId
  }

  async function readPage(pageNumber: number, fresh = false): Promise<RankBoundaryPage> {
    if (options.signal?.aborted) invalid('取得が中止されました。')
    if (!fresh && pages.has(pageNumber)) return pages.get(pageNumber)!
    if (requestCount >= maxRequests) invalid('取得回数の上限に達しました。全件取得への切替は行いません。')
    requestCount += 1
    const value = await options.fetchPage(pageNumber, rankBoundaryPageUrl(options.sourceUrl, pageNumber))
    if (options.signal?.aborted) invalid('取得が中止されました。')
    if (!value || value.page !== pageNumber || !integer(value.totalCount) || !integer(value.pageSize, 1)
      || !integer(value.totalPages, 1) || !Array.isArray(value.entries)) invalid('ページ情報の形式または到達先が不正です。')
    let responseUrl: URL
    try { responseUrl = new URL(value.sourceUrl) } catch { return invalid('表示中のURLが不正です。') }
    if (responseUrl.searchParams.getAll('page').length !== 1 || responseUrl.searchParams.get('page') !== String(pageNumber)) {
      invalid('表示中のURLで要求ページへの到達を確認できません。')
    }
    if (rankBoundaryPageUrl(value.sourceUrl, pageNumber) !== rankBoundaryPageUrl(options.sourceUrl, pageNumber)) {
      invalid('取得中に表示条件が変更されました。')
    }
    if (value.totalPages !== Math.max(1, Math.ceil(value.totalCount / value.pageSize))) invalid('総件数と最終ページが一致しません。')
    if (baseline && (value.totalCount !== baseline.totalCount || value.totalPages !== baseline.totalPages
      || value.pageSize !== baseline.pageSize)) invalid('取得中に総件数またはページ構成が変わりました。')
    if (pageNumber > value.totalPages) invalid('最終ページより後の取得結果です。')
    const offset = (pageNumber - 1) * value.pageSize
    if (value.entries.length !== Math.min(value.pageSize, value.totalCount - offset)) invalid('ページの項目数が不足または過剰です。')
    const entries = value.entries.map((entry, index) => {
      if (!entry || !integer(entry.leaguePoint) || !integer(entry.rankId, 1) || entry.rankId > 36
        || classify(entry.leaguePoint) !== entry.rankId) invalid('LP・ランク対応が一致しません。未ランクを補完しません。')
      if (index > 0 && value.entries[index - 1].leaguePoint < entry.leaguePoint) invalid('ページ内のLP順が逆転しています。')
      if (entry.accountKey !== undefined && (typeof entry.accountKey !== 'string' || entry.accountKey.length === 0)) invalid('アカウント識別の確認値が不正です。')
      if (entry.accountKey !== undefined) {
        const position = offset + index
        const previous = seenAccounts.get(entry.accountKey)
        if (previous !== undefined && previous !== position) invalid('確認した一覧にアカウント重複または位置変化があります。')
        seenAccounts.set(entry.accountKey, position)
      }
      return { leaguePoint: entry.leaguePoint, rankId: entry.rankId, ...(entry.accountKey === undefined ? {} : { accountKey: entry.accountKey }) }
    })
    const previous = pages.get(pageNumber)
    if (previous && JSON.stringify(previous.entries) !== JSON.stringify(entries)) invalid('再確認したページの内容が変わりました。')
    for (const [otherNumber, other] of pages) {
      if (otherNumber === pageNumber || entries.length === 0 || other.entries.length === 0) continue
      const earlier = otherNumber < pageNumber ? other.entries : entries
      const later = otherNumber < pageNumber ? entries : other.entries
      if (earlier.at(-1)!.leaguePoint < later[0].leaguePoint) invalid('ページ間のLP順が逆転しています。')
    }
    baseline ??= { totalCount: value.totalCount, totalPages: value.totalPages, pageSize: value.pageSize }
    const normalized = { ...baseline, sourceUrl: value.sourceUrl, page: pageNumber, entries }
    pages.set(pageNumber, normalized)
    return normalized
  }

  const first = await readPage(1)
  await readPage(first.totalPages)
  const boundaryPages = new Set([1, first.totalPages])
  const boundaries: RankBoundaryResult['boundaries'] = []
  for (const { rankId, minimumLp } of ranks) {
    let lower = 0
    let upper = first.totalCount
    while (lower < upper) {
      const position = lower + Math.floor((upper - lower) / 2)
      const page = await readPage(Math.floor(position / first.pageSize) + 1)
      const entry = page.entries[position % first.pageSize]
      if (entry.leaguePoint >= minimumLp) lower = position + 1
      else upper = position
    }
    boundaries.push({ rankId, minimumLp, countAtOrAbove: lower })
    // A boundary can straddle two pages, including a run of equal LP values.
    for (const position of [lower - 1, lower]) {
      if (position < 0 || position >= first.totalCount) continue
      const pageNumber = Math.floor(position / first.pageSize) + 1
      const page = await readPage(pageNumber)
      const entry = page.entries[position % first.pageSize]
      if ((position < lower) !== (entry.leaguePoint >= minimumLp)) invalid('ランク境界の前後が一致しません。')
      boundaryPages.add(pageNumber)
    }
  }
  // No cached response counts as a second observation.
  for (const pageNumber of [...boundaryPages].sort((a, b) => a - b)) await readPage(pageNumber, true)
  const entries = boundaries.map((boundary, index) => ({
    rankId: boundary.rankId,
    count: boundary.countAtOrAbove - (boundaries[index + 1]?.countAtOrAbove ?? 0),
  }))
  if (entries.some((entry) => !integer(entry.count))
    || entries.reduce((sum, entry) => sum + entry.count, 0) !== first.totalCount) invalid('ランク別件数と総件数が一致しません。')
  return {
    totalCount: first.totalCount, totalPages: first.totalPages, pageSize: first.pageSize,
    entries, boundaries, requestCount,
    observedChecks: ['conditions-confirmed', 'pagination-confirmed', 'final-page-confirmed',
      'ordering-confirmed', 'rank-mapping-confirmed', 'total-count-stable', 'boundaries-rechecked'],
  }
}
