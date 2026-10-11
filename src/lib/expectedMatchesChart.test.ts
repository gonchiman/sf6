import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedMatchResultText, expectedMatchesAxis, expectedMatchValue } from './expectedMatchesChart.ts'
import type { ExpectedMatchRow } from '../types/expectedMatchData.ts'

function row(result: ExpectedMatchRow['result'], characterId = 'ryu'): ExpectedMatchRow {
  return { character: { fighter: { id: characterId, characterId, name: characterId.toUpperCase(), controlType: null }, ranks: [], available: true }, result }
}

function finite(value: number, id = 'ryu'): ExpectedMatchRow {
  return row({ status: 'finite', expectedMatches: value, stateCount: 1, residualBound: 0 }, id)
}

test('axis starts at zero and covers all calculation rows, including unselected characters', () => {
  const allRows = [finite(1516.5, 'honda'), finite(2267.3, 'ryu'), finite(4706.9, 'jamie')]
  const axis = expectedMatchesAxis(allRows)
  assert.deepEqual(axis, { maximum: 5000, ticks: [0, 1000, 2000, 3000, 4000, 5000] })
  assert.equal(axis.ticks[0], 0)
  assert.ok(axis.maximum >= Math.max(...allRows.map(item => expectedMatchValue(item)!)))
})

test('scale adapts to changed model results without rounding observations', () => {
  const item = finite(12345.678)
  const axis = expectedMatchesAxis([item])
  assert.deepEqual(axis, { maximum: 15000, ticks: [0, 5000, 10000, 15000] })
  assert.equal(expectedMatchValue(item), 12345.678)
  assert.equal(expectedMatchResultText(item), '12,345.7')
  assert.equal(expectedMatchResultText(item, 0), '12,346')
})

test('real zero remains a numeric observation with a nonzero axis span', () => {
  const item = finite(0)
  assert.equal(expectedMatchValue(item), 0)
  assert.equal(expectedMatchResultText(item), '0')
  assert.equal(expectedMatchResultText(item, 0), '0')
  assert.deepEqual(expectedMatchesAxis([item]), { maximum: 1, ticks: [0, 1] })
})

test('infinite, missing, failed and invalid numeric results are labels without numeric bars', () => {
  const cases: [ExpectedMatchRow, string][] = [
    [row({ status: 'infinite', reason: 'unreachable-target', stateCount: 1 }), '∞'],
    [row({ status: 'missing-data' }), 'データ不足'],
    [row({ status: 'numerical-failure', reason: 'unstable-solution', stateCount: 1 }), '計算不能'],
    [finite(Number.NaN), '計算不能'], [finite(Number.POSITIVE_INFINITY), '計算不能'], [finite(-1), '計算不能'],
  ]
  for (const [item, label] of cases) {
    assert.equal(expectedMatchValue(item), null)
    assert.equal(expectedMatchResultText(item), label)
    assert.equal(expectedMatchResultText(item, 0), label)
  }
  assert.deepEqual(expectedMatchesAxis(cases.map(([item]) => item)), { maximum: 1, ticks: [0, 1] })
})

test('axis arithmetic stays finite for very large finite results', () => {
  const axis = expectedMatchesAxis([finite(Number.MAX_VALUE)])
  assert.ok(Number.isFinite(axis.maximum))
  assert.equal(axis.ticks[0], 0)
  assert.ok(axis.ticks.every(Number.isFinite))
  assert.equal(axis.ticks.at(-1), axis.maximum)
})
