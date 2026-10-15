import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectRankDistributionBoundaries, rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL,
} from './rank-distribution-boundaries.ts'
import type { RankBoundaryEntry, RankBoundaryPage } from './rank-distribution-boundaries.ts'

// Synthetic thresholds intentionally do not assert today's official LP mapping.
const ranks = Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, minimumLp: index * 100 }))
function entries(): RankBoundaryEntry[] {
  return ranks.toReversed().flatMap(({ rankId, minimumLp }) => [10, 0].map((offset) => ({
    rankId, leaguePoint: minimumLp + offset, accountKey: `${rankId}-${offset}`,
  })))
}
function reader(values = entries(), pageSize = 5) {
  const requests: number[] = []
  const fetchPage = async (page: number, sourceUrl: string): Promise<RankBoundaryPage> => {
    requests.push(page)
    return {
      sourceUrl, page, pageSize, totalCount: values.length,
      totalPages: Math.max(1, Math.ceil(values.length / pageSize)),
      entries: structuredClone(values.slice((page - 1) * pageSize, page * pageSize)),
    }
  }
  return { requests, fetchPage }
}

test('counts all 36 ranks by row positions, verifies terminal pages and boundaries, and excludes private keys', async () => {
  const pages = reader()
  const result = await collectRankDistributionBoundaries({ sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks, fetchPage: pages.fetchPage })
  assert.equal(result.totalCount, 72)
  assert.deepEqual(result.entries, ranks.map(({ rankId }) => ({ rankId, count: 2 })))
  assert.equal(result.boundaries[35].countAtOrAbove, 2)
  assert.equal(result.requestCount, pages.requests.length)
  assert.equal(pages.requests.filter((page) => page === result.totalPages).length, 2)
  assert.ok(!JSON.stringify(result).includes('accountKey'))
  assert.ok(!result.observedChecks.includes('max-lp-account-unit-confirmed'))
  assert.ok(!result.observedChecks.includes('unranked-tail-confirmed'))
})

test('includes every row tied at a threshold across pages and preserves real zero-count ranks', async () => {
  const values = [
    ...Array.from({ length: 23 }, (_, index) => ({ rankId: 36, leaguePoint: 3500, accountKey: `top-${index}` })),
    { rankId: 2, leaguePoint: 100, accountKey: 'iron' },
    { rankId: 1, leaguePoint: 0, accountKey: 'rookie' },
  ]
  const pages = reader(values, 4)
  const result = await collectRankDistributionBoundaries({ sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks, fetchPage: pages.fetchPage })
  assert.equal(result.entries[35].count, 23)
  assert.equal(result.entries[1].count, 1)
  assert.equal(result.entries[0].count, 1)
  assert.ok(result.entries.slice(2, 35).every((entry) => entry.count === 0))
})

test('rejects observed live total changes and content changes even when the total stays the same', async () => {
  const first = reader()
  let count = 0
  await assert.rejects(collectRankDistributionBoundaries({
    sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks,
    fetchPage: async (page, url) => {
      const value = await first.fetchPage(page, url)
      if (++count > 1) { value.totalCount += 1; value.totalPages = Math.ceil(value.totalCount / value.pageSize) }
      return value
    },
  }), /総件数|ページの項目数/)
  const second = reader()
  const seen = new Set<number>()
  await assert.rejects(collectRankDistributionBoundaries({
    sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks,
    fetchPage: async (page, url) => {
      const value = await second.fetchPage(page, url)
      if (seen.has(page)) value.entries[0].leaguePoint -= 1
      seen.add(page)
      return value
    },
  }), /再確認|LP・ランク対応/)
})

