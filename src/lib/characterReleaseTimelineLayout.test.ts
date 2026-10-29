import test from 'node:test'
import assert from 'node:assert/strict'
import { chartTextWidth } from './chartTextWidth.ts'
import { buildCharacterReleaseTimelineLayout, type CharacterReleaseTimelineLayout, type CharacterReleaseTimelineLayoutEntry } from './characterReleaseTimelineLayout.ts'
import type { CharacterReleaseTimelineDirection, CharacterReleaseTimelineEvent } from '../types/characterReleaseTimeline.ts'

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000
const event = (date: string, label = 'リュウ', status: CharacterReleaseTimelineEvent['status'] = 'released', key = date): CharacterReleaseTimelineEvent => ({
  key, date, day: day(date), label, rows: [], status,
})
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`)

function labelBounds(entry: CharacterReleaseTimelineLayoutEntry) {
  const left = entry.labelX - (entry.anchor === 'end' ? entry.labelWidth : entry.anchor === 'middle' ? entry.labelWidth / 2 : 0)
  return { left, right: left + entry.labelWidth, top: entry.labelY - 30, bottom: entry.labelY + (entry.labelLines.length - 1) * 16 + 4 }
}

function assertLabelsFit(layout: CharacterReleaseTimelineLayout) {
  for (const entry of layout.entries) {
    const bounds = labelBounds(entry)
    assert.ok(bounds.left >= 0 && bounds.right <= layout.width, `${entry.event.key}: horizontal label bounds`)
    assert.ok(bounds.top >= 0 && bounds.bottom <= layout.height, `${entry.event.key}: vertical label bounds`)
    assert.ok(entry.labelLines.every(line => chartTextWidth(line) <= entry.labelWidth))
  }
  for (const [index, entry] of layout.entries.entries()) {
    const bounds = labelBounds(entry)
    for (const other of layout.entries.slice(index + 1)) {
      const otherBounds = labelBounds(other)
      const overlap = bounds.left < otherBounds.right && bounds.right > otherBounds.left
        && bounds.top < otherBounds.bottom && bounds.bottom > otherBounds.top
      assert.equal(overlap, false, `${entry.event.key} and ${other.event.key}: label overlap`)
    }
  }
}

function assertCalendarScale(layout: CharacterReleaseTimelineLayout, direction: CharacterReleaseTimelineDirection) {
  const first = layout.entries[0]
  const last = layout.entries.at(-1)!
  const start = first.event.day
  const span = last.event.day - start
  for (const entry of layout.entries) {
    const fraction = span === 0 ? .5 : (entry.event.day - start) / span
    if (direction === 'horizontal') {
      close(entry.x, layout.axis.x1 + fraction * (layout.axis.x2 - layout.axis.x1))
      close(entry.y, layout.axis.y1)
    } else {
      close(entry.y, layout.axis.y1 + fraction * (layout.axis.y2 - layout.axis.y1))
      close(entry.x, layout.axis.x1)
    }
    close(entry.connector.x1, entry.x)
    close(entry.connector.y1, entry.y)
  }
  for (const tick of layout.ticks) {
    const fraction = span === 0 ? .5 : (day(tick.key) - start) / span
    if (direction === 'horizontal') close(tick.x, layout.axis.x1 + fraction * (layout.axis.x2 - layout.axis.x1))
    else close(tick.y, layout.axis.y1 + fraction * (layout.axis.y2 - layout.axis.y1))
  }
}

test('horizontal positions use exact UTC day ratios, including a leap day', () => {
  const events = [event('2024-02-28'), event('2024-02-29'), event('2024-03-02'), event('2024-09-01')]
  const layout = buildCharacterReleaseTimelineLayout(events, 'horizontal', 920)
  assertCalendarScale(layout, 'horizontal')
  close((layout.entries[2].x - layout.entries[0].x) / (layout.entries[1].x - layout.entries[0].x), 3)
  assert.deepEqual(layout.dateRange, { start: '2024-02-28', end: '2024-09-01' })
})

test('changing the viewport changes only the spatial scale, not the date ratios', () => {
  const events = [event('2023-06-02'), event('2023-07-24'), event('2023-09-27'), event('2024-05-22')]
  for (const width of [320, 736, 1200]) {
    const layout = buildCharacterReleaseTimelineLayout(events, 'horizontal', width)
    assertCalendarScale(layout, 'horizontal')
    assertLabelsFit(layout)
  }
})

test('narrow horizontal labels use additional lanes while event points stay on one axis', () => {
  const events = Array.from({ length: 12 }, (_, index) => event(`2024-01-${String(index + 1).padStart(2, '0')}`, '折り返しが必要な長いキャラクター名のテスト'))
  const layout = buildCharacterReleaseTimelineLayout(events, 'horizontal', 320)
  assert.equal(layout.width, 320)
  assert.ok(new Set(layout.entries.map(entry => entry.labelY)).size > 2)
  assertCalendarScale(layout, 'horizontal')
  assertLabelsFit(layout)
  assert.ok(layout.entries.every(entry => entry.labelLines.length > 1))
})

test('end labels turn inward without shifting their calendar points', () => {
  const layout = buildCharacterReleaseTimelineLayout([event('2023-06-02', '初期18キャラ'), event('2026-10-15', 'ヴァイパー')], 'horizontal', 320)
  assert.equal(layout.entries[0].anchor, 'start')
  assert.equal(layout.entries[1].anchor, 'end')
  close(layout.entries[0].x, layout.axis.x1)
  close(layout.entries[1].x, layout.axis.x2)
  assertLabelsFit(layout)
})

test('vertical collision prevention lengthens the whole date scale uniformly', () => {
  const events = [event('2023-01-01'), event('2023-01-02'), event('2023-01-03'), event('2024-01-01')]
  const layout = buildCharacterReleaseTimelineLayout(events, 'vertical', 320)
  assert.ok(layout.axis.y2 - layout.axis.y1 > 600)
  assertCalendarScale(layout, 'vertical')
  assertLabelsFit(layout)
  close((layout.entries[3].y - layout.entries[0].y) / (layout.entries[2].y - layout.entries[0].y), 365 / 2)
})

test('same-day events share the exact point and have distinct nonoverlapping labels', () => {
  const events = Array.from({ length: 6 }, (_, index) => event('2026-10-15', `同日キャラ${index}`, index % 2 ? 'scheduled' : 'released', `same-${index}`))
  for (const direction of ['horizontal', 'vertical'] as const) {
    const layout = buildCharacterReleaseTimelineLayout(events, direction, 320)
    assertCalendarScale(layout, direction)
    assertLabelsFit(layout)
    assert.ok(layout.entries.every(entry => entry.x === layout.entries[0].x && entry.y === layout.entries[0].y))
    assert.deepEqual(layout.entries.map(entry => entry.event.key), events.map(entry => entry.key))
  }
})

test('an empty input has finite dimensions and no inferred date range', () => {
  for (const direction of ['horizontal', 'vertical'] as const) {
    const layout = buildCharacterReleaseTimelineLayout([], direction, Number.NaN)
    assert.equal(layout.width, 320)
    assert.ok(Number.isFinite(layout.height))
    assert.deepEqual(layout.entries, [])
    assert.deepEqual(layout.ticks, [])
    assert.equal(layout.dateRange, null)
    assert.ok(Object.values(layout.axis).every(Number.isFinite))
  }
})

test('one filtered event is centered and keeps its status, date, and row identity', () => {
  const selected = event('2026-10-15', '非常に長い日本語キャラクター名', 'scheduled')
  for (const direction of ['horizontal', 'vertical'] as const) {
    const layout = buildCharacterReleaseTimelineLayout([selected], direction, 320)
    assertCalendarScale(layout, direction)
    assertLabelsFit(layout)
    assert.equal(layout.entries[0].event, selected)
    assert.equal(layout.entries[0].dateLabel, '2026/10/15（予定）')
    assert.deepEqual(layout.dateRange, { start: selected.date, end: selected.date })
  }
})

test('sorting and filtered domains do not mutate the supplied events', () => {
  const events = Object.freeze([Object.freeze(event('2026-06-01')), Object.freeze(event('2024-05-22')), Object.freeze(event('2025-06-04'))])
  const layout = buildCharacterReleaseTimelineLayout(events, 'horizontal', 736)
  assert.deepEqual(events.map(item => item.date), ['2026-06-01', '2024-05-22', '2025-06-04'])
  assert.deepEqual(layout.entries.map(item => item.event.date), ['2024-05-22', '2025-06-04', '2026-06-01'])
  assert.deepEqual(layout.dateRange, { start: '2024-05-22', end: '2026-06-01' })
  assertCalendarScale(layout, 'horizontal')
})

test('long ranges use calendar year ticks and short ranges use month ticks without overlap', () => {
  const annual = buildCharacterReleaseTimelineLayout([event('2023-06-02'), event('2027-09-01')], 'horizontal', 320)
  assert.ok(annual.ticks.length > 0)
  assert.ok(annual.ticks.every(tick => /^\d{4}$/.test(tick.label)))
  assertCalendarScale(annual, 'horizontal')
  const monthly = buildCharacterReleaseTimelineLayout([event('2024-02-10'), event('2024-08-15')], 'horizontal', 320)
  assert.ok(monthly.ticks.length > 0)
  assert.ok(monthly.ticks.every(tick => /^\d{4}\/\d{2}$/.test(tick.label)))
  assertCalendarScale(monthly, 'horizontal')
  for (const layout of [annual, monthly]) {
    const bounds = layout.ticks.map(tick => {
      const width = chartTextWidth(tick.label)
      const left = tick.x - (tick.anchor === 'end' ? width : tick.anchor === 'middle' ? width / 2 : 0)
      return { left, right: left + width }
    })
    for (let index = 1; index < bounds.length; index++) assert.ok(bounds[index].left >= bounds[index - 1].right + 12)
  }
})

test('vertical ticks follow the same calendar mapping and avoid event markers', () => {
  const layout = buildCharacterReleaseTimelineLayout([event('2023-06-02'), event('2027-09-01')], 'vertical', 320)
  assertCalendarScale(layout, 'vertical')
  assert.ok(layout.ticks.length > 0)
  for (const tick of layout.ticks) assert.ok(layout.entries.every(entry => Math.abs(entry.y - tick.y) >= 18))
})

test('labels stay outside the reserved vertical header and horizontal footer title areas', () => {
  const events = Array.from({ length: 12 }, (_, index) => event(`2024-01-${String(index + 1).padStart(2, '0')}`, '複数行に折り返す長いキャラクター名のテスト'))
  for (const width of [320, 920]) {
    const vertical = buildCharacterReleaseTimelineLayout(events, 'vertical', width)
    const horizontal = buildCharacterReleaseTimelineLayout(events, 'horizontal', width)
    assertCalendarScale(vertical, 'vertical')
    assertCalendarScale(horizontal, 'horizontal')
    for (const entry of vertical.entries) assert.ok(labelBounds(entry).top >= 30)
    for (const entry of horizontal.entries) assert.ok(labelBounds(entry).bottom <= horizontal.height - 30)
    assertLabelsFit(vertical)
    assertLabelsFit(horizontal)
  }
})
