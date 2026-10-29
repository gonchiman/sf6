import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCharacterReleaseTimeline } from './characterReleaseTimeline.ts'
import type { CharacterReleaseRow } from '../types/characterReleases.ts'

function row(characterId: string, overrides: Partial<CharacterReleaseRow> = {}): CharacterReleaseRow {
  return {
    characterId, kind: 'initial', status: 'released', releaseDate: '2023-06-02',
    source: { title: '本日発売', url: 'https://prtimes.jp/main/html/rd/p/000003774.000013450.html' },
    character: { id: characterId, name: characterId === 'ryu' ? 'リュウ' : characterId === 'ken' ? 'ケン' : characterId,
      englishName: characterId.toUpperCase(), file: `${characterId}.json` },
    ...overrides,
  }
}

test('空の絞り込み結果ではイベントも日付未確認も空にする', () => {
  assert.deepEqual(buildCharacterReleaseTimeline([]), { events: [], undated: [] })
})

test('初期18人を同日グループにし、元のキャラ順と出典参照を保持する', () => {
  const rows = Array.from({ length: 18 }, (_, index) => row(`initial-${index}`))
  const before = structuredClone(rows)
  const result = buildCharacterReleaseTimeline(rows)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].label, '初期18キャラ')
  assert.equal(result.events[0].date, '2023-06-02')
  assert.equal(result.events[0].status, 'released')
  assert.deepEqual(result.events[0].rows.map((entry) => entry.characterId), rows.map((entry) => entry.characterId))
  assert.notStrictEqual(result.events[0].rows, rows)
  for (const [index, entry] of result.events[0].rows.entries()) {
    assert.strictEqual(entry, rows[index])
    assert.strictEqual(entry.source, rows[index].source)
  }
  assert.deepEqual(rows, before)
})

test('単体フィルターでは初期キャラも実名にし、追加キャラも実名にする', () => {
  const initial = row('ryu')
  const additional = row('rashid', { kind: 'additional', releaseDate: '2023-07-24' })
  const all = buildCharacterReleaseTimeline([additional, initial])
  assert.deepEqual(all.events.map((event) => event.label), ['リュウ', 'rashid'])
  const selected = buildCharacterReleaseTimeline([row('ken'), initial].filter((entry) => entry.characterId === 'ryu'))
  assert.equal(selected.events[0].label, 'リュウ')
  assert.strictEqual(selected.events[0].rows[0], initial)
})

test('初期の部分集合や同日追加を実件数で示し、初期と追加の混合を初期扱いしない', () => {
  assert.equal(buildCharacterReleaseTimeline([row('ken'), row('ryu')]).events[0].label, '初期2キャラ')
  const first = row('first', { kind: 'additional' })
  const second = row('second', { kind: 'additional' })
  assert.equal(buildCharacterReleaseTimeline([second, first]).events[0].label, '同日2キャラ')
  assert.deepEqual(buildCharacterReleaseTimeline([second, first]).events[0].rows.map((entry) => entry.characterId), ['second', 'first'])
  assert.equal(buildCharacterReleaseTimeline([row('ryu'), first]).events[0].label, '同日2キャラ')
})

test('同日でも実装済みと予定は別イベントにし、状態順を元の並びに依存させない', () => {
  const released = row('released', { kind: 'additional', releaseDate: '2024-02-29' })
  const firstScheduled = row('scheduled-first', { kind: 'additional', status: 'scheduled', releaseDate: '2024-02-29' })
  const secondScheduled = row('scheduled-second', { kind: 'additional', status: 'scheduled', releaseDate: '2024-02-29' })
  const result = buildCharacterReleaseTimeline([firstScheduled, released, secondScheduled])
  assert.deepEqual(result.events.map((event) => event.status), ['released', 'scheduled'])
  assert.notEqual(result.events[0].key, result.events[1].key)
  assert.equal(result.events[0].day, result.events[1].day)
  assert.deepEqual(result.events[1].rows, [firstScheduled, secondScheduled])
  assert.equal(result.events[1].label, '同日2キャラ')
  const reversed = buildCharacterReleaseTimeline([secondScheduled, released, firstScheduled])
  assert.deepEqual(reversed.events.map((event) => event.key), result.events.map((event) => event.key))
  assert.deepEqual(reversed.events[1].rows, [secondScheduled, firstScheduled])
})