test('rejects a clamped deep page, partial page, condition reset, or inconsistent last page', async () => {
  for (const alter of [
    (value: RankBoundaryPage) => { value.page = 1 },
    (value: RankBoundaryPage) => { value.sourceUrl = rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, 1) },
    (value: RankBoundaryPage) => { value.entries.pop() },
    (value: RankBoundaryPage) => { value.sourceUrl = value.sourceUrl.replace('character_filter=2', 'character_filter=1') },
    (value: RankBoundaryPage) => { value.totalPages += 1 },
  ]) {
    const pages = reader()
    await assert.rejects(collectRankDistributionBoundaries({
      sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks,
      fetchPage: async (page, url) => {
        const value = await pages.fetchPage(page, url)
        if (page > 1) alter(value)
        return value
      },
    }))
  }
})

test('rejects misordered pages, rank/LP mismatch, and observed account duplicates', async () => {
  const mutations = [
    (values: RankBoundaryEntry[]) => { [values[0], values[1]] = [values[1], values[0]] },
    (values: RankBoundaryEntry[]) => { [values[0], values[values.length - 1]] = [values[values.length - 1], values[0]] },
    (values: RankBoundaryEntry[]) => { values[0].rankId = 1 },
    (values: RankBoundaryEntry[]) => { values[0].rankId = 0 },
    (values: RankBoundaryEntry[]) => { values.at(-1)!.accountKey = values[0].accountKey },
  ]
  for (const mutate of mutations) {
    const values = entries()
    mutate(values)
    const pages = reader(values)
    await assert.rejects(collectRankDistributionBoundaries({ sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks, fetchPage: pages.fetchPage }))
  }
})

test('refuses unsupported URL conditions or mappings before any page is read', async () => {
  const pages = reader()
  for (const sourceUrl of [
    RANK_BOUNDARY_SOURCE_URL.replace('league_rank=0', 'league_rank=36'),
    `${RANK_BOUNDARY_SOURCE_URL}&league_rank=0`,
    `${RANK_BOUNDARY_SOURCE_URL}&toString=1`,
    RANK_BOUNDARY_SOURCE_URL.replace('www.streetfighter.com', 'example.com'),
  ]) await assert.rejects(collectRankDistributionBoundaries({ sourceUrl, ranks, fetchPage: pages.fetchPage }))
  await assert.rejects(collectRankDistributionBoundaries({ sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks: ranks.slice(1), fetchPage: pages.fetchPage }))
  assert.equal(pages.requests.length, 0)
})

test('stops at the request budget or cancellation without full-enumeration fallback', async () => {
  const pages = reader()
  await assert.rejects(collectRankDistributionBoundaries({ sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks, fetchPage: pages.fetchPage, maxRequests: 2 }), /上限/)
  assert.equal(pages.requests.length, 2)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(collectRankDistributionBoundaries({ sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks, fetchPage: pages.fetchPage, signal: controller.signal }), /中止/)
  assert.equal(pages.requests.length, 2)
})

test('keeps safe-integer positions accurate without overflowing the binary-search midpoint', async () => {
  const totalCount = Number.MAX_SAFE_INTEGER
  const result = await collectRankDistributionBoundaries({
    sourceUrl: RANK_BOUNDARY_SOURCE_URL, ranks,
    fetchPage: async (page, sourceUrl) => ({
      sourceUrl, page, pageSize: 1, totalCount, totalPages: totalCount,
      entries: [{ rankId: 1, leaguePoint: 0 }],
    }),
  })
  assert.equal(result.entries[0].count, totalCount)
  assert.ok(result.entries.slice(1).every((entry) => entry.count === 0))
})

