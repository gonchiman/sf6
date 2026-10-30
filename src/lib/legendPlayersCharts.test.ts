import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLegendPlayerCharacterCounts, createLegendPlayerMrBins, legendPlayerCountAxis } from './legendPlayersCharts.ts'
import type { LegendPlayerRow } from '../types/legendPlayers.ts'

function row(id: number, characterId: string, masterRating: number, rank = id): LegendPlayerRow {
  return { id: `entry-${id}`, playerName: '同じ表示名', characterId, rank, masterRating }
}

test('character counts preserve every listing, including repeated names, characters and tied ranks', () => {
  const rows = [row(1, 'ryu', 2510, 1), row(2, 'ken', 2500, 2), row(3, 'ryu', 2500, 2), row(4, 'new_character', 2499, 4)]
  const original = structuredClone(rows)
  const names = new Map([['ryu', 'リュウ'], ['ken', 'ケン'], ['absent', '非掲載キャラ']])
  assert.deepEqual(createLegendPlayerCharacterCounts(rows, names), [
    { characterId: 'ryu', name: 'リュウ', count: 2, percent: 50 },
    { characterId: 'ken', name: 'ケン', count: 1, percent: 25 },
    { characterId: 'new_character', name: 'new_character', count: 1, percent: 25 },
  ])
  assert.deepEqual(rows, original)
})

test('equal counts have a stable character-ID order independent of source order or translated names', () => {
  const rows = [row(1, 'ryu', 2450), row(2, 'ken', 2440), row(3, 'luke', 2430)]
  const expected = createLegendPlayerCharacterCounts(rows)
  assert.deepEqual(expected.map(item => item.characterId), ['ken', 'luke', 'ryu'])
  assert.deepEqual(createLegendPlayerCharacterCounts([...rows].reverse()), expected)
  assert.ok(expected.every(item => Math.abs(item.percent - 100 / 3) < 1e-12))
  assert.equal(expected.reduce((total, item) => total + item.count, 0), rows.length)
})

test('50-MR bins include lower endpoints, exclude upper endpoints, and preserve interior zeros', () => {
  const rows = [row(1, 'ryu', 2399), row(2, 'ken', 2400), row(3, 'ryu', 2449), row(4, 'ken', 2500)]
  const original = structuredClone(rows)
  assert.deepEqual(createLegendPlayerMrBins(rows), [
    { lower: 2350, upper: 2400, count: 1, percent: 25 },
    { lower: 2400, upper: 2450, count: 2, percent: 50 },
    { lower: 2450, upper: 2500, count: 0, percent: 0 },
    { lower: 2500, upper: 2550, count: 1, percent: 25 },
  ])
  assert.deepEqual(rows, original)
})

test('empty verified captures stay empty, and a single capture entry yields its real full share', () => {
  assert.deepEqual(createLegendPlayerCharacterCounts([]), [])
  assert.deepEqual(createLegendPlayerMrBins([]), [])
  assert.deepEqual(createLegendPlayerCharacterCounts([row(1, 'unknown', 2500)]), [
    { characterId: 'unknown', name: 'unknown', count: 1, percent: 100 },
  ])
  assert.deepEqual(createLegendPlayerMrBins([row(1, 'unknown', 2500)]), [
    { lower: 2500, upper: 2550, count: 1, percent: 100 },
  ])
})

test('MR counts use actual row count, not 500, and invalid values are not silently discarded', () => {
  const rows = Array.from({ length: 501 }, (_, index) => row(index + 1, index % 2 ? 'ryu' : 'ken', 2500, 1))
  assert.deepEqual(createLegendPlayerMrBins(rows), [{ lower: 2500, upper: 2550, count: 501, percent: 100 }])
  assert.equal(createLegendPlayerCharacterCounts(rows).reduce((total, item) => total + item.count, 0), 501)
  for (const value of [NaN, Infinity, -1, 1.5]) assert.throws(() => createLegendPlayerMrBins([row(1, 'ryu', value)]))
})

test('count axes start at zero with integer ticks and encompass small and large counts', () => {
  for (const counts of [[], [0], [1], [2], [5], [7], [11, 250], [501]]) {
    const axis = legendPlayerCountAxis(counts)
    assert.equal(axis.ticks[0], 0)
    assert.equal(axis.ticks.at(-1), axis.maximum)
    assert.ok(axis.maximum > 0 && axis.maximum >= Math.max(0, ...counts))
    assert.ok(axis.ticks.every(Number.isSafeInteger))
    assert.equal(new Set(axis.ticks).size, axis.ticks.length)
  }
})
