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
