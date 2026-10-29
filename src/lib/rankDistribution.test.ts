import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RankDistributionDataset, RankDistributionDescriptor, RankDistributionManifest } from '../types/rankDistribution.ts'
import {
  createRankDistributionRows,
  parseRankDistributionDataset, parseRankDistributionDescriptor, parseRankDistributionManifest,
  rankDistributionRankLabel, RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_SOURCE,
  RANK_DISTRIBUTION_ESTIMATE_CHECKS, RANK_DISTRIBUTION_VALIDATION_CHECKS,
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

function estimatedDataset(): RankDistributionDataset {
  const input = dataset()
  return {
    ...input, method: 'boundary-search-estimate',
    validation: {
      status: 'estimated', coverage: 'all-rank-boundaries', checks: [...RANK_DISTRIBUTION_ESTIMATE_CHECKS],
      notes: ['全35境界の観測から算出した概数。同一瞬間の人数や個別アカウント全件照合済みの値ではない。'],
    },
    observation: {
      totalAtStart: 664, totalAtEnd: input.totalCount, minTotal: 664, maxTotal: 669,
      boundaries: Array.from({ length: 35 }, (_, index) => ({
        rankId: index + 2,
        countAtOrAbove: input.entries.filter((item) => item.rankId >= index + 2).reduce((sum, item) => sum + item.count, 0),
        totalCount: input.totalCount,
        observedAt: '2026-10-13T01:05:00.000Z',
      })),
    },
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
  assert.equal(input.conditions.users, 'buckler-user-status-1')
  // A URL value alone must not be promoted to an independently confirmed all-users scope.
  assert.throws(() => parseRankDistributionDataset({ ...input, conditions: { ...input.conditions, users: 'all' } }), /conditions.users/)
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

test('estimated distribution round-trips all boundary observations and retains existing aggregation', () => {
  const input = estimatedDataset()
  assert.deepEqual(parseRankDistributionDataset(JSON.parse(JSON.stringify(input)), descriptor()), input)
  assert.deepEqual(createRankDistributionRows(input), createRankDistributionRows(dataset()))
  assert.deepEqual(createRankDistributionRows(input, 'GOLD'), createRankDistributionRows(dataset(), 'GOLD'))
  const reversed = structuredClone(input)
  reversed.entries.reverse()
  reversed.observation!.boundaries.reverse()
  assert.deepEqual(parseRankDistributionDataset(reversed), reversed)
  // Previously accepted strict observations retain their exact stored representation.
  assert.deepEqual(parseRankDistributionDataset(dataset()), dataset())
})

test('estimate and strict collection methods cannot exchange validation claims or observation fields', () => {
  const estimate = estimatedDataset()
  assert.throws(() => parseRankDistributionDataset({ ...estimate, observation: undefined }), /observation/)
  const withoutObservation = { ...estimate }
  delete withoutObservation.observation
  assert.throws(() => parseRankDistributionDataset(withoutObservation), /observation/)
  assert.throws(() => parseRankDistributionDataset({ ...dataset(), observation: estimate.observation }), /estimates only/)
  assert.throws(() => parseRankDistributionDataset({ ...dataset(), observation: undefined }), /estimates only/)
  assert.throws(() => parseRankDistributionDataset({ ...estimate, validation: dataset().validation }), /validation.status/)
  assert.throws(() => parseRankDistributionDataset({ ...dataset(), validation: estimate.validation }), /validation.status/)
  assert.throws(() => parseRankDistributionDataset({ ...estimate, validation: { ...estimate.validation, coverage: 'all-listed-accounts' } }), /validation.coverage/)
  assert.throws(() => parseRankDistributionDataset({ ...estimate, validation: { ...estimate.validation, checks: [...RANK_DISTRIBUTION_VALIDATION_CHECKS] } }), /checks: incomplete/)
  for (const check of RANK_DISTRIBUTION_ESTIMATE_CHECKS) {
    assert.throws(() => parseRankDistributionDataset({ ...estimate, validation: { ...estimate.validation,
      checks: estimate.validation.checks.filter((item) => item !== check) } }), /checks: incomplete/)
  }
  assert.throws(() => parseRankDistributionDataset({ ...estimate, validation: { ...estimate.validation, notes: [] } }), /notes: empty/)
})

test('every estimated rank boundary must be observed once with no private or unknown fields', () => {
  for (const mutate of [
    (input: RankDistributionDataset) => { input.observation!.boundaries.pop() },
    (input: RankDistributionDataset) => { input.observation!.boundaries[0].rankId = 3 },
    (input: RankDistributionDataset) => { input.observation!.boundaries[0].rankId = 1 },
    (input: RankDistributionDataset) => { input.observation!.boundaries[0].rankId = 37 },
    (input: RankDistributionDataset) => { input.observation!.boundaries[0].rankId = 2.5 },
  ]) {
    const input = estimatedDataset()
    mutate(input)
    assert.throws(() => parseRankDistributionDataset(input), /boundar/)
  }
  const input = estimatedDataset()
  assert.throws(() => parseRankDistributionDataset({ ...input, observation: { ...input.observation, playerIds: ['private-user'] } }), /unknown field/)
  assert.throws(() => parseRankDistributionDataset({ ...input, observation: { ...input.observation,
    boundaries: input.observation!.boundaries.map((item) => ({ ...item, accountKey: 'private-hash' })) } }), /unknown field/)
})

test('estimated cumulative counts must match nonnegative entries and their own observed total', () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null]) {
    const input = estimatedDataset()
    assert.throws(() => parseRankDistributionDataset({ ...input, observation: { ...input.observation,
      boundaries: input.observation!.boundaries.map((item, index) => index === 0 ? { ...item, countAtOrAbove: value } : item) } }), /countAtOrAbove/)
  }
  const ownTotal = estimatedDataset()
  ownTotal.observation!.boundaries[0].totalCount = 1
  assert.throws(() => parseRankDistributionDataset(ownTotal), /exceeds observed total/)
  const wrongCumulative = estimatedDataset()
  wrongCumulative.observation!.boundaries[1].countAtOrAbove = wrongCumulative.observation!.boundaries[0].countAtOrAbove + 1
  assert.throws(() => parseRankDistributionDataset(wrongCumulative), /cumulative mismatch/)
  const wrongEntries = estimatedDataset()
  wrongEntries.entries[0].count += 1
  wrongEntries.entries[1].count -= 1
  assert.throws(() => parseRankDistributionDataset(wrongEntries), /cumulative mismatch/)
  const negative = estimatedDataset()
  negative.entries[0].count = -1
  assert.throws(() => parseRankDistributionDataset(negative), /entry.count/)
  const missing = estimatedDataset()
  missing.entries.pop()
  assert.throws(() => parseRankDistributionDataset(missing), /all 36 ranks/)
})

