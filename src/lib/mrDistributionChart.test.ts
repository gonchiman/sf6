import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { MrDistributionDataset } from '../types/mrDistribution.ts'
import {
  createMrDistributionRows, MR_DISTRIBUTION_CHECKS, MR_DISTRIBUTION_CONDITIONS,
  MR_DISTRIBUTION_SOURCE, MR_DISTRIBUTION_THRESHOLDS, parseMrDistributionDataset,
} from './mrDistribution.ts'
import { createMrDistributionChartView, mrDistributionChartLabelLines, mrDistributionChartPercentLabel } from './mrDistributionChart.ts'

function dataset(counts: number[]): MrDistributionDataset {
  const entries = counts.map((count, index) => ({ minimum: index * 100,
    maximum: index === 25 ? null : (index + 1) * 100, count }))
  const totalCount = counts.reduce((sum, count) => sum + count, 0)
  return {
    schemaVersion: 1, id: 'max-mr-estimate-chart-test', captureStartedAt: '2026-10-16T13:00:00.000Z',
    captureEndedAt: '2026-10-16T13:10:00.000Z', generatedAt: '2026-10-16T13:11:00.000Z',
    source: { ...MR_DISTRIBUTION_SOURCE, population: 'Synthetic MR listing', metric: 'Synthetic 100-MR bins',
      unit: 'fighter-account', notes: ['Synthetic chart test only.'] },
    conditions: { ...MR_DISTRIBUTION_CONDITIONS }, method: 'boundary-search-estimate', binWidth: 100,
    totalCount, entries,
    observation: { totalAtStart: totalCount, totalAtEnd: totalCount, minTotal: totalCount, maxTotal: totalCount,
      boundaries: MR_DISTRIBUTION_THRESHOLDS.map(minimumMr => ({ minimumMr,
        countAtOrAbove: entries.filter(bin => bin.minimum >= minimumMr).reduce((sum, bin) => sum + bin.count, 0),
        totalCount, observedAt: '2026-10-16T13:05:00.000Z' })) },
    validation: { status: 'estimated', coverage: 'all-mr-boundaries', checks: [...MR_DISTRIBUTION_CHECKS],
      notes: ['Synthetic complete boundaries.'] },
  }
}

test('focus keeps all-listing denominators and reports the real capture\'s 689 omitted accounts', () => {
  const value = parseMrDistributionDataset(JSON.parse(readFileSync(new URL(
    '../../public/data/mr-distribution/max-mr-estimate-2026-10-16T14-06-58-255Z.json', import.meta.url), 'utf8')))
  const view = createMrDistributionChartView(value, 'focus')
  const completeRows = createMrDistributionRows(value)
  assert.equal(view.rows.length, 12)
  assert.deepEqual(view.rows, completeRows.slice(10, 22))
  assert.deepEqual(view.intervals[0], { minimum: 1000, maximum: 1100 })
  assert.deepEqual(view.intervals.at(-1), { minimum: 2100, maximum: 2200 })
  assert.equal(view.visibleCount, 313715)
  assert.equal(view.excludedCount, 689)
  assert.equal(view.excludedPercent, 689 / 314404 * 100)
  assert.equal(view.rows.find(row => row.id === 'mr-1500')!.percent, 99170 / 314404 * 100)
  assert.notEqual(view.rows.find(row => row.id === 'mr-1500')!.percent, 99170 / view.visibleCount * 100)
})

test('all-range keeps all 26 bins and matches intervals by MR ID even when entries are shuffled', () => {
  const value = dataset(Array.from({ length: 26 }, (_, index) => index + 1))
  value.entries.reverse()
  const view = createMrDistributionChartView(value, 'all')
  assert.equal(view.rows.length, 26)
  assert.equal(view.visibleCount, value.totalCount)
  assert.equal(view.excludedCount, 0)
  assert.equal(view.excludedPercent, 0)
  assert.deepEqual(view.rows, createMrDistributionRows(value))
  assert.deepEqual(view.intervals, [...value.entries].reverse().map(({ minimum, maximum }) => ({ minimum, maximum })))
  assert.deepEqual(view.intervals.at(-1), { minimum: 2500, maximum: null })
})

