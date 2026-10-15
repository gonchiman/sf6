import assert from 'node:assert/strict'
import test from 'node:test'
import { MONTHLY_USAGE_STATISTIC_METRICS, monthlyUsageLeagueStatisticAxis, monthlyUsageStatisticAxis } from './monthlyUsageRateStatisticsChart.ts'
import { formatMonthlyStatisticTick, MONTHLY_STATISTIC_METRICS, monthlyLeagueStatisticSeries, monthlyStatisticDefinition, monthlyStatisticValue, monthlyStatisticValueLabel } from './monthlyWinRateStatisticsChart.ts'
import { monthlyChartSegments } from './monthlyLineChart.ts'
import { leagueSeriesStyle } from './leagueSeriesColors.ts'
import type { MonthlyStatisticsRow, MonthlyStatisticsSeries } from '../types/monthlyStatisticsPresentation.ts'

function row(value: number, month = '2026-01'): MonthlyStatisticsRow {
  return {
    month, status: 'ready', listedCount: 3, validCount: 3,
    statistics: { meanPercent: value, medianPercent: value, standardDeviationPoints: value, minimumPercent: value, maximumPercent: value },
  }
}

function league(id: string, rows: MonthlyStatisticsRow[]): MonthlyStatisticsSeries {
  return { league: id, statistics: { rows } }
}

test('使用率の5指標は0から始まり、小さな使用率に勝率用50%を強制しない', () => {
  for (const { key } of MONTHLY_STATISTIC_METRICS) {
    const axis = monthlyUsageStatisticAxis([row(3.2258)], key)
    assert.equal(axis.start, 0)
    assert.ok(axis.end > 3.2258)
    assert.ok(axis.end < 50)
    assert.equal(axis.ticks[0], 0)
    assert.equal(axis.ticks.at(-1), axis.end)
  }
})

test('使用率0%・欠損・空データでも有効な0始点軸を保つ', () => {
  for (const rows of [[], [row(0)], [{ ...row(20), status: 'error' as const }], [{ ...row(20), statistics: null }]]) {
    for (const { key } of MONTHLY_STATISTIC_METRICS) {
      assert.deepEqual(monthlyUsageStatisticAxis(rows, key), {
        start: 0, end: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1],
      })
    }
  }
})

test('百分率指標は100%を収めて超過せず、0.001単位の小さい値も目盛りを区別する', () => {
  for (const value of [0.001, 0.005, 2, 85, 99.999, 100]) {
    for (const { key } of MONTHLY_STATISTIC_METRICS) {
      const axis = monthlyUsageStatisticAxis([row(value)], key)
      assert.ok(axis.end >= value)
      if (key !== 'standardDeviationPoints') assert.ok(axis.end <= 100)
      assert.ok(axis.ticks.every((tick, index) => index === 0 || tick > axis.ticks[index - 1]))
      assert.equal(new Set(axis.ticks.map(tick => formatMonthlyStatisticTick(tick, axis.step))).size, axis.ticks.length)
    }
  }
  const tiny = monthlyUsageStatisticAxis([row(0.005)], 'standardDeviationPoints')
  assert.deepEqual(tiny.ticks, [0, 0.002, 0.004, 0.006])
})

test('ALLとMASTERの使用率を独立系列として共通軸に収め、並べ替えでも固定styleを保つ', () => {
  const input = [league('ALL', [row(2.34567)]), league('MASTER', [row(12.34567)])]
  const before = structuredClone(input)
  const series = monthlyLeagueStatisticSeries(input, 'meanPercent')
  assert.equal(series[0].label, 'ALL（全体）')
  assert.deepEqual(series.map(item => item.points[0].value), [2.34567, 12.34567])
  assert.equal(series[0].style, leagueSeriesStyle('ALL'))
  assert.equal(series[1].style, leagueSeriesStyle('MASTER'))
  assert.deepEqual(monthlyLeagueStatisticSeries([...input].reverse(), 'meanPercent').map(item => item.style), series.map(item => item.style).reverse())
  const axis = monthlyUsageLeagueStatisticAxis(input, 'meanPercent')
  assert.equal(axis.start, 0)
  assert.ok(axis.end > 12.34567 && axis.end < 50)
  assert.deepEqual(input, before)
})