test('direct rank IDs count all boundaries without an LP table, including equal-LP rows across ranks and pages', async () => {
  const values = [
    ...Array.from({ length: 23 }, (_, index) => ({ rankId: 36, leaguePoint: 100, accountKey: `top-${index}` })),
    ...Array.from({ length: 7 }, (_, index) => ({ rankId: 35, leaguePoint: 100, accountKey: `next-${index}` })),
    { rankId: 1, leaguePoint: 100, accountKey: 'tail' },
  ]
  const pages = reader(values, 4)
  const result = await collectRankDistributionBoundaries({
    mode: 'rank-id', sourceUrl: RANK_BOUNDARY_SOURCE_URL, fetchPage: pages.fetchPage,
  })
  assert.equal(result.totalCount, 31)
  assert.equal(result.entries[35].count, 23)
  assert.equal(result.entries[34].count, 7)
  assert.equal(result.entries[0].count, 1)
  assert.ok(result.entries.slice(1, 34).every(({ count }) => count === 0))
  assert.ok(result.boundaries.every((boundary) => !('minimumLp' in boundary)))
  assert.equal(result.boundaries[35].countAtOrAbove, 23)
  assert.equal(result.boundaries[34].countAtOrAbove, 30)
  assert.equal(pages.requests.filter((page) => page === result.totalPages).length, 2)
  assert.ok(!JSON.stringify(result).includes('accountKey'))
})

test('direct mode preserves all 36 explicitly displayed rank IDs even when LP does not distinguish them', async () => {
  const pages = reader(entries().map((entry) => ({ ...entry, leaguePoint: 0 })))
  const result = await collectRankDistributionBoundaries({
    mode: 'rank-id', sourceUrl: RANK_BOUNDARY_SOURCE_URL, fetchPage: pages.fetchPage,
  })
  assert.deepEqual(result.entries, ranks.map(({ rankId }) => ({ rankId, count: 2 })))
})

test('direct mode rejects unknown rank IDs instead of deriving their rank from LP', async () => {
  for (const rankId of [0, 37]) {
    const values = entries()
    values.at(-1)!.rankId = rankId
    const pages = reader(values)
    await assert.rejects(collectRankDistributionBoundaries({
      mode: 'rank-id', sourceUrl: RANK_BOUNDARY_SOURCE_URL, fetchPage: pages.fetchPage,
    }), /未ランクを補完しません/)
  }
})

test('direct mode rejects rank-order inversion within and between pages while LP remains tied', async () => {
  for (const [rankIds, pageSize, message] of [
    [[35, 36, 1], 3, /ページ内のランク順/],
    [[36, 34, 35, 1], 1, /ページ間のランク順/],
  ] as const) {
    const pages = reader(rankIds.map((rankId) => ({ rankId, leaguePoint: 100 })), pageSize)
    await assert.rejects(collectRankDistributionBoundaries({
      mode: 'rank-id', sourceUrl: RANK_BOUNDARY_SOURCE_URL, fetchPage: pages.fetchPage,
    }), message)
  }
})

test('direct mode retains independent LP ordering, total stability and fresh-content checks', async () => {
  const order = reader([{ rankId: 36, leaguePoint: 1 }, { rankId: 35, leaguePoint: 2 }])
  await assert.rejects(collectRankDistributionBoundaries({
    mode: 'rank-id', sourceUrl: RANK_BOUNDARY_SOURCE_URL, fetchPage: order.fetchPage,
  }), /LP順/)
  for (const change of ['total', 'content'] as const) {
    const pages = reader()
    const seen = new Set<number>()
    await assert.rejects(collectRankDistributionBoundaries({
      mode: 'rank-id', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
      fetchPage: async (page, url) => {
        const value = await pages.fetchPage(page, url)
        if (change === 'total' && pages.requests.length > 1) value.totalCount += 1
        if (change === 'content' && seen.has(page) && page === 1) value.entries[0].leaguePoint -= 1
        seen.add(page)
        return value
      },
    }), change === 'total' ? /総件数|最終ページ/ : /再確認/)
  }
})

test('rejects mixed direct-ID/LP configuration and unknown comparison modes before requesting pages', async () => {
  const pages = reader()
  for (const options of [
    { mode: 'rank-id', ranks }, { mode: 'unsupported', ranks },
  ]) {
    await assert.rejects(collectRankDistributionBoundaries({
      ...options, sourceUrl: RANK_BOUNDARY_SOURCE_URL, fetchPage: pages.fetchPage,
    } as Parameters<typeof collectRankDistributionBoundaries>[0]), /比較/)
  }
  assert.equal(pages.requests.length, 0)
})