test('focus includes 1000, excludes 2200, and does not hide omitted counts when focused bins have zero accounts', () => {
  const counts = Array<number>(26).fill(0)
  counts[9] = 7; counts[22] = 11; counts[25] = 13
  const value = dataset(counts)
  const view = createMrDistributionChartView(value, 'focus')
  assert.equal(view.visibleCount, 0)
  assert.equal(view.excludedCount, 31)
  assert.equal(view.excludedPercent, 100)
  assert.equal(view.rows.length, 12)
  assert.ok(view.rows.every(row => row.count === 0 && row.percent === 0))
  counts[10] = 17
  const withLowerBoundary = createMrDistributionChartView(dataset(counts), 'focus')
  assert.equal(withLowerBoundary.visibleCount, 17)
  assert.equal(withLowerBoundary.excludedCount, 31)
  assert.equal(withLowerBoundary.rows[0].percent, 17 / 48 * 100)
})

test('zero total retains confirmed zero counts and unavailable percentages in both ranges', () => {
  const value = dataset(Array<number>(26).fill(0))
  for (const range of ['focus', 'all'] as const) {
    const view = createMrDistributionChartView(value, range)
    assert.equal(view.visibleCount, 0)
    assert.equal(view.excludedCount, 0)
    assert.equal(view.excludedPercent, null)
    assert.ok(view.rows.every(row => row.count === 0 && row.percent === null && row.cumulativePercent === null))
  }
})

test('range labels show the complete inclusive integer class and keep each split under its own bar', () => {
  const interval = { minimum: 1500, maximum: 1600 }
  assert.deepEqual(mrDistributionChartLabelLines(interval, 'axis'), [])
  assert.deepEqual(mrDistributionChartLabelLines(interval, 'range'), ['1500〜1599'])
  assert.deepEqual(mrDistributionChartLabelLines(interval, 'range-two-line'), ['1500', '〜1599'])
  assert.deepEqual(mrDistributionChartLabelLines(interval, 'lower'), ['1500'])
  assert.deepEqual(mrDistributionChartLabelLines({ minimum: 0, maximum: 100 }, 'range'), ['0〜99'])
  assert.deepEqual(mrDistributionChartLabelLines({ minimum: 0, maximum: 100 }, 'range-two-line'), ['0', '〜99'])
})

test('open-ended final labels never imply an invented 2599 upper limit', () => {
  const interval = { minimum: 2500, maximum: null }
  assert.deepEqual(mrDistributionChartLabelLines(interval, 'range'), ['2500以上'])
  assert.deepEqual(mrDistributionChartLabelLines(interval, 'range-two-line'), ['2500', '以上'])
  assert.deepEqual(mrDistributionChartLabelLines(interval, 'lower'), ['2500以上'])
  for (const style of ['axis', 'range', 'range-two-line', 'lower'] as const) {
    assert.throws(() => mrDistributionChartLabelLines({ minimum: 2500, maximum: 2600 }, style), /maximum/)
  }
})

test('missing focus bins are rejected rather than converted into an apparently complete zero distribution', () => {
  const value = dataset(Array<number>(26).fill(1))
  value.entries.splice(15, 1)
  assert.throws(() => createMrDistributionChartView(value, 'focus'), /entries/)
})

test('a positive tail below display precision is distinct from a confirmed zero or unavailable percentage', () => {
  assert.equal(mrDistributionChartPercentLabel(1 / 314404 * 100), '0.01%未満')
  assert.equal(mrDistributionChartPercentLabel(.009999), '0.01%未満')
  assert.equal(mrDistributionChartPercentLabel(.01), '0.01%')
  assert.equal(mrDistributionChartPercentLabel(0), '0.00%')
  assert.equal(mrDistributionChartPercentLabel(null), '—')
})
