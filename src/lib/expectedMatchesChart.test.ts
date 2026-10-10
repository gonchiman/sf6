import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedMatchResultText, expectedMatchesAxis, expectedMatchValue } from './expectedMatchesChart.ts'
import type { ExpectedMatchRow } from '../types/expectedMatchData.ts'
import { characterBarSeriesStyle } from './characterBarColors.ts'
import { CHARACTER_SERIES_STYLES, CHARACTER_SERIES_ALIASES, UNKNOWN_CHARACTER_SERIES_STYLE } from './seriesColors.ts'

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
})

test('real zero remains a numeric observation with a nonzero axis span', () => {
  const item = finite(0)
  assert.equal(expectedMatchValue(item), 0)
  assert.equal(expectedMatchResultText(item), '0')
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

test('muted and monochrome fills retain readable contrast and canonical character identities', () => {
  const original = JSON.stringify(CHARACTER_SERIES_STYLES)
  const contrastOnWhite = (color: string) => {
    const channels = [1, 3, 5].map(start => {
      const value = Number.parseInt(color.slice(start, start + 2), 16) / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    })
    return 1.05 / (.2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2] + .05)
  }
  assert.equal(characterBarSeriesStyle('ryu').color, '#87909b')
  for (const [id, series] of Object.entries(CHARACTER_SERIES_STYLES).toReversed()) {
    for (const colored of [true, false]) {
      const result = characterBarSeriesStyle(id, colored)
      assert.ok(contrastOnWhite(result.color) >= 3, `${id} contrast`)
      assert.equal(result.marker, series.marker)
      assert.equal(result.dashArray, series.dashArray)
      assert.ok(Object.isFrozen(result))
      if (!colored) assert.equal(result.color, '#8c8c8c')
    }
  }
  for (const [alias, id] of Object.entries(CHARACTER_SERIES_ALIASES)) {
    assert.deepEqual(characterBarSeriesStyle(alias), characterBarSeriesStyle(id))
    assert.deepEqual(characterBarSeriesStyle(alias, false), characterBarSeriesStyle(id, false))
  }
  for (const id of ['unknown', '', 'toString', '__proto__', 'RYU']) {
    assert.equal(characterBarSeriesStyle(id), UNKNOWN_CHARACTER_SERIES_STYLE)
    assert.equal(characterBarSeriesStyle(id, false), UNKNOWN_CHARACTER_SERIES_STYLE)
  }
  assert.equal(JSON.stringify(CHARACTER_SERIES_STYLES), original)
})
