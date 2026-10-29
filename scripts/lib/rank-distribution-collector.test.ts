import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRankDistributionDataset, RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_SOURCE, RANK_DISTRIBUTION_VALIDATION_CHECKS } from '../../src/lib/rankDistribution.ts'
import { rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'
import type { RankBoundaryEntry, RankBoundaryPage } from './rank-distribution-boundaries.ts'
import {
  collectRankDistributionDataset, RankDistributionCollectionError,
} from './rank-distribution-collector.ts'
import type { RankDistributionCollectionErrorCode, RankDistributionCollectionOptions } from './rank-distribution-collector.ts'

// Synthetic mapping, rows and observations only; no current official population is asserted.
const ranks = Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, minimumLp: index * 100 }))
const start = '2026-10-15T01:00:00.000Z'
const end = '2026-10-15T01:01:00.000Z'
const confirmed = { status: 'confirmed' as const, sourceUrl: RANK_DISTRIBUTION_SOURCE.url, note: '人工テストで確認した根拠。実データではない。' }

function fixture(values?: RankBoundaryEntry[], pageSize = 5) {
  const rows = values ?? ranks.toReversed().flatMap(({ rankId, minimumLp }) => [10, 0].map((offset) => ({
    rankId, leaguePoint: minimumLp + offset, accountKey: `private-account-${rankId}-${offset}`,
  })))
  const requests: number[] = []
  const fetchPage = async (page: number, sourceUrl: string): Promise<RankBoundaryPage> => {
    requests.push(page)
    return {
      sourceUrl, page, pageSize, totalCount: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
      entries: structuredClone(rows.slice((page - 1) * pageSize, page * pageSize)),
    }
  }
  const times = [new Date(start), new Date(end)]
  const options: RankDistributionCollectionOptions = {
    fetchPage, ranks, currentMappingEvidence: { ...confirmed }, maxLpAccountUnitEvidence: { ...confirmed },
    unrankedTailEvidence: { ...confirmed }, now: () => times.shift()!,
  }
  return { requests, fetchPage, options }
}

async function rejectsCode(options: RankDistributionCollectionOptions, expected: RankDistributionCollectionErrorCode) {
  await assert.rejects(collectRankDistributionDataset(options), (error: unknown) => {
    assert.ok(error instanceof RankDistributionCollectionError)
    assert.equal(error.code, expected)
    assert.equal('cause' in error, false)
    return true
  })
}

test('collects a complete verified synthetic interval through the existing strict boundaries and schema', async () => {
  const input = fixture()
  const result = await collectRankDistributionDataset(input.options)
  assert.deepEqual(parseRankDistributionDataset(result), result)
  assert.deepEqual(result.conditions, RANK_DISTRIBUTION_CONDITIONS)
  assert.equal(result.id, 'max-lp-2026-10-15T01-00-00-000Z')
  assert.equal(result.captureStartedAt, start)
  assert.equal(result.captureEndedAt, end)
  assert.equal(result.generatedAt, end)
  assert.equal(result.totalCount, 72)
  assert.deepEqual(result.entries, ranks.map(({ rankId }) => ({ rankId, count: 2 })))
  assert.deepEqual(new Set(result.validation.checks), new Set(RANK_DISTRIBUTION_VALIDATION_CHECKS))
  assert.match(result.validation.notes.join(' '), /人工テスト/)
  assert.match(result.validation.notes.join(' '), /原子的なスナップショット/)
  assert.ok(input.requests.filter((page) => page === 1).length >= 2)
  assert.ok(!JSON.stringify(result).includes('accountKey'))
  assert.ok(!JSON.stringify(result).includes('private-account'))
})

test('preserves actual observed zero-count ranks and includes LP ties across pages', async () => {
  const input = fixture([
    ...Array.from({ length: 23 }, (_, index) => ({ rankId: 36, leaguePoint: 3500, accountKey: `private-top-${index}` })),
    { rankId: 2, leaguePoint: 100 }, { rankId: 1, leaguePoint: 0 },
  ], 4)
  const result = await collectRankDistributionDataset(input.options)
  assert.equal(result.totalCount, 25)
  assert.equal(result.entries[35].count, 23)
  assert.equal(result.entries[1].count, 1)
  assert.equal(result.entries[0].count, 1)
  assert.ok(result.entries.slice(2, 35).every(({ count }) => count === 0))
})

