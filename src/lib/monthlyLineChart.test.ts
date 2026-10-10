import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasMonthlyChartValue, MONTHLY_LINE_CHART_LAYOUT, monthlyChartCoordinates,
  monthlyChartLabelIndices, monthlyChartMonths, monthlyChartSegments, monthlyPercentAxis,
} from './monthlyLineChart.ts'
import type { MonthlyLineChartPoint, MonthlyLineChartSeries } from '../types/monthlyLineChart.ts'

function series(points: readonly MonthlyLineChartPoint[], id = 'metric'): MonthlyLineChartSeries {
  return { id, label: id, points, style: { color: '#245ea8', marker: 'circle' } }
}

test('複数系列の暦月をそろえ、全系列にない月の位置も残す', () => {
  const input = [
    series([{ month: '2025-12', value: 0 }, { month: '2026-03', value: 1 }]),
    series([{ month: '2026-01', value: null }], 'another'),
  ]
  const before = structuredClone(input)
  assert.deepEqual(monthlyChartMonths(input), ['2025-12', '2026-01', '2026-02', '2026-03'])
  assert.deepEqual(input, before)
  assert.deepEqual(monthlyChartMonths([]), [])
  assert.throws(() => monthlyChartMonths([series([{ month: '2026-13', value: 1 }])]))
})

test('勝率の軸は50%を含め、0%と100%も描画範囲に収める', () => {
  assert.deepEqual(monthlyPercentAxis([0, 100]), { start: 0, end: 100, step: 20, ticks: [0, 20, 40, 60, 80, 100] })
  assert.deepEqual(monthlyPercentAxis([50]), {
    start: 48.5, end: 51.5, step: 0.5, ticks: [48.5, 49, 49.5, 50, 50.5, 51, 51.5],
  })
  assert.deepEqual(monthlyPercentAxis([]), monthlyPercentAxis([null as unknown as number, Number.NaN, Infinity, -1, 101]))
  for (const values of [[0], [100], [49.31, 51.62], [20, 80]]) {
    const axis = monthlyPercentAxis(values)
    assert.ok(axis.start <= Math.min(50, ...values))
    assert.ok(axis.end >= Math.max(50, ...values))
    assert.ok(axis.end > axis.start)
  }
})

test('0は点にし、欠損・非有限値・飛び月で線を切り、年をまたぐ連続月はつなぐ', () => {
  const points = [
    { month: '2025-12', value: 0 }, { month: '2026-01', value: 1 },
    { month: '2026-02', value: null }, { month: '2026-03', value: 2 },
    { month: '2026-04', value: Number.NaN }, { month: '2026-05', value: Infinity },
    { month: '2026-06', value: 3 }, { month: '2026-08', value: 4 },
  ]
  const before = structuredClone(points)
  const x = (month: string) => month === '2025-12' ? 0 : Number(month.slice(-2))
  const y = (value: number) => value
  assert.deepEqual(monthlyChartSegments(points, x, y), ['M 0 0 L 1 1', 'M 3 2', 'M 6 3', 'M 8 4'])
  assert.equal(points.filter(hasMonthlyChartValue).length, 5)
  assert.deepEqual(points, before)
  assert.deepEqual(monthlyChartSegments([...points].reverse(), x, y), monthlyChartSegments(points, x, y))
})

test('統計の小数値を座標計算前に百分率の整数へ再丸めしない', () => {
  const months = ['2026-01', '2026-02']
  const { x, y } = monthlyChartCoordinates(months, 500, { start: 0, end: 1, ticks: [0, 1] })
  const value = Math.sqrt(2) / 3
  const paths = monthlyChartSegments([{ month: '2026-01', value }], x, y)
  assert.deepEqual(paths, [`M 48 ${274 - value * 240}`])
  assert.notEqual(y(value), y(Math.round(value * 100) / 100))
  assert.equal(y(0), MONTHLY_LINE_CHART_LAYOUT.bottom)
  assert.equal(y(1), MONTHLY_LINE_CHART_LAYOUT.top)
})

test('単月は中央、暦月は等間隔、幅が変わっても月末ラベルを残して間引く', () => {
  const months = Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`)
  const axis = monthlyPercentAxis([50])
  const { x, right } = monthlyChartCoordinates(months, 240, axis)
  assert.equal(x(months[0]), 48)
  assert.equal(x(months[11]), right)
  assert.ok(Math.abs((x(months[2]) - x(months[1])) - (x(months[1]) - x(months[0]))) < 1e-12)
  assert.deepEqual(monthlyChartLabelIndices(months, x), [0, 11])
  const wide = monthlyChartCoordinates(months, 1200, axis)
  assert.deepEqual(monthlyChartLabelIndices(months, wide.x), months.map((_, index) => index))
  const single = monthlyChartCoordinates(['2026-03'], 500, axis)
  assert.equal(single.x('2026-03'), (48 + 482) / 2)
  assert.deepEqual(monthlyChartLabelIndices(['2026-03'], single.x), [0])
  assert.deepEqual(monthlyChartLabelIndices([], x), [])
})
