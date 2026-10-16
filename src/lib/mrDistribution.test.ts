import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MrDistributionDataset, MrDistributionDescriptor, MrDistributionManifest } from '../types/mrDistribution.ts'
import {
  createMrDistributionRows, loadMrDistributionDataset, loadMrDistributionManifest, mrDistributionBinLabel,
  MR_DISTRIBUTION_CHECKS, MR_DISTRIBUTION_CONDITIONS, MR_DISTRIBUTION_SOURCE, MR_DISTRIBUTION_THRESHOLDS,
  parseMrDistributionDataset, parseMrDistributionDescriptor, parseMrDistributionManifest,
} from './mrDistribution.ts'

const captureStartedAt = '2026-10-16T13:00:00.000Z'
const captureEndedAt = '2026-10-16T13:10:00.000Z'
const generatedAt = '2026-10-16T13:11:00.000Z'

function dataset(counts = Array.from({ length: 26 }, (_, index) => index + 1)): MrDistributionDataset {
  const entries = counts.map((count, index) => ({ minimum: index * 100, maximum: index === 25 ? null : (index + 1) * 100, count }))
  const totalCount = counts.reduce((sum, count) => sum + count, 0)
  return {
    schemaVersion: 1, id: 'max-mr-estimate-test', captureStartedAt, captureEndedAt, generatedAt,
    source: { ...MR_DISTRIBUTION_SOURCE, population: '今Act・最大MRの掲載アカウント', metric: '100MR区間別の掲載件数の概数',
      unit: 'fighter-account', notes: ['人工テスト。未掲載者や全件の一意性を示す値ではない。'] },
    conditions: { ...MR_DISTRIBUTION_CONDITIONS }, method: 'boundary-search-estimate', binWidth: 100, totalCount, entries,
    observation: { totalAtStart: totalCount, totalAtEnd: totalCount, minTotal: totalCount, maxTotal: totalCount,
      boundaries: MR_DISTRIBUTION_THRESHOLDS.map(minimumMr => ({ minimumMr,
        countAtOrAbove: entries.filter(bin => bin.minimum >= minimumMr).reduce((sum, bin) => sum + bin.count, 0),
        totalCount, observedAt: '2026-10-16T13:05:00.000Z' })) },
    validation: { status: 'estimated', coverage: 'all-mr-boundaries', checks: [...MR_DISTRIBUTION_CHECKS],
      notes: ['人工テストの全境界。時点の異なる概数。'] },
  }
}

function descriptor(): MrDistributionDescriptor {
  const value = dataset()
  return { id: value.id, path: `${value.id}.json`, captureStartedAt, captureEndedAt, totalCount: value.totalCount }
}

function manifest(datasets: MrDistributionDescriptor[] = [descriptor()]): MrDistributionManifest {
  return { schemaVersion: 1, generatedAt, source: MR_DISTRIBUTION_SOURCE, datasets }
}

test('complete MR bins retain raw percentages, upward cumulative counts and fixed ordering', () => {
  const value = dataset()
  assert.deepEqual(parseMrDistributionDataset(value, descriptor()), value)
  const rows = createMrDistributionRows(value)
  assert.equal(rows.length, 26)
  assert.deepEqual(rows[0], { id: 'mr-0', label: '0〜99', group: 'MR', rankId: null, count: 1,
    percent: 1 / 351 * 100, cumulativeCount: 351, cumulativePercent: 100 })
  assert.equal(rows[15].label, '1500〜1599')
  assert.equal(rows[15].count, 16)
  assert.equal(rows[15].percent, 16 / 351 * 100)
  assert.equal(rows[25].label, '2500以上')
  assert.equal(rows[25].cumulativeCount, 26)
  assert.equal(rows[25].cumulativePercent, 26 / 351 * 100)
  value.entries.reverse()
  value.observation.boundaries.reverse()
  assert.deepEqual(createMrDistributionRows(value), rows)
  assert.equal(mrDistributionBinLabel(2400, 2500), '2400〜2499')
  assert.throws(() => mrDistributionBinLabel(2500, 2600), /maximum/)
})

test('uncollected, failed, true zero totals and genuine zero bins remain distinct', () => {
  const empty = { ...manifest([]), availability: { status: 'not-collected', message: '未取得', checkedAt: generatedAt } }
  assert.deepEqual(parseMrDistributionManifest(empty), empty)
  const failed = { ...manifest(), availability: { status: 'collection-failed', message: '取得失敗', checkedAt: generatedAt } }
  assert.equal(parseMrDistributionManifest(failed).datasets.length, 1)
  assert.throws(() => parseMrDistributionManifest({ ...failed, availability: { ...failed.availability, status: 'not-collected' } }), /already collected/)
  const zero = dataset(Array(26).fill(0))
  assert.ok(createMrDistributionRows(zero).every(row => row.count === 0 && row.percent === null && row.cumulativePercent === null))
  const one = dataset(Array.from({ length: 26 }, (_, index) => index === 15 ? 7 : 0))
  assert.equal(createMrDistributionRows(one)[0].percent, 0)
  assert.equal(createMrDistributionRows(one)[15].percent, 100)
})

