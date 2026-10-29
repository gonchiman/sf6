import assert from 'node:assert/strict'
import test from 'node:test'
import { createRankDistributionRows, RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_SOURCE, RANK_DISTRIBUTION_VALIDATION_CHECKS } from './rankDistribution.ts'
import type { RankDistributionDataset, RankDistributionRow } from '../types/rankDistribution.ts'
import { rankDistributionChartAxis, rankDistributionChartValue, rankDistributionChartValueLabel } from './rankDistributionChart.ts'
import type { RankDistributionChartMetric } from './rankDistributionChart.ts'

function row(count: number, percent: number | null): RankDistributionRow {
  return { id: 'synthetic', label: 'Synthetic rank', group: 'DIAMOND', rankId: 31, count, percent,
    cumulativeCount: count, cumulativePercent: percent }
}
function dataset(): RankDistributionDataset {
  return { schemaVersion: 1, id: 'synthetic-rank-chart', captureStartedAt: '2026-10-15T12:00:00.000Z',
    captureEndedAt: '2026-10-15T12:01:00.000Z', generatedAt: '2026-10-15T12:02:00.000Z',
    source: { ...RANK_DISTRIBUTION_SOURCE, population: 'synthetic accounts', metric: 'synthetic maximum LP', unit: 'fighter-account', notes: ['synthetic test only'] },
    conditions: { ...RANK_DISTRIBUTION_CONDITIONS }, method: 'boundary-search', totalCount: 1000,
    entries: Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, count: index === 35 ? 950 : index >= 30 ? 10 : 0 })),
    validation: { status: 'verified', coverage: 'all-listed-accounts', checks: [...RANK_DISTRIBUTION_VALIDATION_CHECKS], notes: ['synthetic complete fixture'] } }
}
function assertAxis(rows: RankDistributionRow[], metric: RankDistributionChartMetric): void {
  const axis = rankDistributionChartAxis(rows, metric)
  assert.equal(axis.ticks[0], 0)
  assert.equal(axis.ticks[axis.ticks.length - 1], axis.maximum)
  assert.ok(Number.isFinite(axis.maximum) && axis.maximum > 0)
  assert.ok(axis.ticks.length <= 8)
  assert.ok(axis.ticks.every((value, index) => Number.isFinite(value) && value >= 0 && (index === 0 || value > axis.ticks[index - 1])))
  if (metric === 'count') assert.ok(axis.ticks.every(Number.isSafeInteger))
  else assert.ok(axis.maximum <= 100)
  for (const item of rows) {
    const value = rankDistributionChartValue(item, metric)
    if (value !== null) assert.ok(value <= axis.maximum)
  }
}

test('chart values retain unrounded percentages and preserve count/percentage mode semantics', () => {
  const item = row(12345, 0.123456789)
  assert.equal(rankDistributionChartValue(item, 'percent'), 0.123456789)
  assert.equal(rankDistributionChartValue(item, 'count'), 12345)
  assert.equal(rankDistributionChartValueLabel(item.percent, 'percent'), '0.12%')
  assert.equal(rankDistributionChartValueLabel(item.count, 'count'), '12,345 件')
  assert.equal(rankDistributionChartValue(row(-0, -0), 'percent'), 0)
  assert.equal(rankDistributionChartValueLabel(-0, 'count'), '0 件')
})

test('a percentage axis includes observations above 20 percent and reaches 100 without clipping', () => {
  assert.deepEqual(rankDistributionChartAxis([row(377, 37.7)], 'percent'), { maximum: 40, ticks: [0, 10, 20, 30, 40] })
  assert.deepEqual(rankDistributionChartAxis([row(1000, 100)], 'percent'), { maximum: 100, ticks: [0, 20, 40, 60, 80, 100] })
  for (const value of [20.0001, 55.3, 79.99, 99.999, 100]) assertAxis([row(1, value)], 'percent')
})

test('five star rows retain their global denominator and keep cumulative quantities out of bar values', () => {
  const rows = createRankDistributionRows(dataset(), 'DIAMOND')
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map(item => rankDistributionChartValue(item, 'percent')), [1, 1, 1, 1, 1])
  assert.equal(rows.reduce((sum, item) => sum + rankDistributionChartValue(item, 'percent')!, 0), 5)
  assert.equal(rows[0].cumulativePercent, 100)
  assert.equal(rows[4].cumulativePercent, 96)
  assert.deepEqual(rankDistributionChartAxis(rows, 'percent'), { maximum: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] })
  assert.deepEqual(rows.map(item => rankDistributionChartValue(item, 'count')), [10, 10, 10, 10, 10])
})

test('null percentage is unavailable while a confirmed zero remains numeric', () => {
  assert.equal(rankDistributionChartValue(row(0, null), 'percent'), null)
  assert.equal(rankDistributionChartValue(row(0, 0), 'percent'), 0)
  assert.equal(rankDistributionChartValue(row(0, null), 'count'), 0)
  assert.equal(rankDistributionChartValueLabel(null, 'percent'), '—')
  assert.equal(rankDistributionChartValueLabel(0, 'percent'), '0.00%')
  for (const rows of [[], [row(0, null)], [row(0, 0)]]) {
    assert.deepEqual(rankDistributionChartAxis(rows, 'percent'), { maximum: 1, ticks: [0, 1] })
    assert.deepEqual(rankDistributionChartAxis(rows, 'count'), { maximum: 1, ticks: [0, 1] })
  }
})

test('invalid and out-of-range values do not enlarge axes or become numeric labels', () => {
  for (const value of [-1, NaN, Infinity, -Infinity, 100.001]) {
    assert.equal(rankDistributionChartValue(row(1, value), 'percent'), null)
    assert.equal(rankDistributionChartValueLabel(value, 'percent'), '—')
  }
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(rankDistributionChartValue(row(value, 1), 'count'), null)
    assert.equal(rankDistributionChartValueLabel(value, 'count'), '—')
  }
  assert.deepEqual(rankDistributionChartAxis([row(1, Infinity), row(1, 101)], 'percent'), { maximum: 1, ticks: [0, 1] })
  assert.deepEqual(rankDistributionChartAxis([row(Infinity, 1), row(-1, 1), row(7, 1)], 'count'), { maximum: 8, ticks: [0, 2, 4, 6, 8] })
})

test('fractional percentage ticks preserve small values instead of rounding their coordinates to zero', () => {
  const values = [0.04, 0.15, 0.001, Number.MIN_VALUE]
  for (const value of values) {
    assert.equal(rankDistributionChartValue(row(1, value), 'percent'), value)
    assertAxis([row(1, value)], 'percent')
  }
  assert.deepEqual(rankDistributionChartAxis([row(1, 0.04)], 'percent'), { maximum: 0.04, ticks: [0, 0.01, 0.02, 0.03, 0.04] })
  assert.deepEqual(rankDistributionChartAxis([row(1, 0.15)], 'percent'), { maximum: 0.15, ticks: [0, 0.05, 0.1, 0.15] })
})

test('count ticks stay integral and finite for one account and the largest supported count', () => {
  assert.deepEqual(rankDistributionChartAxis([row(1, 1)], 'count'), { maximum: 1, ticks: [0, 1] })
  for (const count of [2, 7, 547950, 3061539, Number.MAX_SAFE_INTEGER]) assertAxis([row(count, 1)], 'count')
})
