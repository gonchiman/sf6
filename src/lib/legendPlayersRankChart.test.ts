import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LegendPlayerRow } from '../types/legendPlayers.ts'
import { createLegendRankChart, legendMasterRatingAxis, legendRankKeyboardSelection, nearestLegendRankRow } from './legendPlayersRankChart.ts'

const row = (id: string, rank: number, masterRating: number): LegendPlayerRow => ({ id, rank, masterRating, playerName: id, characterId: 'ryu' })

test('順位・MRの軸は取得値から作り、全点を図内に保つ', () => {
  const rows = [row('last', 500, 2130), row('first', 1, 2805), row('middle', 200, 2399)]
  for (const width of [240, 320, 736, 1100]) {
    const chart = createLegendRankChart(rows, width)
    assert.deepEqual(chart.points.map(point => point.row.id), ['first', 'middle', 'last'])
    assert.equal(chart.width, width)
    assert.ok(chart.yAxis.start > 0)
    assert.ok(chart.yAxis.start <= 2130 && chart.yAxis.end >= 2805)
    assert.equal(chart.xAxis.ticks[0], 1)
    assert.equal(chart.xAxis.ticks.at(-1), 500)
    assert.ok(chart.xAxis.ticks.length <= 7)
    for (const point of chart.points) {
      assert.ok(point.x > chart.left && point.x < chart.right)
      assert.ok(point.y > chart.top && point.y < chart.bottom)
    }
  }
  assert.deepEqual(rows.map(item => item.id), ['last', 'first', 'middle'])
})

test('空・単一点・同一値でも軸と座標が有限', () => {
  assert.deepEqual(createLegendRankChart([], 320).points, [])
  for (const value of [0, 2500]) {
    const chart = createLegendRankChart([row('only', 25, value)], 320)
    assert.deepEqual(chart.xAxis.ticks, [25])
    assert.equal(chart.points[0].x, (chart.left + chart.right) / 2)
    assert.ok(Number.isFinite(chart.points[0].y))
    assert.ok(chart.yAxis.end > chart.yAxis.start)
  }
  const axis = legendMasterRatingAxis([2500, 2500])
  assert.ok(axis.start < 2500 && axis.end > 2500)
})

test('同順位・同MRのクリックは全行を順に選べる', () => {
  const chart = createLegendRankChart([row('a', 1, 2500), row('b', 1, 2500), row('c', 3, 2400)], 736)
  const { x, y } = chart.points[0]
  assert.equal(nearestLegendRankRow(chart.points, x, y, null), 'a')
  assert.equal(nearestLegendRankRow(chart.points, x, y, 'a'), 'b')
  assert.equal(nearestLegendRankRow(chart.points, x, y, 'b'), 'a')
  assert.equal(nearestLegendRankRow(chart.points, -100, -100, 'a'), null)
})

test('キーボードは同位置を含む全行を選べ、端で止まる', () => {
  const { points } = createLegendRankChart([row('a', 1, 2500), row('b', 1, 2500), row('c', 3, 2400)], 320)
  assert.equal(legendRankKeyboardSelection(points, null, 'ArrowRight'), 'a')
  assert.equal(legendRankKeyboardSelection(points, 'a', 'ArrowRight'), 'b')
  assert.equal(legendRankKeyboardSelection(points, 'b', 'ArrowDown'), 'c')
  assert.equal(legendRankKeyboardSelection(points, 'c', 'ArrowDown'), 'c')
  assert.equal(legendRankKeyboardSelection(points, 'b', 'ArrowLeft'), 'a')
  assert.equal(legendRankKeyboardSelection(points, 'a', 'ArrowUp'), 'a')
  assert.equal(legendRankKeyboardSelection(points, 'a', 'End'), 'c')
  assert.equal(legendRankKeyboardSelection(points, 'c', 'Home'), 'a')
  assert.equal(legendRankKeyboardSelection(points, 'c', 'Escape'), null)
  assert.equal(legendRankKeyboardSelection([], null, 'Home'), null)
})

test('図から不正な座標を除き、欠損を0に置き換えない', () => {
  const chart = createLegendRankChart([row('valid', 5, 2000), row('bad-rank', 0, 1900), row('missing', 6, NaN), row('negative', 7, -1)], 320)
  assert.deepEqual(chart.points.map(point => point.row.id), ['valid'])
})
