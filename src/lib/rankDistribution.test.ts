import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RankDistributionDataset, RankDistributionDescriptor, RankDistributionManifest } from '../types/rankDistribution.ts'
import {
  createRankDistributionRows, loadRankDistributionDataset, loadRankDistributionManifest,
  parseRankDistributionDataset, parseRankDistributionDescriptor, parseRankDistributionManifest,
  rankDistributionRankLabel, RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_SOURCE,
  RANK_DISTRIBUTION_VALIDATION_CHECKS,
} from './rankDistribution.ts'

const captureStartedAt = '2026-10-13T01:00:00.000Z'
const captureEndedAt = '2026-10-13T01:15:00.000Z'
const generatedAt = '2026-10-13T01:16:00.000Z'

function descriptor(overrides: Partial<RankDistributionDescriptor> = {}): RankDistributionDescriptor {
  return { id: '2026-10-13', path: '2026-10-13.json', captureStartedAt, captureEndedAt, totalCount: 36 * 37 / 2, ...overrides }
}

function dataset(overrides: Partial<RankDistributionDataset> = {}): RankDistributionDataset {
  return {
    schemaVersion: 1, id: descriptor().id, captureStartedAt, captureEndedAt, generatedAt,
    source: {
      ...RANK_DISTRIBUTION_SOURCE, population: '最大LPのランキング掲載アカウント',
      metric: 'ランク別の掲載アカウント数', unit: 'fighter-account',
      notes: ['取得期間中の観測値。実人数や活動人口とは異なる。'],
    },
    conditions: { ...RANK_DISTRIBUTION_CONDITIONS }, method: 'boundary-search', totalCount: descriptor().totalCount,
    entries: Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, count: index + 1 })),
    validation: {
      status: 'verified', coverage: 'all-listed-accounts', checks: [...RANK_DISTRIBUTION_VALIDATION_CHECKS],
      notes: ['末尾も含めて全掲載行が確認済みrank ID1〜36に分類されることを検証した。'],
    },
    ...overrides,
  }
}

function manifest(datasets: RankDistributionDescriptor[] = [descriptor()]): RankDistributionManifest {
  return { schemaVersion: 1, generatedAt, source: RANK_DISTRIBUTION_SOURCE, datasets }
}

test('empty manifest and collection status remain distinct from a zero-count distribution', () => {
  assert.deepEqual(parseRankDistributionManifest(manifest([])), manifest([]))
  const pending: RankDistributionManifest = {
    ...manifest([]), availability: { status: 'verification-pending', checkedAt: generatedAt, message: '取得方法の検証中' },
  }
  assert.deepEqual(parseRankDistributionManifest(pending), pending)
  const zero = dataset({ totalCount: 0, entries: dataset().entries.map((entry) => ({ ...entry, count: 0 })) })
  const rows = createRankDistributionRows(zero)
  assert.equal(rows.length, 8)
  assert.ok(rows.every((row) => row.count === 0 && row.percent === null && row.cumulativeCount === 0 && row.cumulativePercent === null))
  const failed: RankDistributionManifest = {
    ...manifest(), availability: { status: 'collection-failed', checkedAt: generatedAt, message: '最新の取得に失敗' },
  }
  assert.deepEqual(parseRankDistributionManifest(failed).datasets, [descriptor()])
  assert.throws(() => parseRankDistributionManifest({ ...failed, availability: { ...failed.availability, status: 'not-collected' } }), /already collected/)
})

