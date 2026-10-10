import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatMonthlyStatisticTick, MONTHLY_STATISTIC_METRICS, monthlyLeagueStatisticAxis, monthlyLeagueStatisticSeries, monthlyStatisticAxis,
  monthlyStatisticDefinition, monthlyStatisticPoints, monthlyStatisticReference, monthlyStatisticValue, monthlyStatisticValueLabel,
} from './monthlyWinRateStatisticsChart.ts'
import type { MonthlyWinRateStatisticMetric, MonthlyWinRateStatisticsRow } from '../types/monthlyWinRateStatistics.ts'
import type { LeagueStatisticsSeries } from '../types/monthlyWinRateStatisticsComparison.ts'
import { monthlyChartSegments } from './monthlyLineChart.ts'
import { leagueSeriesStyle } from './leagueSeriesColors.ts'

function row(overrides: Partial<MonthlyWinRateStatisticsRow> = {}): MonthlyWinRateStatisticsRow {
  return {
    month: '2026-01', status: 'ready', listedCount: 3, validCount: 3,
    excludedMissingCount: 0, excludedLowSampleCount: 0, excludedNonCommonCount: 0,
    characterIds: ['ryu', 'ken', 'cammy'], capturedAt: null, source: null,
    statistics: {
      meanPercent: 50.305, medianPercent: 50.315, standardDeviationPoints: 0.005,
      minimumPercent: 40, maximumPercent: 60,
    },
    ...overrides,
  }
}

test('5統計量の名称と単位を区別し、存在しない指標を拒否する', () => {
  assert.deepEqual(MONTHLY_STATISTIC_METRICS.map(({ key, label, unit }) => [key, label, unit]), [
    ['meanPercent', '平均', '%'], ['medianPercent', '中央値', '%'],
    ['standardDeviationPoints', '標準偏差', 'ポイント'], ['minimumPercent', '最小', '%'], ['maximumPercent', '最大', '%'],
  ])
  assert.equal(monthlyStatisticDefinition('standardDeviationPoints').unit, 'ポイント')
  assert.throws(() => monthlyStatisticDefinition('invalid' as MonthlyWinRateStatisticMetric), /統計量/)
})

test('50%比較線は百分率の4指標だけに付け、標準偏差に付けない', () => {
  assert.equal(monthlyStatisticReference('standardDeviationPoints'), undefined)
  for (const { key } of MONTHLY_STATISTIC_METRICS.filter(item => item.unit === '%')) {
    assert.deepEqual(monthlyStatisticReference(key), { value: 50, label: '50% 基準' })
  }
})

test('集計済み5指標を実数のまま投影し、表示だけ丸めて単位を付ける', () => {
  const input = row()
  const before = structuredClone(input)
  for (const { key } of MONTHLY_STATISTIC_METRICS) {
    assert.deepEqual(monthlyStatisticPoints([input], key), [{ month: input.month, value: input.statistics![key] }])
  }
  assert.equal(monthlyStatisticValue(input, 'meanPercent'), 50.305)
  assert.equal(monthlyStatisticValue(input, 'standardDeviationPoints'), 0.005)
  assert.equal(monthlyStatisticValueLabel(input, 'meanPercent'), '50.31%')
  assert.equal(monthlyStatisticValueLabel(input, 'standardDeviationPoints'), '0.01 ポイント')
  assert.deepEqual(input, before)
})

