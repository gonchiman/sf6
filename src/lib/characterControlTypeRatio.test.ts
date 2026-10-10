import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { UsageRateDataset } from '../types/usageRates.ts'
import { createCharacterControlTypeRatioRows, sortCharacterControlTypeRatioRows } from './characterControlTypeRatio.ts'
import { estimateControlTypeRatio } from './controlTypeRatio.ts'
import { parseUsageRateDataset, USAGE_RATE_SOURCE } from './usageRates.ts'

function fixture(all: number[], classic: number[], modern: number[]): UsageRateDataset {
  return {
    schemaVersion: 1, id: '2026-09-master', month: '2026-09', league: 'MASTER',
    capturedAt: '2026-10-09T05:00:00Z', generatedAt: '2026-10-09T06:00:00Z',
    source: { ...USAGE_RATE_SOURCE, population: 'ランクマッチ', metric: 'キャラクター使用率', unit: '%（集計単位未公表）', notes: [] },
    distributions: (['all', 'classic', 'modern'] as const).map((controlType, index) => ({
      controlType, month: '2026-09', league: 'MASTER',
      entries: [all, classic, modern][index].map((value, character) => ({
        characterId: `character-${character}`, name: `キャラクター${character}`,
        text: `${Math.floor(value / 1000)}.${String(value % 1000).padStart(3, '0')}`, percentThousandths: value,
      })),
    })),
  }
}

function near(actual: number | null, expected: number, tolerance = 1e-14): void {
  assert.notEqual(actual, null)
  assert.ok(Math.abs(actual! - expected) < tolerance, `${actual} should be near ${expected}`)
}

test('derives conditional character ratios from the global mixture, not each character inverse estimate', () => {
  const data = fixture([34000, 66000], [40000, 60000], [10000, 90000])
  const overall = estimateControlTypeRatio(data)
  const rows = createCharacterControlTypeRatioRows(data, overall)
  near(overall.modernRatio, .2)
  near(rows[0].modernWithinCharacterRatio, 2 / 34)
  near(rows[1].modernWithinCharacterRatio, 18 / 66)
  assert.notEqual(rows[0].modernWithinCharacterRatio, overall.modernRatio)
  for (const row of rows) near(row.modernWithinCharacterRatio! + row.classicWithinCharacterRatio!, 1)
  near(rows.reduce((sum, row) => sum + row.allPercent! / 100 * row.modernWithinCharacterRatio!, 0), .2)
  assert.equal(rows[0].allText, '34.000')
  assert.equal(rows[0].classicText, '40.000')
  assert.equal(rows[0].modernText, '10.000')
})

test('preserves official ALL order and stable IDs when other distributions are ordered differently', () => {
  const data = fixture([34000, 66000], [40000, 60000], [10000, 90000])
  data.distributions[1].entries.reverse()
  data.distributions[2].entries.reverse()
  const rows = createCharacterControlTypeRatioRows(data)
  assert.deepEqual(rows.map((row) => [row.characterId, row.officialOrder]), [['character-0', 0], ['character-1', 1]])
  near(rows[0].modernWithinCharacterRatio, 2 / 34)
})

test('global missing, indistinguishable distributions and invalid mixtures retain rows with unavailable reasons', () => {
  const missing = fixture([34000, 66000], [40000, 60000], [10000, 90000])
  missing.distributions[0].entries[0] = { ...missing.distributions[0].entries[0], text: '-', percentThousandths: null }
  const cases: [UsageRateDataset, RegExp][] = [
    [missing, /欠損/],
    [fixture([40000, 60000], [40000, 60000], [40000, 60000]), /同じ/],
    [fixture([10000, 90000], [20000, 80000], [30000, 70000]), /範囲外/],
  ]
  for (const [data, reason] of cases) {
    const rows = createCharacterControlTypeRatioRows(data)
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.status, 'unavailable')
      assert.equal(row.modernWithinCharacterRatio, null)
      assert.equal(row.classicWithinCharacterRatio, null)
      assert.match(row.reason!, reason)
    }
  }
  assert.equal(createCharacterControlTypeRatioRows(missing)[0].allText, '-')
  assert.equal(createCharacterControlTypeRatioRows(missing)[0].allPercent, null)
})

test('zero contributions produce valid 0% and 100%, while zero reconstructed ALL remains unavailable', () => {
  const rows = createCharacterControlTypeRatioRows(fixture([75000, 25000, 0], [100000, 0, 0], [0, 100000, 0]))
  assert.equal(rows[0].status, 'estimated')
  assert.equal(rows[0].modernWithinCharacterRatio, 0)
  assert.equal(rows[0].classicWithinCharacterRatio, 1)
  assert.equal(rows[1].status, 'estimated')
  assert.equal(rows[1].modernWithinCharacterRatio, 1)
  assert.equal(rows[1].classicWithinCharacterRatio, 0)
  assert.equal(rows[2].allPercent, 0)
  assert.equal(rows[2].reconstructedAllPercent, 0)
  assert.equal(rows[2].modernWithinCharacterRatio, null)
  assert.equal(rows[2].classicWithinCharacterRatio, null)
  assert.match(rows[2].reason!, /再現ALLが0%/)
})