test('all bins and exact exclusive bounds are required; missing and invalid counts are not filled', () => {
  for (const change of [
    (value: MrDistributionDataset) => { value.entries.pop() },
    (value: MrDistributionDataset) => { value.entries[0].minimum = 100 },
    (value: MrDistributionDataset) => { value.entries[0].minimum = 50 },
    (value: MrDistributionDataset) => { value.entries[0].maximum = 99 },
    (value: MrDistributionDataset) => { value.entries[25].maximum = 2600 },
    (value: MrDistributionDataset) => { value.entries[0].count = -1 },
    (value: MrDistributionDataset) => { value.entries[0].count = 1.5 },
    (value: MrDistributionDataset) => { value.entries[0].count = Number.MAX_SAFE_INTEGER + 1 },
    (value: MrDistributionDataset) => { value.totalCount += 1 },
  ]) {
    const value = dataset(); change(value)
    assert.throws(() => parseMrDistributionDataset(value))
  }
  const value = dataset()
  assert.throws(() => parseMrDistributionDataset({ ...value, entries: value.entries.map(({ count: _count, ...bin }) => bin) }), /count/)
  assert.throws(() => parseMrDistributionDataset({ ...value, entries: value.entries.map(bin => ({ ...bin, count: Number.MAX_SAFE_INTEGER })) }), /total mismatch/)
})

test('requires every MR boundary and rejects inconsistent cumulative differences', () => {
  for (const change of [
    (value: MrDistributionDataset) => { value.observation.boundaries.pop() },
    (value: MrDistributionDataset) => { value.observation.boundaries[0].minimumMr = 200 },
    (value: MrDistributionDataset) => { value.observation.boundaries[0].minimumMr = 0 },
    (value: MrDistributionDataset) => { value.observation.boundaries[0].countAtOrAbove -= 1 },
    (value: MrDistributionDataset) => { value.observation.boundaries[0].countAtOrAbove = 352 },
    (value: MrDistributionDataset) => { value.entries[0].count += 1; value.entries[1].count -= 1 },
  ]) {
    const value = dataset(); change(value)
    assert.throws(() => parseMrDistributionDataset(value), /observation/)
  }
  const { observation: _observation, ...missing } = dataset()
  assert.throws(() => parseMrDistributionDataset(missing), /observation/)
})

test('observations must use safe totals, correct final denominator and capture timestamps', () => {
  for (const change of [
    (value: MrDistributionDataset) => { value.observation.totalAtStart = 350 },
    (value: MrDistributionDataset) => { value.observation.totalAtEnd -= 1 },
    (value: MrDistributionDataset) => { value.observation.minTotal = 352 },
    (value: MrDistributionDataset) => { value.observation.maxTotal = 350 },
    (value: MrDistributionDataset) => { value.observation.boundaries[0].totalCount = 352 },
    (value: MrDistributionDataset) => { value.observation.boundaries[0].observedAt = '2026-10-16T12:59:59.999Z' },
    (value: MrDistributionDataset) => { value.observation.boundaries[0].observedAt = '2026-10-16T13:10:00.001Z' },
    (value: MrDistributionDataset) => { value.observation.boundaries[0].observedAt = '2026-02-30T13:05:00Z' },
  ]) {
    const value = dataset(); change(value)
    assert.throws(() => parseMrDistributionDataset(value), /observation/)
  }
  for (const field of ['totalAtStart', 'totalAtEnd', 'minTotal', 'maxTotal'] as const) {
    const value = dataset()
    assert.throws(() => parseMrDistributionDataset({ ...value, observation: { ...value.observation, [field]: null } }))
  }
  const value = dataset()
  value.observation.totalAtStart = 349; value.observation.minTotal = 349; value.observation.maxTotal = 353
  value.observation.boundaries[0].observedAt = captureStartedAt
  value.observation.boundaries[24].observedAt = captureEndedAt
  assert.deepEqual(parseMrDistributionDataset(value), value)
})

