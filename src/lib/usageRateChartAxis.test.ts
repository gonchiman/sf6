import assert from 'node:assert/strict'
import test from 'node:test'
import { USAGE_RATE_CHART_RANGES, usageRateChartAxis } from './usageRateChartAxis.ts'
import { leaguePercentageChartTicks, leaguePercentageChartValue } from './leaguePercentageChart.ts'

test('使用率のプリセットは0基点を共有し、20%・10%・100%の固定上限を保つ', () => {
  assert.deepEqual(USAGE_RATE_CHART_RANGES.map(item => item.id), ['0-20', '0-10', '0-100'])
  for (const range of USAGE_RATE_CHART_RANGES) {
    const axis = usageRateChartAxis(range.id)
    assert.equal(axis.start, 0)
    assert.equal(axis.ticks[0], 0)
    assert.equal(axis.ticks.at(-1), axis.end)
  }
})

test('公式使用率9.739%は丸めず10倍せず、10%範囲にも同じ値で描画する', () => {
  const point = leaguePercentageChartValue(9.739, usageRateChartAxis('0-10'))
  assert.deepEqual(point, { value: 9.739, displayValue: 9.739, outside: null })
})

test('上限外でも元の使用率を保持し、描画位置だけクリップする', () => {
  const axis = usageRateChartAxis('0-10')
  assert.deepEqual(leaguePercentageChartValue(18.065, axis), { value: 18.065, displayValue: 10, outside: 'above' })
  assert.deepEqual(leaguePercentageChartValue(10, axis), { value: 10, displayValue: 10, outside: null })
  assert.deepEqual(leaguePercentageChartValue(0, axis), { value: 0, displayValue: 0, outside: null })
  assert.deepEqual(leaguePercentageChartValue(null, axis), { value: null, displayValue: null, outside: null })
})

test('狭幅の使用率軸に勝率50%を混ぜず、勝率の軸では50%を保つ', () => {
  assert.deepEqual(leaguePercentageChartTicks(usageRateChartAxis('0-20'), true), [0, 10, 20])
  assert.deepEqual(leaguePercentageChartTicks(usageRateChartAxis('0-10'), true), [0, 5, 10])
  const winAxis = { start: 45, end: 55, ticks: [45, 47.5, 50, 52.5, 55] }
  assert.deepEqual(leaguePercentageChartTicks(winAxis, true, 50), [45, 50, 55])
  assert.deepEqual(leaguePercentageChartTicks(winAxis, false, 50), winAxis.ticks)
})