test('日付の降順入力でもイベントを昇順にし、同日の入力順を維持する', () => {
  const rows = [row('latest', { releaseDate: '2025-12-01', kind: 'additional' }),
    row('earlier-b'), row('middle', { releaseDate: '2024-09-24', kind: 'additional' }), row('earlier-a')]
  const before = structuredClone(rows)
  const result = buildCharacterReleaseTimeline(rows)
  assert.deepEqual(result.events.map((event) => event.date), ['2023-06-02', '2024-09-24', '2025-12-01'])
  assert.deepEqual(result.events[0].rows.map((entry) => entry.characterId), ['earlier-b', 'earlier-a'])
  assert.deepEqual(rows, before)
})

test('日付未確認やnullを推測配置せず入力順のundatedへ残す', () => {
  const unknown = row('unknown', { status: 'unverified', releaseDate: null, source: null })
  const releasedWithoutDate = row('released-null', { releaseDate: null })
  const scheduledWithoutDate = row('scheduled-null', { status: 'scheduled', releaseDate: null })
  const unverifiedWithDate = row('unverified-with-date', { status: 'unverified', releaseDate: '2023-06-02' })
  const dated = row('ryu')
  const undated = [unknown, releasedWithoutDate, scheduledWithoutDate, unverifiedWithDate]
  const result = buildCharacterReleaseTimeline([unknown, dated, ...undated.slice(1)])
  assert.deepEqual(result.undated, undated)
  assert.equal(result.events.length, 1)
  assert.strictEqual(result.events[0].rows[0], dated)
  for (const [index, entry] of result.undated.entries()) assert.strictEqual(entry, undated[index])
  assert.deepEqual(buildCharacterReleaseTimeline(undated), { events: [], undated })
})

test('予定日が過去でも予定のまま保持し、現在時刻から実装済みを推測しない', () => {
  const scheduled = row('scheduled', { status: 'scheduled', releaseDate: '2000-01-01', kind: 'additional' })
  const result = buildCharacterReleaseTimeline([scheduled])
  assert.equal(result.events[0].status, 'scheduled')
  assert.strictEqual(result.events[0].rows[0], scheduled)
  assert.equal(scheduled.status, 'scheduled')
})

test('UTC日番号はエポックとその前日で正しく、閏日や年境界の間隔を保つ', () => {
  const dates = ['1970-01-01', '1969-12-31', '2024-03-01', '2024-02-29', '2024-02-28', '2023-12-31', '2024-01-01']
  const result = buildCharacterReleaseTimeline(dates.map((releaseDate, index) => row(`date-${index}`, { releaseDate })))
  const days = new Map(result.events.map((event) => [event.date, event.day]))
  assert.equal(days.get('1970-01-01'), 0)
  assert.equal(days.get('1969-12-31'), -1)
  assert.equal(days.get('2024-02-29')! - days.get('2024-02-28')!, 1)
  assert.equal(days.get('2024-03-01')! - days.get('2024-02-29')!, 1)
  assert.equal(days.get('2024-01-01')! - days.get('2023-12-31')!, 1)
  assert.ok(result.events.every((event) => Number.isInteger(event.day)))
  const century = buildCharacterReleaseTimeline(['1900-02-28', '1900-03-01', '2000-02-28', '2000-03-01']
    .map((releaseDate, index) => row(`century-${index}`, { releaseDate }))).events
  assert.equal(century[1].day - century[0].day, 1)
  assert.equal(century[3].day - century[2].day, 2)
})

test('正規化で存在しない日付を別日に繰り上げず、時刻付き文字列も拒否する', () => {
  for (const releaseDate of ['2023-02-29', '1900-02-29', '2024-04-31', '2024-13-01', '2024-2-29', '2024-02-29T00:00:00Z', '']) {
    assert.throws(() => buildCharacterReleaseTimeline([row('invalid', { releaseDate })]), /実装日/)
  }
})