test('rejects private fields and condition/source drift instead of publishing them', () => {
  const value = dataset()
  for (const input of [
    { ...value, userCode: 'private-test-id' },
    { ...value, source: { ...value.source, cookies: 'private' } },
    { ...value, entries: value.entries.map(bin => ({ ...bin, playerName: 'private' })) },
    { ...value, observation: { ...value.observation, rows: [] } },
    { ...value, observation: { ...value.observation, boundaries: value.observation.boundaries.map(bin => ({ ...bin, accountId: 'private' })) } },
    { ...value, conditions: { ...value.conditions, act: 'previous' } },
    { ...value, conditions: { ...value.conditions, character: 'all' } },
    { ...value, conditions: { ...value.conditions, platform: 'pc' } },
    { ...value, source: { ...value.source, url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league' } },
    { ...value, source: { ...value.source, url: `${MR_DISTRIBUTION_SOURCE.url}?page=1` } },
    { ...value, source: { ...value.source, url: 'https://user:secret@www.streetfighter.com/6/buckler/ja-jp/ranking/master' } },
  ]) assert.throws(() => parseMrDistributionDataset(input))
})

test('accepts only complete estimated coverage and its exact required checks', () => {
  const value = dataset()
  for (const input of [
    { ...value, method: 'boundary-search' }, { ...value, binWidth: 50 }, { ...value, schemaVersion: 2 },
    { ...value, validation: { ...value.validation, status: 'verified' } },
    { ...value, validation: { ...value.validation, coverage: 'single-interval' } },
    { ...value, validation: { ...value.validation, checks: value.validation.checks.slice(1) } },
    { ...value, validation: { ...value.validation, checks: [...value.validation.checks, value.validation.checks[0]] } },
    { ...value, validation: { ...value.validation, notes: [] } },
  ]) assert.throws(() => parseMrDistributionDataset(input))
})

test('descriptors, manifest dates, capture identity and registered paths are validated', () => {
  assert.deepEqual(parseMrDistributionDescriptor(descriptor()), descriptor())
  for (const path of ['../private.json', 'index.json', 'a\\b.json', '/a.json', 'a.txt', 'https://example.com/a.json']) {
    assert.throws(() => parseMrDistributionDescriptor({ ...descriptor(), path }))
  }
  assert.throws(() => parseMrDistributionManifest(manifest([descriptor(), descriptor()])), /duplicate/)
  assert.throws(() => parseMrDistributionManifest({ ...manifest(), generatedAt: captureStartedAt }), /before capture/)
  assert.throws(() => parseMrDistributionManifest({ ...manifest([]), availability: { status: 'not-collected', message: '未取得', checkedAt: '2026-10-17T13:00:00Z' } }), /after publication/)
  for (const [key, value] of [['id', 'wrong'], ['totalCount', 352], ['captureStartedAt', '2026-10-16T12:00:00.000Z']] as const) {
    assert.throws(() => parseMrDistributionDataset(dataset(), { ...descriptor(), [key]: value }), /一致しません/)
  }
  assert.throws(() => parseMrDistributionDataset({ ...dataset(), captureStartedAt: generatedAt }), /reversed/)
  assert.throws(() => parseMrDistributionDataset({ ...dataset(), generatedAt: captureStartedAt }), /before capture/)
})

test('manifest load failure is evicted and retry preserves the uncollected state', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1 ? new Response('', { status: 503 }) : Response.json(manifest([])))
  await assert.rejects(loadMrDistributionManifest(), /読み込めません/)
  assert.deepEqual(await loadMrDistributionManifest(), manifest([]))
  assert.equal(requests, 2)
})

test('dataset requests are shared, reject mismatched captures and version corrected publications', async t => {
  const selected = { ...descriptor(), path: 'mr-cache-test.json' }
  const requests: string[] = []
  let published = dataset()
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(String(input))
    return Response.json(requests.length === 1 ? { ...published, entries: [] } : published)
  })
  await assert.rejects(loadMrDistributionDataset(selected, generatedAt), /all 26 bins/)
  const [left, right] = await Promise.all([loadMrDistributionDataset(selected, generatedAt), loadMrDistributionDataset(selected, generatedAt)])
  assert.strictEqual(left, right)
  assert.equal(requests.length, 2)
  await assert.rejects(loadMrDistributionDataset({ ...selected, id: 'mismatch' }, generatedAt), /一致しません/)
  await loadMrDistributionDataset(selected, generatedAt)
  assert.equal(requests.length, 3)
  published = dataset([2, 1, ...Array.from({ length: 24 }, (_, index) => index + 3)])
  const newerPublication = '2026-10-16T13:15:00.000Z'
  const updated = await loadMrDistributionDataset(selected, newerPublication)
  assert.equal(updated.entries[0].count, 2)
  assert.equal(left.entries[0].count, 1)
  assert.equal(requests.length, 4)
  assert.ok(requests[0].includes('/data/mr-distribution/mr-cache-test.json?v='))
  assert.ok(requests[3].includes(`published=${encodeURIComponent(newerPublication)}`))
})