test('estimated observations require safe total ranges and the final denominator', () => {
  for (const field of ['totalAtStart', 'totalAtEnd', 'minTotal', 'maxTotal'] as const) {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      const input = estimatedDataset()
      assert.throws(() => parseRankDistributionDataset({ ...input, observation: { ...input.observation, [field]: value } }), /observation/)
    }
  }
  for (const mutate of [
    (input: RankDistributionDataset) => { input.observation!.minTotal = 670 },
    (input: RankDistributionDataset) => { input.observation!.totalAtEnd -= 1 },
    (input: RankDistributionDataset) => { input.observation!.totalAtStart = 663 },
    (input: RankDistributionDataset) => { input.observation!.maxTotal = 665 },
    (input: RankDistributionDataset) => { input.observation!.boundaries[0].totalCount = 670 },
    (input: RankDistributionDataset) => { input.observation!.boundaries[0].totalCount = 1.5 },
  ]) {
    const input = estimatedDataset()
    mutate(input)
    assert.throws(() => parseRankDistributionDataset(input), /observation/)
  }
})

test('estimated observation timestamps must fall within the capture interval', () => {
  for (const observedAt of ['2026-10-13T00:59:59.999Z', '2026-10-13T01:15:00.001Z', '2026-02-30T01:05:00Z', 'not-a-date']) {
    const input = estimatedDataset()
    input.observation!.boundaries[0].observedAt = observedAt
    assert.throws(() => parseRankDistributionDataset(input), /observedAt/)
  }
  const edges = estimatedDataset()
  edges.observation!.boundaries[0].observedAt = captureStartedAt
  edges.observation!.boundaries[34].observedAt = captureEndedAt
  assert.deepEqual(parseRankDistributionDataset(edges), edges)
})

test('a zero-count estimate retains observed boundaries without producing invalid percentages', () => {
  const input = estimatedDataset()
  input.totalCount = 0
  input.entries = input.entries.map((item) => ({ ...item, count: 0 }))
  input.observation = {
    totalAtStart: 0, totalAtEnd: 0, minTotal: 0, maxTotal: 0,
    boundaries: input.observation!.boundaries.map((item) => ({ ...item, totalCount: 0, countAtOrAbove: 0 })),
  }
  assert.deepEqual(parseRankDistributionDataset(input), input)
  assert.ok(createRankDistributionRows(input).every((row) => row.count === 0 && row.percent === null && row.cumulativePercent === null))
})