test('requires all three explicit confirmations before reading pages', async () => {
  for (const key of ['currentMappingEvidence', 'maxLpAccountUnitEvidence', 'unrankedTailEvidence'] as const) {
    for (const value of [undefined, { ...confirmed, status: 'pending' }]) {
      const input = fixture()
      await rejectsCode({ ...input.options, [key]: value } as RankDistributionCollectionOptions, 'evidence-unconfirmed')
      assert.equal(input.requests.length, 0)
    }
  }
})

test('rejects different conditions, arbitrary domains, unknown evidence fields and raw markup', async () => {
  for (const sourceUrl of [
    'https://example.com/ranking', `${RANK_DISTRIBUTION_SOURCE.url}?page=1`,
    RANK_BOUNDARY_SOURCE_URL.replace('league_rank=0', 'league_rank=36'),
    `${RANK_BOUNDARY_SOURCE_URL}&cookie=private-value`, `${RANK_BOUNDARY_SOURCE_URL}&page=bad`,
  ]) {
    const input = fixture()
    await rejectsCode({ ...input.options, currentMappingEvidence: { ...confirmed, sourceUrl } }, 'evidence-source-mismatch')
    assert.equal(input.requests.length, 0)
  }
  for (const value of [{ ...confirmed, privateDOM: 'private' }, { ...confirmed, note: '<div>raw markup</div>' }, { ...confirmed, note: '' }]) {
    const input = fixture()
    await rejectsCode({ ...input.options, unrankedTailEvidence: value }, 'invalid-evidence')
    assert.equal(input.requests.length, 0)
  }
})

test('accepts a confirmed deep-page source only under the exact fixed conditions', async () => {
  const input = fixture()
  input.options.unrankedTailEvidence.sourceUrl = rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, 15)
  assert.equal((await collectRankDistributionDataset(input.options)).entries.length, 36)
})

test('rejects missing or inconsistent LP mappings before any page request', async () => {
  for (const invalid of [ranks.slice(1), ranks.map((rank, index) => ({ ...rank, minimumLp: index === 2 ? 0 : rank.minimumLp }))]) {
    const input = fixture()
    await rejectsCode({ ...input.options, ranks: invalid }, 'invalid-rank-mapping')
    assert.equal(input.requests.length, 0)
  }
})

test('rejects changing totals and reobserved boundary content without producing a dataset', async () => {
  const totals = fixture()
  await rejectsCode({
    ...totals.options, fetchPage: async (page, url) => {
      const value = await totals.fetchPage(page, url)
      if (totals.requests.length > 1) { value.totalCount += 1; value.totalPages = Math.ceil(value.totalCount / value.pageSize) }
      return value
    },
  }, 'total-changed')
  const content = fixture()
  const seen = new Set<number>()
  await rejectsCode({
    ...content.options, fetchPage: async (page, url) => {
      const value = await content.fetchPage(page, url)
      if (seen.has(page) && page === 1) value.entries[0].leaguePoint -= 1
      seen.add(page)
      return value
    },
  }, 'observation-changed')
})

test('refuses unknown tail ranks even when a caller supplies a tail confirmation', async () => {
  const input = fixture()
  await rejectsCode({
    ...input.options, fetchPage: async (page, url) => {
      const value = await input.fetchPage(page, url)
      if (page === value.totalPages) value.entries.at(-1)!.rankId = 0
      return value
    },
  }, 'unknown-rank')
})

test('rejects partial or clamped pages and changing conditions', async () => {
  for (const mutate of [
    (page: RankBoundaryPage) => { page.entries.pop() },
    (page: RankBoundaryPage) => { page.page = 1 },
  ]) {
    const input = fixture()
    await rejectsCode({ ...input.options, fetchPage: async (page, url) => {
      const value = await input.fetchPage(page, url)
      if (page > 1) mutate(value)
      return value
    } }, 'invalid-page')
  }
  const input = fixture()
  await rejectsCode({ ...input.options, fetchPage: async (page, url) => {
    const value = await input.fetchPage(page, url)
    value.sourceUrl = value.sourceUrl.replace('character_filter=2', 'character_filter=1')
    return value
  } }, 'conditions-changed')
})