test('global 0% and 100% are valid and do not invent a ratio for unused modeled characters', () => {
  const zero = createCharacterControlTypeRatioRows(fixture([100000, 0], [100000, 0], [0, 100000]))
  assert.equal(zero[0].modernWithinCharacterRatio, 0)
  assert.equal(zero[0].classicWithinCharacterRatio, 1)
  assert.equal(zero[1].status, 'unavailable')
  const one = createCharacterControlTypeRatioRows(fixture([0, 100000], [100000, 0], [0, 100000]))
  assert.equal(one[0].status, 'unavailable')
  assert.equal(one[1].modernWithinCharacterRatio, 1)
  assert.equal(one[1].classicWithinCharacterRatio, 0)
})

test('one equal CLASSIC/MODERN character uses the identifiable global ratio', () => {
  const rows = createCharacterControlTypeRatioRows(fixture([20000, 50000, 30000], [20000, 60000, 20000], [20000, 20000, 60000]))
  assert.equal(rows[0].status, 'estimated')
  near(rows[0].modernWithinCharacterRatio, .25)
  near(rows[0].classicWithinCharacterRatio, .75)
})

test('a rounded published ALL of zero is not used as the conditional denominator', () => {
  const rows = createCharacterControlTypeRatioRows(fixture([0, 34000, 66000], [0, 40000, 60000], [1, 10000, 89999]))
  assert.equal(rows[0].allPercent, 0)
  assert.ok(rows[0].reconstructedAllPercent! > 0 && rows[0].reconstructedAllPercent! < .0005)
  assert.equal(rows[0].status, 'estimated')
  assert.equal(rows[0].modernWithinCharacterRatio, 1)
  assert.equal(rows[0].classicWithinCharacterRatio, 0)
})

test('sorts raw ratios in either direction with missing last, official ties and no mutation', () => {
  const original = createCharacterControlTypeRatioRows(fixture([12000, 12000, 76000, 0], [10000, 10000, 80000, 0], [20000, 20000, 60000, 0]))
  const rows = Object.freeze([original[3], original[1], original[2], original[0]])
  const ids = (values: typeof original) => values.map((row) => row.characterId)
  assert.deepEqual(ids(sortCharacterControlTypeRatioRows(rows, { key: 'modern', direction: 'descending' })), ['character-0', 'character-1', 'character-2', 'character-3'])
  assert.deepEqual(ids(sortCharacterControlTypeRatioRows(rows, { key: 'modern', direction: 'ascending' })), ['character-2', 'character-0', 'character-1', 'character-3'])
  assert.deepEqual(ids(sortCharacterControlTypeRatioRows(rows, { key: 'classic', direction: 'descending' })), ['character-2', 'character-0', 'character-1', 'character-3'])
  assert.deepEqual(ids(sortCharacterControlTypeRatioRows(rows, { key: 'classic', direction: 'ascending' })), ['character-0', 'character-1', 'character-2', 'character-3'])
  assert.deepEqual(ids(sortCharacterControlTypeRatioRows(rows, { key: 'official', direction: 'descending' })), ['character-0', 'character-1', 'character-2', 'character-3'])
  assert.deepEqual(rows.map((row) => row.characterId), ['character-3', 'character-1', 'character-2', 'character-0'])
})

test('rounded official September MASTER values give RYU 7.46% using reconstructed ALL', async () => {
  const dataset = parseUsageRateDataset(JSON.parse(await readFile(new URL('../../public/data/usage-rates/2026-09-master.json', import.meta.url), 'utf8')))
  const rows = createCharacterControlTypeRatioRows(dataset)
  assert.equal(rows.length, 31)
  const ryu = rows.find((row) => row.characterId === 'ryu')!
  assert.equal(ryu.name, 'リュウ')
  assert.equal(ryu.allText, '9.566')
  assert.equal((ryu.modernWithinCharacterRatio! * 100).toFixed(2), '7.46')
  assert.equal((ryu.classicWithinCharacterRatio! * 100).toFixed(2), '92.54')
  assert.notEqual(ryu.reconstructedAllPercent, ryu.allPercent)
  const p = estimateControlTypeRatio(dataset).modernRatio!
  assert.equal(ryu.modernWithinCharacterRatio, p * ryu.modernPercent! / ryu.reconstructedAllPercent!)
  assert.notEqual(ryu.modernWithinCharacterRatio, p * ryu.modernPercent! / ryu.allPercent!)
})
