import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { UsageRateDataset, UsageRateDatasetDescriptor } from '../types/usageRates.ts'
import { createControlTypeRatioRows, estimateControlTypeRatio } from './controlTypeRatio.ts'
import { USAGE_RATE_SOURCE } from './usageRates.ts'

const capturedAt = '2026-10-09T05:00:00Z'
const descriptor: UsageRateDatasetDescriptor = { id: '2026-09-master', month: '2026-09', league: 'MASTER', path: '2026-09-master.json', capturedAt }

function fixture(all: number[], classic: number[], modern: number[]): UsageRateDataset {
  return {
    schemaVersion: 1, id: descriptor.id, month: descriptor.month, league: descriptor.league, capturedAt, generatedAt: capturedAt,
    source: { ...USAGE_RATE_SOURCE, population: 'ランクマッチ', metric: 'キャラクター使用率', unit: '集計単位の詳細は非公表', notes: ['人数・試合数は非公開'] },
    distributions: (['all', 'classic', 'modern'] as const).map((controlType, index) => ({
      controlType, month: descriptor.month, league: descriptor.league,
      entries: [all, classic, modern][index].map((value, character) => ({
        characterId: `character-${character}`, name: `キャラクター${character}`,
        text: `${Math.floor(value / 1000)}.${String(value % 1000).padStart(3, '0')}`, percentThousandths: value,
      })),
    })),
  }
}

test('recovers a known 16% mixture from every character and preserves unrounded calculations', () => {
  const result = estimateControlTypeRatio(fixture([33600, 66400], [40000, 60000], [0, 100000]))
  assert.equal(result.status, 'estimated')
  assert.equal(result.modernRatio, .16)
  assert.equal(result.classicRatio, .84)
  assert.equal(result.characterCount, 2)
  assert.equal(result.maxAbsoluteErrorPoints, 0)
  assert.equal(result.details[0].allPercent, 33.6)
  assert.equal(result.details[0].modernPercent, 0)
  assert.equal(result.details[1].modernPercent, 100)
})

test('0% and 100% mixtures are valid estimates, not missing or unidentifiable', () => {
  for (const [all, expected] of [[ [40000, 60000], 0 ], [ [0, 100000], 1 ]] as const) {
    const result = estimateControlTypeRatio(fixture([...all], [40000, 60000], [0, 100000]))
    assert.equal(result.status, 'estimated')
    assert.equal(result.modernRatio, expected)
    assert.equal(result.classicRatio, 1 - expected)
  }
})

test('missing values, equal distributions and physically out-of-range estimates return explicit reasons', () => {
  const missing = fixture([33600, 66400], [40000, 60000], [0, 100000])
  missing.distributions[2].entries[0] = { ...missing.distributions[2].entries[0], text: '-', percentThousandths: null }
  assert.match(estimateControlTypeRatio(missing).reason!, /欠損/)
  const same = estimateControlTypeRatio(fixture([40000, 60000], [40000, 60000], [40000, 60000]))
  assert.equal(same.modernRatio, null)
  assert.match(same.reason!, /同じ/)
  for (const all of [[10000, 90000], [40000, 60000]]) {
    const outside = estimateControlTypeRatio(fixture(all, [20000, 80000], [30000, 70000]))
    assert.equal(outside.status, 'unavailable')
    assert.equal(outside.modernRatio, null)
    assert.match(outside.reason!, /範囲外/)
  }
})

test('matches characters by ID instead of distribution order and rejects inconsistent conditions', () => {
  const input = fixture([33600, 66400], [40000, 60000], [0, 100000])
  input.distributions[1].entries.reverse()
  assert.equal(estimateControlTypeRatio(input).modernRatio, .16)
  input.distributions[2].month = '2026-08'
  assert.equal(estimateControlTypeRatio(input).status, 'unavailable')
  assert.match(estimateControlTypeRatio(input).reason!, /conditions/)
  input.distributions[2].month = descriptor.month
  input.distributions[2].entries[0].characterId = 'unknown'
  assert.match(estimateControlTypeRatio(input).reason!, /characterIds/)
})

test('uses rounded official percentages directly and reports residuals without renormalizing', () => {
  // Official 2026-09 MASTER, ALL / CLASSIC / MODERN; the rounded distributions can sum off 100%.
  const values = [
    [9566,10565,4403],[7395,8352,2447],[6547,5575,11572],[5437,5439,5425],
    [5357,5518,4524],[5172,5244,4801],[4298,3507,8383],[3964,4134,3090],
    [3520,3682,2683],[3495,3786,1991],[3458,3328,4132],[3388,3212,4295],
    [3356,3485,2688],[3351,3294,3646],[2991,2828,3834],[2848,3124,1422],
    [2823,2309,5483],[2588,2232,4429],[2419,2127,3930],[2343,2556,1243],
    [2237,2351,1645],[1898,2041,1159],[1883,1934,1625],[1641,1608,1815],
    [1488,1616,826],[1304,1333,1157],[1238,1312,855],[1202,1181,1309],
    [1068,895,1961],[926,959,754],[798,473,2474],
  ]
  const input = fixture(values.map((v) => v[0]), values.map((v) => v[1]), values.map((v) => v[2]))
  const result = estimateControlTypeRatio(input)
  const numerator = values.reduce((sum, [a,c,m]) => sum + (m-c) * (a-c), 0)
  const denominator = values.reduce((sum, [,c,m]) => sum + (m-c) ** 2, 0)
  assert.equal(result.modernRatio, numerator / denominator)
  assert.ok(result.modernRatio! > .161 && result.modernRatio! < .163)
  assert.equal(result.characterCount, 31)
  assert.equal(result.details[0].allPercent, 9.566)
  assert.ok(result.maxAbsoluteErrorPoints! > 0 && result.maxAbsoluteErrorPoints! < .001)
  assert.ok(result.rmsErrorPoints! > 0)
  assert.ok(result.details.some((detail) => detail.differencePoints < 0))
  assert.ok(result.details.some((detail) => detail.differencePoints > 0))
})

test('row projection preserves missing, errors and readable but unidentifiable datasets', () => {
  const rows = createControlTypeRatioRows([
    { month: '2026-06', status: 'missing' },
    { month: '2026-07', descriptor: { ...descriptor, month: '2026-07' }, status: 'error' },
    { month: '2026-09', descriptor, status: 'ready', dataset: fixture([40000,60000], [40000,60000], [40000,60000]) },
  ])
  assert.deepEqual(rows.map((row) => row.status), ['missing', 'error', 'unavailable'])
  assert.equal(rows[0].estimate, null)
  assert.match(rows[2].estimate!.reason!, /同じ/)
  const wrong = fixture([33600, 66400], [40000, 60000], [0, 100000])
  assert.equal(createControlTypeRatioRows([{ month: '2026-08', descriptor, status: 'ready', dataset: wrong }])[0].status, 'error')
  assert.equal(createControlTypeRatioRows([{ month: '2026-09', descriptor: { ...descriptor, id: 'other' }, status: 'ready', dataset: wrong }])[0].status, 'error')
})