test('使用率統計の欠損はそのリーグだけ線を切り、0%と他リーグの連続を残す', () => {
  const months = ['2026-01', '2026-02', '2026-03']
  const input = [
    league('ALL', months.map((month, index) => ({ ...row(0, month), status: index === 1 ? 'unavailable' as const : 'ready' as const }))),
    league('MASTER', months.map(month => row(4, month))),
  ]
  const series = monthlyLeagueStatisticSeries(input, 'medianPercent')
  const x = (month: string) => Number(month.slice(-2))
  assert.deepEqual(monthlyChartSegments(series[0].points, x, value => value), ['M 1 0', 'M 3 0'])
  assert.deepEqual(monthlyChartSegments(series[1].points, x, value => value), ['M 1 4 L 2 4 L 3 4'])
  assert.equal(monthlyUsageLeagueStatisticAxis(input, 'medianPercent').start, 0)
})

test('使用率だけ標準偏差の後にCVを追加し、勝率の指標5種を維持する', () => {
  assert.deepEqual(MONTHLY_USAGE_STATISTIC_METRICS.map(item => item.key), [
    'meanPercent', 'medianPercent', 'standardDeviationPoints', 'coefficientOfVariation', 'minimumPercent', 'maximumPercent',
  ])
  assert.equal(MONTHLY_STATISTIC_METRICS.length, 5)
  assert.ok(MONTHLY_STATISTIC_METRICS.every(item => item.key !== ('coefficientOfVariation' as string)))
  assert.deepEqual(monthlyStatisticDefinition('coefficientOfVariation'), { key: 'coefficientOfVariation', label: '変動係数', unit: '比率' })
})

test('CVは集計済みの比率を丸め前のまま描画し、表示に%やポイントを付けない', () => {
  const input = row(4)
  input.statistics = { ...input.statistics!, standardDeviationPoints: 10, coefficientOfVariation: 2.50005 }
  assert.equal(monthlyStatisticValue(input, 'coefficientOfVariation'), 2.50005)
  assert.equal(monthlyStatisticValueLabel(input, 'coefficientOfVariation'), '2.50')
  const series = monthlyLeagueStatisticSeries([league('MASTER', [input])], 'coefficientOfVariation')
  assert.equal(series[0].points[0].value, 2.50005)
  const axis = monthlyUsageStatisticAxis([input], 'coefficientOfVariation')
  assert.equal(axis.start, 0)
  assert.ok(axis.end > 2.50005)
  assert.ok(axis.end > 1)
  assert.ok(axis.end < 10)
})

test('CVの実際の0を保持し、平均0・SD未算出・未提供値を0で埋めない', () => {
  const zero = row(4)
  zero.statistics = { ...zero.statistics!, standardDeviationPoints: 0, coefficientOfVariation: 0 }
  assert.equal(monthlyStatisticValue(zero, 'coefficientOfVariation'), 0)
  assert.equal(monthlyStatisticValueLabel(zero, 'coefficientOfVariation'), '0.00')
  const invalid: MonthlyStatisticsRow[] = [
    row(4),
    { ...zero, statistics: { ...zero.statistics!, coefficientOfVariation: null } },
    { ...zero, statistics: { ...zero.statistics!, meanPercent: 0 } },
    { ...zero, validCount: 1, statistics: { ...zero.statistics!, standardDeviationPoints: null } },
    { ...zero, status: 'error' },
    { ...zero, status: 'incomplete' },
  ]
  for (const input of invalid) assert.equal(monthlyStatisticValue(input, 'coefficientOfVariation'), null)
  assert.equal(monthlyStatisticValueLabel(invalid[3], 'coefficientOfVariation'), '算出できません（対象が1キャラ）')
  assert.equal(monthlyStatisticValueLabel(invalid[4], 'coefficientOfVariation'), '読込失敗')
  assert.equal(monthlyStatisticValueLabel(invalid[5], 'coefficientOfVariation'), '共通キャラを確認できません')
  assert.deepEqual(monthlyUsageStatisticAxis(invalid, 'coefficientOfVariation'), {
    start: 0, end: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1],
  })
})