test('sanitizes transport errors and drops raw page metadata from successful results', async () => {
  const input = fixture()
  await assert.rejects(collectRankDistributionDataset({ ...input.options, fetchPage: async () => {
    throw new Error('cookie=private-value accountKey=private-account <div>private DOM</div>')
  } }), (error: unknown) => {
    assert.ok(error instanceof RankDistributionCollectionError)
    assert.equal(error.code, 'page-read-failed')
    assert.ok(!JSON.stringify(error).includes('private'))
    assert.ok(!String(error).includes('private'))
    return true
  })
  const successful = fixture()
  const result = await collectRankDistributionDataset({ ...successful.options, fetchPage: async (page, url) => ({
    ...await successful.fetchPage(page, url), privateDOM: '<div>private DOM</div>', cookie: 'private-value',
  }) })
  assert.ok(!JSON.stringify(result).includes('private'))
})

test('stops at its finite budget or cancellation without an enumeration fallback', async () => {
  const limit = fixture()
  await rejectsCode({ ...limit.options, maxRequests: 2 }, 'request-limit')
  assert.equal(limit.requests.length, 2)
  const controller = new AbortController()
  controller.abort(new Error('private abort reason'))
  const before = fixture()
  await rejectsCode({ ...before.options, signal: controller.signal }, 'cancelled')
  assert.equal(before.requests.length, 0)
  const duringController = new AbortController()
  const during = fixture()
  await rejectsCode({ ...during.options, signal: duringController.signal, fetchPage: async (page, url) => {
    const value = await during.fetchPage(page, url)
    duringController.abort()
    return value
  } }, 'cancelled')
  assert.equal(during.requests.length, 1)
})

test('refuses invalid or reversed clocks and never includes a raw clock error', async () => {
  for (const now of [() => new Date(NaN), () => { throw new Error('private clock error') }]) {
    const input = fixture()
    await rejectsCode({ ...input.options, now }, 'invalid-time')
    assert.equal(input.requests.length, 0)
  }
  const input = fixture()
  const reversed = [new Date(end), new Date(start)]
  await rejectsCode({ ...input.options, now: () => reversed.shift()! }, 'invalid-time')
})

test('direct rank-ID mode uses official display-label evidence without inventing LP thresholds', async () => {
  const input = fixture()
  const { ranks: _unusedRanks, mode: _unusedMode, ...common } = input.options
  const result = await collectRankDistributionDataset({
    ...common, mode: 'rank-id', currentMappingEvidence: {
      ...confirmed, note: '人工テストの公式表示名と画像IDの対応を確認。LPから逆算していない。',
    },
    fetchPage: async (page, url) => {
      const value = await input.fetchPage(page, url)
      value.entries = value.entries.map((entry) => ({ ...entry, leaguePoint: 100 }))
      return value
    },
  })
  assert.deepEqual(result.entries, ranks.map(({ rankId }) => ({ rankId, count: 2 })))
  assert.match(result.validation.notes[0], /公式ランクID・表示名対応/)
  assert.ok(!JSON.stringify(result).includes('minimumLp'))
})

test('direct rank-ID mode still refuses unknown ranks and malformed mixed configuration', async () => {
  for (const rankId of [0, 37]) {
    const input = fixture()
    const { ranks: _unusedRanks, mode: _unusedMode, ...common } = input.options
    await rejectsCode({
      ...common, mode: 'rank-id', fetchPage: async (page, url) => {
        const value = await input.fetchPage(page, url)
        if (page === value.totalPages) value.entries.at(-1)!.rankId = rankId
        return value
      },
    }, 'unknown-rank')
  }
  const mixed = fixture()
  await rejectsCode({ ...mixed.options, mode: 'rank-id', ranks } as unknown as RankDistributionCollectionOptions, 'invalid-options')
  assert.equal(mixed.requests.length, 0)
})