test('実際の0と項目ごとのnullを区別し、1キャラ時の標準偏差だけを算出不可にする', () => {
  const zero = row({ statistics: { meanPercent: 0, medianPercent: 0, standardDeviationPoints: 0, minimumPercent: 0, maximumPercent: 0 } })
  for (const { key } of MONTHLY_STATISTIC_METRICS) assert.equal(monthlyStatisticValue(zero, key), 0)
  assert.equal(monthlyStatisticValueLabel(zero, 'standardDeviationPoints'), '0.00 ポイント')
  const single = row({ validCount: 1, statistics: { ...zero.statistics!, standardDeviationPoints: null } })
  assert.equal(monthlyStatisticValue(single, 'meanPercent'), 0)
  assert.equal(monthlyStatisticValue(single, 'standardDeviationPoints'), null)
  assert.equal(monthlyStatisticValueLabel(single, 'standardDeviationPoints'), '算出できません（対象が1キャラ）')
  const none = row({ validCount: 0, statistics: { meanPercent: null, medianPercent: null, standardDeviationPoints: null, minimumPercent: null, maximumPercent: null } })
  assert.equal(monthlyStatisticValueLabel(none, 'meanPercent'), '有効データなし')
  const noStatistics = row({ statistics: null })
  assert.equal(monthlyStatisticValue(noStatistics, 'meanPercent'), null)
  assert.equal(monthlyStatisticValueLabel(noStatistics, 'meanPercent'), '算出できません')
})

test('未登録・読込失敗・共通集計不能の月を暦月に残し、古い数値があっても投影しない', () => {
  const rows = [
    row(), row({ month: '2026-02', status: 'unavailable' }),
    row({ month: '2026-03', status: 'error' }), row({ month: '2026-04', status: 'incomplete' }),
  ]
  assert.deepEqual(monthlyStatisticPoints(rows, 'meanPercent'), [
    { month: '2026-01', value: 50.305 }, { month: '2026-02', value: null },
    { month: '2026-03', value: null }, { month: '2026-04', value: null },
  ])
  assert.deepEqual(rows.slice(1).map(item => monthlyStatisticValueLabel(item, 'meanPercent')), [
    '未登録', '読込失敗', '共通キャラを確認できません',
  ])
})

test('非有限値・負値・百分率範囲外を数値として描画しない', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 101]) {
    const input = row()
    input.statistics!.meanPercent = value
    assert.equal(monthlyStatisticValue(input, 'meanPercent'), null)
    assert.equal(monthlyStatisticValueLabel(input, 'meanPercent'), '算出できません')
  }
})

test('標準偏差軸は下限0で、全0・欠損・空データは0〜1を使う', () => {
  for (const rows of [[], [row({ status: 'error' })], [row({ statistics: null })],
    [row({ statistics: { ...row().statistics!, standardDeviationPoints: 0 } })]]) {
    const axis = monthlyStatisticAxis(rows, 'standardDeviationPoints')
    assert.deepEqual(axis, { start: 0, end: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] })
  }
})

test('小さい同値・大きい標準偏差でも上余白と単調なnice目盛りを持つ', () => {
  for (const maximum of [0.005, 0.69, 1, 50]) {
    const rows = [row(), row({ month: '2026-02' })].map(item => ({
      ...item, statistics: { ...item.statistics!, standardDeviationPoints: maximum },
    }))
    const axis = monthlyStatisticAxis(rows, 'standardDeviationPoints')
    assert.equal(axis.start, 0)
    assert.ok(axis.end >= maximum * 1.12)
    assert.ok(axis.step > 0)
    assert.equal(axis.ticks[0], 0)
    assert.equal(axis.ticks.at(-1), axis.end)
    assert.ok(axis.ticks.every((tick, index) => index === 0 || tick > axis.ticks[index - 1]))
    assert.ok(new Set(axis.ticks.map(tick => formatMonthlyStatisticTick(tick, axis.step))).size === axis.ticks.length)
  }
  const tiny = monthlyStatisticAxis([row()], 'standardDeviationPoints')
  assert.deepEqual(tiny.ticks, [0, 0.002, 0.004, 0.006])
  assert.deepEqual(tiny.ticks.map(tick => formatMonthlyStatisticTick(tick, tiny.step)), ['0.000', '0.002', '0.004', '0.006'])
})

