import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHARACTER_LEAGUE_CHART_RANGES, characterLeagueChartAxis, characterLeagueChartValue,
} from './characterLeagueChartAxis.ts'
import type { CharacterLeagueChartRange } from './characterLeagueChartAxis.ts'
import type { WinRateHistoryPoint } from '../types/winRateHistory.ts'

function point(percentHundredths: number | null, status: WinRateHistoryPoint['status'] = 'value'): WinRateHistoryPoint {
  return {
    month: '2026-08', status, total: status === 'value' ? { text: '5.361', lowSample: false } : null,
    percentHundredths, capturedAt: '2026-10-08T00:00:00.000Z', source: null,
  }
}

test('3つの固定範囲は両端と50%を含む共通目盛りを返す', () => {
  assert.deepEqual(CHARACTER_LEAGUE_CHART_RANGES.map(item => item.id), ['0-100', '40-60', '45-55'])
  const expected = [
    { start: 0, end: 100, step: 25, ticks: [0, 25, 50, 75, 100] },
    { start: 40, end: 60, step: 5, ticks: [40, 45, 50, 55, 60] },
    { start: 45, end: 55, step: 2.5, ticks: [45, 47.5, 50, 52.5, 55] },
  ]
  for (const [index, range] of CHARACTER_LEAGUE_CHART_RANGES.entries()) {
    const axis = characterLeagueChartAxis(range.id)
    assert.deepEqual(axis, expected[index])
    assert.equal(axis.ticks[0], axis.start)
    assert.equal(axis.ticks.at(-1), axis.end)
    assert.ok(axis.ticks.includes(50))
    assert.ok(axis.ticks.slice(1).every((tick, tickIndex) => tick - axis.ticks[tickIndex] === axis.step))
  }
})

test('範囲の境界に等しい掲載値は範囲外とせず、真の0%と100%を保持する', () => {
  for (const range of CHARACTER_LEAGUE_CHART_RANGES) {
    const axis = characterLeagueChartAxis(range.id)
    for (const value of [axis.start, axis.end]) {
      assert.deepEqual(characterLeagueChartValue(point(value * 100), axis), { value, displayValue: value, outside: null })
    }
  }
  const axis = characterLeagueChartAxis('0-100')
  assert.deepEqual(characterLeagueChartValue(point(0), axis), { value: 0, displayValue: 0, outside: null })
  assert.deepEqual(characterLeagueChartValue(point(10000), axis), { value: 100, displayValue: 100, outside: null })
})

test('拡大範囲の外側でも元の勝率を保持し、描画位置だけ下端・上端へクリップする', () => {
  const axis = characterLeagueChartAxis('45-55')
  for (const [hundredths, displayValue, outside] of [
    [0, 45, 'below'], [4524, 45.24, null], [4000, 45, 'below'], [6638, 55, 'above'], [10000, 55, 'above'],
  ] as const) {
    const value = point(hundredths)
    const before = structuredClone(value)
    assert.deepEqual(characterLeagueChartValue(value, axis), { value: hundredths / 100, displayValue, outside })
    assert.deepEqual(value, before)
  }
})

test('53.61%を丸めず、少数試合の印を含む掲載pointを変更しない', () => {
  const value = point(5361)
  value.total!.lowSample = true
  const before = structuredClone(value)
  for (const range of CHARACTER_LEAGUE_CHART_RANGES) {
    assert.deepEqual(characterLeagueChartValue(value, characterLeagueChartAxis(range.id)), {
      value: 53.61, displayValue: 53.61, outside: null,
    })
  }
  assert.deepEqual(value, before)
})

test('欠損・未掲載・未登録・読込失敗を0%や範囲外の掲載値に変換しない', () => {
  const empty = { value: null, displayValue: null, outside: null }
  for (const range of CHARACTER_LEAGUE_CHART_RANGES) {
    const axis = characterLeagueChartAxis(range.id)
    for (const status of ['missing', 'error', 'unlisted', 'unavailable'] as const) {
      assert.deepEqual(characterLeagueChartValue(point(null, status), axis), empty)
      // A stale numeric field must not override the point's no-value status.
      assert.deepEqual(characterLeagueChartValue(point(5000, status), axis), empty)
    }
    assert.deepEqual(characterLeagueChartValue(undefined, axis), empty)
    assert.deepEqual(characterLeagueChartValue(point(null), axis), empty)
  }
})

test('非有限・範囲外・不正精度の数値と壊れた軸を描画用の値にしない', () => {
  const empty = { value: null, displayValue: null, outside: null }
  const axis = characterLeagueChartAxis('0-100')
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 10001, 5361.5]) {
    assert.deepEqual(characterLeagueChartValue(point(value), axis), empty)
  }
  for (const invalid of [
    { start: Number.NaN, end: 100 }, { start: 0, end: Number.POSITIVE_INFINITY }, { start: 50, end: 50 }, { start: 60, end: 40 },
  ]) assert.deepEqual(characterLeagueChartValue(point(5361), invalid), empty)
  assert.throws(() => characterLeagueChartAxis('unknown' as CharacterLeagueChartRange), /表示範囲/)
})

test('同じ範囲はC/Mやキャラの極値・欠損によって自動調整されない', () => {
  for (const range of CHARACTER_LEAGUE_CHART_RANGES) {
    const axis = characterLeagueChartAxis(range.id)
    const before = structuredClone(axis)
    for (const classic of [point(0), point(4524), point(10000)]) characterLeagueChartValue(classic, axis)
    for (const modern of [point(6638), point(5361), point(null, 'missing')]) characterLeagueChartValue(modern, axis)
    assert.deepEqual(characterLeagueChartAxis(range.id), before)
    assert.equal(characterLeagueChartAxis(range.id), axis)
  }
})