test('complete counts are grouped and stars use the global denominator and upward cumulative count', () => {
  const rows = createRankDistributionRows(dataset())
  assert.deepEqual(rows.map((row) => [row.label, row.count]), [
    ['ROOKIE', 15], ['IRON', 40], ['BRONZE', 65], ['SILVER', 90], ['GOLD', 115],
    ['PLATINUM', 140], ['DIAMOND', 165], ['MASTER', 36],
  ])
  assert.equal(rows[0].cumulativeCount, 666)
  assert.equal(rows[0].cumulativePercent, 100)
  assert.equal(rows[6].cumulativeCount, 201)
  assert.equal(rows[7].cumulativeCount, 36)
  assert.equal(rows[4].percent, 115 / 666 * 100)
  const stars = createRankDistributionRows(dataset(), 'GOLD')
  assert.deepEqual(stars.map((row) => [row.rankId, row.label, row.count]), [
    [21, 'GOLD ★1', 21], [22, 'GOLD ★2', 22], [23, 'GOLD ★3', 23], [24, 'GOLD ★4', 24], [25, 'GOLD ★5', 25],
  ])
  assert.equal(stars[0].cumulativeCount, rows[4].cumulativeCount)
  assert.equal(stars[0].percent, 21 / 666 * 100)
  assert.equal(stars[4].cumulativeCount, 366) // IDs 25–36 inclusive.
  assert.equal(stars.reduce((sum, row) => sum + row.count, 0), rows[4].count)
  assert.equal(createRankDistributionRows(dataset(), 'MASTER').length, 1)
  assert.throws(() => createRankDistributionRows(dataset(), 'ULTIMATE_MASTER'), /group/)
  assert.equal(rankDistributionRankLabel(1), 'ROOKIE ★1')
  assert.equal(rankDistributionRankLabel(35), 'DIAMOND ★5')
  assert.equal(rankDistributionRankLabel(36), 'MASTER')
  assert.throws(() => rankDistributionRankLabel(0), /unknown rank/)
})

test('zero observed ranks retain 0% and are not represented as missing', () => {
  const input = dataset({ totalCount: 7, entries: dataset().entries.map((entry) => ({ ...entry, count: entry.rankId === 36 ? 7 : 0 })) })
  const rows = createRankDistributionRows(input)
  assert.equal(rows[0].percent, 0)
  assert.equal(rows[0].cumulativePercent, 100)
  assert.equal(rows[7].percent, 100)
})

test('rejects partial, duplicate, unknown and unsafe counts instead of filling missing ranks', () => {
  const reversed = dataset({ entries: dataset().entries.reverse() })
  assert.deepEqual(parseRankDistributionDataset(reversed), reversed)
  assert.deepEqual(createRankDistributionRows(reversed), createRankDistributionRows(dataset()))
  assert.throws(() => parseRankDistributionDataset(dataset({ entries: dataset().entries.slice(1) })), /all 36 ranks/)
  const duplicate = dataset()
  duplicate.entries[0].rankId = 2
  assert.throws(() => parseRankDistributionDataset(duplicate), /duplicate/)
  for (const rankId of [0, 37, 1.5]) {
    const unknown = dataset()
    unknown.entries[0].rankId = rankId
    assert.throws(() => parseRankDistributionDataset(unknown), /entry.rankId/)
  }
  for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, null]) {
    const input = dataset()
    const entries = [...input.entries]
    assert.throws(() => parseRankDistributionDataset({ ...input, entries: [{ rankId: 1, count }, ...entries.slice(1)] }), /entry.count/)
  }
  assert.throws(() => parseRankDistributionDataset(dataset({ totalCount: 665 })), /total mismatch/)
})

test('requires every collection verification and rejects mixed conditions or hidden personal fields', () => {
  const input = dataset()
  for (const check of RANK_DISTRIBUTION_VALIDATION_CHECKS) {
    assert.throws(() => parseRankDistributionDataset(dataset({ validation: { ...input.validation, checks: input.validation.checks.filter((item) => item !== check) } })), /checks: incomplete/)
  }
  assert.throws(() => parseRankDistributionDataset({ ...input, validation: { ...input.validation, status: 'pending' } }), /unverified/)
  assert.throws(() => parseRankDistributionDataset({ ...input, validation: { ...input.validation, coverage: 'sample' } }), /incomplete/)
  assert.throws(() => parseRankDistributionDataset({ ...input, validation: { ...input.validation, notes: [] } }), /notes: empty/)
  assert.throws(() => parseRankDistributionDataset({ ...input, conditions: { ...input.conditions, league: 'MASTER' } }), /conditions.league/)
  assert.throws(() => parseRankDistributionDataset({ ...input, conditions: { ...input.conditions, platform: 'steam' } }), /conditions.platform/)
  assert.throws(() => parseRankDistributionDataset({ ...input, playerIds: ['private-user'] }), /unknown field/)
  assert.throws(() => parseRankDistributionDataset({ ...input, entries: input.entries.map((entry) => ({ ...entry, shortId: 'private-user' })) }), /unknown field/)
  assert.throws(() => parseRankDistributionDataset({ ...input, source: { ...input.source, unit: 'person' } }), /source.unit/)
})