test('shares every observed page across all boundaries for a virtual 3,060,715-account population', async (context) => {
  const totalCount = 3_060_715
  const pageSize = 20
  const weights = ranks.map(({ rankId }) => (rankId % 7 + 1) ** 2 + rankId * 3)
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
  const counts = weights.map((weight) => Math.floor(totalCount * weight / weightTotal))
  counts[35] += totalCount - counts.reduce((sum, count) => sum + count, 0)
  const cumulative = counts.map((_, index) => counts.slice(index).reduce((sum, count) => sum + count, 0))
  const rankAt = (position: number) => cumulative.findLastIndex((count) => position < count) + 1
  const requests: number[] = []
  const result = await collectRankDistributionBoundaries({
    mode: 'rank-id', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
    fetchPage: async (page, sourceUrl) => {
      requests.push(page)
      const offset = (page - 1) * pageSize
      return {
        sourceUrl, page, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize),
        entries: Array.from({ length: Math.min(pageSize, totalCount - offset) }, (_, index) => ({
          rankId: rankAt(offset + index), leaguePoint: 0, accountKey: `position-${offset + index}`,
        })),
      }
    },
  })
  assert.deepEqual(result.entries, counts.map((count, index) => ({ rankId: index + 1, count })))
  assert.deepEqual(result.boundaries.map(({ countAtOrAbove }) => countAtOrAbove), cumulative)

  // Count the previous independent [0, N] searches with the same page cache and
  // the same mandatory fresh boundary/terminal rereads, without allocating N rows.
  const previousPages = new Set([1, Math.ceil(totalCount / pageSize)])
  const boundaryPages = new Set(previousPages)
  for (const { rankId } of ranks) {
    let lower = 0
    let upper = totalCount
    while (lower < upper) {
      const position = lower + Math.floor((upper - lower) / 2)
      previousPages.add(Math.floor(position / pageSize) + 1)
      if (rankAt(position) >= rankId) lower = position + 1
      else upper = position
    }
    for (const position of [lower - 1, lower]) {
      if (position < 0 || position >= totalCount) continue
      const page = Math.floor(position / pageSize) + 1
      previousPages.add(page)
      boundaryPages.add(page)
    }
  }
  const previousRequestCount = previousPages.size + boundaryPages.size
  context.diagnostic(`shared requests: ${result.requestCount}; previous requests: ${previousRequestCount}`)
  assert.ok(result.requestCount < previousRequestCount)
  assert.equal(result.requestCount, requests.length)
  for (const count of cumulative) {
    for (const position of [count - 1, count]) {
      if (position < 0 || position >= totalCount) continue
      const page = Math.floor(position / pageSize) + 1
      assert.equal(requests.filter((request) => request === page).length, 2)
    }
  }
})

test('observed terminal ranks settle absent ranks and the entire rank-1 tail without interior reads', async () => {
  const totalCount = 3_060_715
  for (const mode of ['rank-id', 'league-point'] as const) {
    const requests: number[] = []
    const result = await collectRankDistributionBoundaries({
      ...(mode === 'rank-id' ? { mode } : { mode, ranks }), sourceUrl: RANK_BOUNDARY_SOURCE_URL,
      fetchPage: async (page, sourceUrl) => {
        requests.push(page)
        return {
          sourceUrl, page, pageSize: 20, totalCount, totalPages: Math.ceil(totalCount / 20),
          entries: Array.from({ length: Math.min(20, totalCount - (page - 1) * 20) }, () => ({ rankId: 1, leaguePoint: 0 })),
        }
      },
    })
    assert.deepEqual(requests, [1, result.totalPages, 1, result.totalPages])
    assert.equal(result.entries[0].count, totalCount)
    assert.ok(result.entries.slice(1).every(({ count }) => count === 0))
  }
})