test('百分率軸は同値・欠損・0%・100%でも50%を含み、既存の基準軸を保つ', () => {
  for (const maximum of [null, 0, 50, 100]) {
    const input = row({ statistics: { ...row().statistics!, maximumPercent: maximum } })
    const axis = monthlyStatisticAxis([input], 'maximumPercent')
    assert.ok(axis.start >= 0 && axis.start <= 50)
    assert.ok(axis.end <= 100 && axis.end >= 50)
    assert.ok(axis.end > axis.start)
    if (maximum !== null) assert.ok(axis.start <= maximum && maximum <= axis.end)
  }
  assert.deepEqual(monthlyStatisticAxis([], 'meanPercent'), {
    start: 48.5, end: 51.5, step: 0.5, ticks: [48.5, 49, 49.5, 50, 50.5, 51, 51.5],
  })
})

function league(league: string, rows: MonthlyWinRateStatisticsRow[]): LeagueStatisticsSeries {
  return { league, statistics: { mode: 'monthly', commonCharacterCount: 3, commonUnavailable: false, rows } }
}

test('同じ月の複数リーグを独立系列にし、固定styleと丸め前の値を維持する', () => {
  const input = [
    league('MASTER', [row()]),
    league('HIGH_MASTER', [row({ statistics: { ...row().statistics!, meanPercent: 60.005 } })]),
  ]
  const before = structuredClone(input)
  const output = monthlyLeagueStatisticSeries(input, 'meanPercent')
  assert.deepEqual(output.map(item => [item.id, item.label, item.points]), [
    ['MASTER', 'MASTER', [{ month: '2026-01', value: 50.305 }]],
    ['HIGH_MASTER', 'HIGH MASTER', [{ month: '2026-01', value: 60.005 }]],
  ])
  assert.equal(output[0].style, leagueSeriesStyle('MASTER'))
  assert.equal(output[1].style, leagueSeriesStyle('HIGH_MASTER'))
  assert.deepEqual(monthlyLeagueStatisticSeries([...input].reverse(), 'meanPercent').map(item => item.style), output.map(item => item.style).reverse())
  assert.deepEqual(input, before)
})

test('全リーグの値を共通縦軸に収め、リーグごとの統計を平均しない', () => {
  const input = [
    league('GOLD', [row({ statistics: { ...row().statistics!, meanPercent: 40, standardDeviationPoints: 0.1 } })]),
    league('MASTER', [row({ statistics: { ...row().statistics!, meanPercent: 60, standardDeviationPoints: 10 } })]),
  ]
  const rateAxis = monthlyLeagueStatisticAxis(input, 'meanPercent')
  assert.equal(rateAxis.start, 35)
  assert.equal(rateAxis.end, 65)
  const deviationAxis = monthlyLeagueStatisticAxis(input, 'standardDeviationPoints')
  assert.equal(deviationAxis.start, 0)
  assert.equal(deviationAxis.end, 12.5)
  for (const { key } of MONTHLY_STATISTIC_METRICS) {
    assert.deepEqual(monthlyLeagueStatisticAxis([input[0]], key), monthlyStatisticAxis(input[0].statistics.rows, key))
  }
})

test('一方のリーグだけの欠損はその系列だけを切り、他リーグの連続した線を残す', () => {
  const months = ['2026-01', '2026-02', '2026-03']
  const input = [
    league('GOLD', months.map((month, index) => row({ month, status: index === 1 ? 'error' : 'ready' }))),
    league('MASTER', months.map(month => row({ month }))),
  ]
  const output = monthlyLeagueStatisticSeries(input, 'meanPercent')
  const x = (month: string) => Number(month.slice(-2))
  const y = (value: number) => value
  assert.deepEqual(output[0].points.map(point => point.value), [50.305, null, 50.305])
  assert.deepEqual(monthlyChartSegments(output[0].points, x, y), ['M 1 50.305', 'M 3 50.305'])
  assert.deepEqual(monthlyChartSegments(output[1].points, x, y), ['M 1 50.305 L 2 50.305 L 3 50.305'])
  assert.equal(monthlyStatisticValueLabel(input[0].statistics.rows[1], 'meanPercent'), '読込失敗')
  assert.equal(monthlyStatisticValueLabel(input[1].statistics.rows[1], 'meanPercent'), '50.31%')
})