test('validates official source, safe file paths, uniqueness and chronological timestamps', () => {
  assert.deepEqual(parseRankDistributionDataset(dataset(), descriptor()), dataset())
  assert.deepEqual(parseRankDistributionDescriptor(descriptor()), descriptor())
  for (const path of ['../data.json', '/data.json', 'foo\\data.json', 'https://example.com/data.json', 'index.json', 'nested/../data.json']) {
    assert.throws(() => parseRankDistributionManifest(manifest([descriptor({ path })])), /path/)
  }
  for (const url of [
    'https://example.com/6/buckler/ja-jp/ranking/league', 'http://www.streetfighter.com/6/buckler/ja-jp/ranking/league',
    `${RANK_DISTRIBUTION_SOURCE.url}?page=1`, 'https://user:secret@www.streetfighter.com/6/buckler/ja-jp/ranking/league',
    'https://www.streetfighter.com/6/buckler/ja-jp/stats/usagerate',
  ]) assert.throws(() => parseRankDistributionDataset(dataset({ source: { ...dataset().source, url } })), /source.url/)
  assert.throws(() => parseRankDistributionManifest(manifest([descriptor(), descriptor({ id: 'other', path: 'other.json' })])), /capture interval/)
  assert.throws(() => parseRankDistributionDataset(dataset({ captureStartedAt: '2026-02-30T00:00:00Z' })), /captureStartedAt/)
  assert.throws(() => parseRankDistributionDataset(dataset({ captureStartedAt: generatedAt })), /reversed/)
  assert.throws(() => parseRankDistributionDataset(dataset({ generatedAt: captureStartedAt })), /before capture/)
  assert.throws(() => parseRankDistributionManifest({ ...manifest(), generatedAt: captureStartedAt }), /before capture/)
  assert.throws(() => parseRankDistributionDataset(dataset(), descriptor({ totalCount: 665 })), /一致しません/)
  assert.throws(() => parseRankDistributionDataset(dataset(), descriptor({ id: 'other' })), /一致しません/)
})

test('manifest HTTP failures are evicted so retry loads the actual empty manifest', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1
    return requests === 1 ? new Response('', { status: 503 }) : Response.json(manifest([]))
  })
  await assert.rejects(loadRankDistributionManifest(), /読み込めません/)
  assert.deepEqual(await loadRankDistributionManifest(), manifest([]))
  assert.equal(requests, 2)
})

test('dataset loader shares requests, validates descriptors, evicts invalid data and versions corrected publications', async (t) => {
  const selected = descriptor({ path: 'cache-test.json' })
  const requests: string[] = []
  let published = dataset()
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(String(input))
    return Response.json(requests.length === 1 ? { ...published, entries: [] } : published)
  })
  await assert.rejects(loadRankDistributionDataset(selected, generatedAt), /all 36 ranks/)
  const [left, right] = await Promise.all([loadRankDistributionDataset(selected, generatedAt), loadRankDistributionDataset(selected, generatedAt)])
  assert.strictEqual(left, right)
  assert.equal(requests.length, 2)
  await assert.rejects(loadRankDistributionDataset({ ...selected, id: 'mismatched' }, generatedAt), /一致しません/)
  await loadRankDistributionDataset(selected, generatedAt)
  assert.equal(requests.length, 3)
  published = dataset()
  published.entries[0].count += 1
  published.entries[1].count -= 1
  const newerPublication = '2026-10-13T01:20:00.000Z'
  const updated = await loadRankDistributionDataset(selected, newerPublication)
  assert.equal(updated.entries[0].count, 2)
  assert.equal(left.entries[0].count, 1)
  assert.equal(requests.length, 4)
  assert.ok(requests[0].includes('/data/rank-distribution/cache-test.json?v='))
  assert.ok(requests[3].includes(`published=${encodeURIComponent(newerPublication)}`))
})
