import assert from 'node:assert/strict'
import test from 'node:test'
import { usageRateComparisonStyle } from './usageRateComparisonColors.ts'

function contrastAgainstWhite(color: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 1.05 / (channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 + 0.05)
}

test('comparison rows have fixed slot colors with solid lines and circular markers', () => {
  const expected = ['#546f8b', '#a07752', '#6c7e67', '#8a6f88', '#6b7c82', '#927963']
  for (const [slot, color] of expected.entries()) {
    const style = usageRateComparisonStyle(slot)
    assert.equal(style.color, color)
    assert.equal(style.marker, 'circle')
    assert.equal(style.dashArray, undefined)
  }
})

test('retaining slots preserves styles after rows are reordered, added or removed', () => {
  const initial = [0, 3, 5].map(usageRateComparisonStyle)
  const reordered = [5, 1, 0, 3].map(usageRateComparisonStyle)
  assert.equal(initial[0], reordered[2])
  assert.equal(initial[1], reordered[3])
  assert.equal(initial[2], reordered[0])
  const afterRemoval = [3, 5].map(usageRateComparisonStyle)
  assert.equal(afterRemoval[0], initial[1])
  assert.equal(afterRemoval[1], initial[2])
})

test('unknown slots use a separate gray instead of borrowing a known slot', () => {
  const unknown = usageRateComparisonStyle(-1)
  assert.match(unknown.color, /^#([0-9a-f]{2})\1\1$/)
  for (const slot of [-1, 6, 100, 0.5, Number.NaN, Infinity, -Infinity]) {
    assert.equal(usageRateComparisonStyle(slot), unknown)
  }
  for (let slot = 0; slot < 6; slot += 1) assert.notEqual(usageRateComparisonStyle(slot).color, unknown.color)
})

test('all known and fallback colors remain visible against a white chart background', () => {
  for (const slot of [-1, 0, 1, 2, 3, 4, 5]) {
    const style = usageRateComparisonStyle(slot)
    assert.match(style.color, /^#[0-9a-f]{6}$/)
    assert.ok(contrastAgainstWhite(style.color) >= 3, `${style.color}: white contrast below 3:1`)
  }
})
