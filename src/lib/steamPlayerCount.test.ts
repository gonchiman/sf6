import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSteamPlayerCountHourlyComparison, filterSteamPlayerCountObservations, getDefaultSteamPlayerCountRange,
  getSteamPlayerCountJstDate, getSteamPlayerCountUtcDates, parseSteamPlayerCountDateRange, parseSteamPlayerCountDay,
  parseSteamPlayerCountDayDescriptor, parseSteamPlayerCountManifest, parseSteamPlayerCountObservation,
  getSteamPlayerCountComparisonRange, getSteamPlayerCountEligibleDates, resolveSteamPlayerCountRange, resolveSteamPlayerCountTimeWindow,
  STEAM_PLAYER_COUNT_APP_ID, STEAM_PLAYER_COUNT_SOURCE_URL } from './steamPlayerCount.ts'
import type { SteamPlayerCountAppId, SteamPlayerCountDay, SteamPlayerCountDayDescriptor, SteamPlayerCountManifest, SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'
import { DEFAULT_STEAM_PLAYER_COUNT_GAME, getSteamPlayerCountGame, STEAM_PLAYER_COUNT_GAMES } from './steamPlayerCountGames.ts'

function observation(time: string, playerCount = 100, id = `obs-${time.replace(/[:.]/g, '-')}`): SteamPlayerCountObservation {
  return { id, requestStartedAt: time, observedAt: time, playerCount, runId: null, runAttempt: null }
}
function descriptor(date: string, first = `${date}T00:00:00.000Z`, last = first): SteamPlayerCountDayDescriptor {
  return { date, path: `days/${date}.json`, sha256: 'a'.repeat(64), observationCount: first === last ? 1 : 2, firstObservedAt: first, lastObservedAt: last }
}
function manifest(days: SteamPlayerCountDayDescriptor[] = []): SteamPlayerCountManifest {
  return { schemaVersion: 1, appId: STEAM_PLAYER_COUNT_APP_ID, sourceUrl: STEAM_PLAYER_COUNT_SOURCE_URL, generatedAt: '2026-11-01T03:00:00.000Z', days }
}
function hour(date: string, value: number): SteamPlayerCountObservation[] {
  return ['00', '15', '30', '45'].map(minute => observation(`${date}T00:${minute}:00.000Z`, value))
}

test('game registry preserves SF6 paths and assigns independent sources and directories to all five titles', () => {
  assert.deepEqual(STEAM_PLAYER_COUNT_GAMES.map(game => [game.key, game.appId]), [
    ['sf6', 1364780], ['tekken-8', 1778820], ['ggst', 1384160], ['gbvsr', 2157560], ['kof-xv', 1498570],
  ])
  assert.equal(DEFAULT_STEAM_PLAYER_COUNT_GAME.appId, STEAM_PLAYER_COUNT_APP_ID)
  assert.equal(DEFAULT_STEAM_PLAYER_COUNT_GAME.sourceUrl, STEAM_PLAYER_COUNT_SOURCE_URL)
  assert.equal(DEFAULT_STEAM_PLAYER_COUNT_GAME.historyPath, 'public')
  assert.equal(DEFAULT_STEAM_PLAYER_COUNT_GAME.bundledPath, 'data/steam-player-count')
  for (const field of ['sourceUrl', 'historyPath', 'bundledPath'] as const) {
    assert.equal(new Set(STEAM_PLAYER_COUNT_GAMES.map(game => game[field])).size, 5)
  }
  for (const game of STEAM_PLAYER_COUNT_GAMES) {
    assert.equal(getSteamPlayerCountGame(game.appId), game)
    assert.equal(new URL(game.sourceUrl).searchParams.get('appid'), String(game.appId))
    assert.ok(Object.isFrozen(game))
    if (game.key !== 'sf6') {
      assert.equal(game.historyPath, `games/${game.key}`)
      assert.equal(game.bundledPath, `data/steam-player-count-games/${game.key}`)
    }
  }
  assert.ok(Object.isFrozen(STEAM_PLAYER_COUNT_GAMES))
  for (const invalid of [0, 1364781, NaN, Infinity]) assert.throws(() => getSteamPlayerCountGame(invalid), /対象ゲーム/)
})

test('day and manifest parsers bind every game to the requested app ID and source while legacy calls remain SF6-only', () => {
  const observations = hour('2026-10-31', 100)
  for (const game of STEAM_PLAYER_COUNT_GAMES) {
    const value: SteamPlayerCountDay = { schemaVersion: 1, appId: game.appId, date: '2026-10-31', observations }
    const expected = { ...descriptor(value.date, observations[0].observedAt, observations.at(-1)!.observedAt), observationCount: 4 }
    const index = { ...manifest([expected]), appId: game.appId, sourceUrl: game.sourceUrl }
    assert.deepEqual(parseSteamPlayerCountDay(value, expected, game.appId), value)
    assert.deepEqual(parseSteamPlayerCountManifest(index, game.appId), index)
    if (game.appId === STEAM_PLAYER_COUNT_APP_ID) {
      assert.deepEqual(parseSteamPlayerCountDay(value, expected), value)
      assert.deepEqual(parseSteamPlayerCountManifest(index), index)
    } else {
      assert.throws(() => parseSteamPlayerCountDay(value, expected), /appId/)
      assert.throws(() => parseSteamPlayerCountManifest(index), /appId/)
    }
    for (const other of STEAM_PLAYER_COUNT_GAMES.filter(item => item.appId !== game.appId)) {
      assert.throws(() => parseSteamPlayerCountDay(value, expected, other.appId), /appId/)
      assert.throws(() => parseSteamPlayerCountManifest(index, other.appId), /appId/)
      assert.throws(() => parseSteamPlayerCountManifest({ ...index, sourceUrl: other.sourceUrl }, game.appId), /sourceUrl/)
    }
  }
  assert.throws(() => parseSteamPlayerCountManifest(manifest(), 999 as SteamPlayerCountAppId), /対象ゲーム/)
})

test('strict observations distinguish a true zero from missing data and reject malformed provenance', () => {
  const valid = observation('2026-10-31T00:00:00.000Z', 0)
  assert.equal(parseSteamPlayerCountObservation(valid).playerCount, 0)
  assert.equal(parseSteamPlayerCountObservation({ ...valid, runId: '1234567', runAttempt: 2 }).runAttempt, 2)
  for (const invalid of [
    { ...valid, playerCount: null }, { ...valid, playerCount: -1 }, { ...valid, playerCount: 1.5 },
    { ...valid, playerCount: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, playerCount: Infinity },
    { ...valid, runId: '1' }, { ...valid, runId: '0', runAttempt: 1 }, { ...valid, runId: '1', runAttempt: 0 },
    { ...valid, observedAt: '2026-02-30T00:00:00.000Z' }, { ...valid, observedAt: '2026-10-31T00:00:00+09:00' },
    { ...valid, requestStartedAt: '2026-10-31T00:01:00.000Z' }, { ...valid, apiKey: 'must-not-publish' },
    { ...valid, id: '../unsafe' }, { ...valid, runAttempt: undefined },
  ]) assert.throws(() => parseSteamPlayerCountObservation(invalid), /形式/)
})

test('UTC days require ordered unique successful observations and exact descriptor metadata', () => {
  const observations = hour('2026-10-31', 100)
  const day: SteamPlayerCountDay = { schemaVersion: 1, appId: STEAM_PLAYER_COUNT_APP_ID, date: '2026-10-31', observations }
  const expected = { ...descriptor(day.date, observations[0].observedAt, observations.at(-1)!.observedAt), observationCount: 4 }
  assert.deepEqual(parseSteamPlayerCountDay(day, expected), day)
  for (const invalid of [
    { ...day, observations: [] }, { ...day, observations: [...observations, observations[0]] },
    { ...day, observations: [...observations].reverse() }, { ...day, date: '2026-10-30' },
    { ...day, appId: 1 }, { ...day, schemaVersion: 2 }, { ...day, secret: 'private' },
  ]) assert.throws(() => parseSteamPlayerCountDay(invalid), /形式/)
  assert.throws(() => parseSteamPlayerCountDay(day, { ...expected, observationCount: 3 }), /mismatch/)
  assert.throws(() => parseSteamPlayerCountDay(day, { ...expected, firstObservedAt: observations[1].observedAt }), /mismatch/)
})

test('manifest validates dates, exact source, safe paths, hashes, duplicates, and publication time', () => {
  assert.deepEqual(parseSteamPlayerCountManifest(manifest()), manifest())
  const item = descriptor('2026-10-31'), valid = manifest([item])
  assert.deepEqual(parseSteamPlayerCountManifest(valid), valid)
  for (const invalid of [
    { ...valid, sourceUrl: 'https://other.example/' }, { ...valid, days: [item, item] },
    { ...valid, generatedAt: '2026-10-30T00:00:00.000Z' }, { ...valid, source: {} },
  ]) assert.throws(() => parseSteamPlayerCountManifest(invalid), /形式/)
  for (const invalid of [
    { ...item, date: '2026-02-30' }, { ...item, path: '../2026-10-31.json' },
    { ...item, path: 'https://other.example/2026-10-31.json' }, { ...item, sha256: 'A'.repeat(64) },
    { ...item, observationCount: 0 }, { ...item, lastObservedAt: '2026-11-01T00:00:00.000Z' },
  ]) assert.throws(() => parseSteamPlayerCountDayDescriptor(invalid), /形式/)
  assert.throws(() => parseSteamPlayerCountDateRange({ from: '2026-10-31', to: '2026-10-30' }), /reversed/)
})

test('JST date boundaries, leap days, and UTC files are independent of the browser timezone', () => {
  assert.equal(getSteamPlayerCountJstDate('2026-10-30T14:59:59.999Z'), '2026-10-30')
  assert.equal(getSteamPlayerCountJstDate('2026-10-30T15:00:00.000Z'), '2026-10-31')
  assert.equal(getSteamPlayerCountJstDate('2024-02-29T15:00:00.000Z'), '2024-03-01')
  assert.deepEqual(getSteamPlayerCountUtcDates({ from: '2026-11-01', to: '2026-11-02' }), ['2026-10-31', '2026-11-01', '2026-11-02'])
  assert.throws(() => getSteamPlayerCountJstDate('2026-02-29T00:00:00.000Z'), /形式/)
})

test('deduplicate by the earliest actual observation, never by request start or scheduled time', () => {
  const range = { from: '2026-10-31', to: '2026-10-31' }
  const first = { ...observation('2026-10-30T15:00:01.000Z', 100, 'a'), requestStartedAt: '2026-10-30T14:59:58.000Z' }
  const retry = observation('2026-10-30T15:10:00.000Z', 500, 'retry')
  const tie = { ...first, id: 'z', playerCount: 800 }
  const next = observation('2026-10-30T15:15:00.000Z', 200)
  assert.deepEqual(filterSteamPlayerCountObservations([retry, next, tie, first], range), [first, next])
})

test('weekday filters use the JST calendar and retain actual zero counts', () => {
  const friday = observation('2026-10-30T14:59:00.000Z', 0), saturday = observation('2026-10-30T15:00:00.000Z')
  const sunday = observation('2026-11-01T00:00:00.000Z'), monday = observation('2026-11-01T15:00:00.000Z')
  const range = { from: '2026-10-30', to: '2026-11-02' }, values = [monday, sunday, saturday, friday]
  assert.deepEqual(filterSteamPlayerCountObservations(values, range, 'weekday'), [friday, monday])
  assert.deepEqual(filterSteamPlayerCountObservations(values, range, 'weekend'), [saturday, sunday])
})

test('hourly means weight complete dates equally, ignore extra retries and exclude incomplete dates', () => {
  const observations = [...hour('2026-10-28', 100), ...hour('2026-10-29', 300), ...hour('2026-10-30', 900).slice(0, 3),
    ...['01', '02', '03', '04', '05'].map(minute => observation(`2026-10-29T00:${minute}:00.000Z`, 10000))]
  const rows = buildSteamPlayerCountHourlyComparison(observations, { from: '2026-10-28', to: '2026-10-30' }, 'all', new Date('2026-10-31T00:00:00.000Z'))
  assert.equal(rows.length, 24)
  assert.deepEqual(rows[9], { hour: 9, mean: 200, validDays: 2, totalDays: 3, observedSlots: 11, expectedSlots: 12 })
  assert.equal(rows[8].mean, null)
  assert.equal(rows[8].observedSlots, 0)
  const zeros = buildSteamPlayerCountHourlyComparison(hour('2026-10-30', 0), { from: '2026-10-30', to: '2026-10-30' }, 'all', new Date('2026-10-31T00:00:00.000Z'))
  assert.equal(zeros[9].mean, 0)
})

test('current-day coverage excludes future slots, while incomplete hours remain null', () => {
  const range = { from: '2026-10-31', to: '2026-11-01' }, now = new Date('2026-10-30T15:20:00.000Z')
  const rows = buildSteamPlayerCountHourlyComparison([
    observation('2026-10-30T15:01:00.000Z'), observation('2026-10-30T15:16:00.000Z'), observation('2026-10-30T15:31:00.000Z'),
  ], range, 'weekend', now)
  assert.deepEqual(rows[0], { hour: 0, mean: null, validDays: 0, totalDays: 1, observedSlots: 2, expectedSlots: 2 })
  assert.equal(rows[1].expectedSlots, 0)
})

test('preset date coverage is identical regardless of available game history', () => {
  const now = new Date('2026-11-01T03:00:00.000Z')
  for (const index of [null, manifest(), manifest([descriptor('2026-10-01')]),
    manifest([descriptor('2026-10-31', '2026-10-31T15:10:00.000Z')])]) {
    assert.deepEqual(resolveSteamPlayerCountRange('today', index, now), { from: '2026-11-01', to: '2026-11-01' })
    assert.deepEqual(resolveSteamPlayerCountRange('yesterday', index, now), { from: '2026-10-31', to: '2026-10-31' })
    assert.deepEqual(resolveSteamPlayerCountRange('7d', index, now), { from: '2026-10-25', to: '2026-11-01' })
    assert.deepEqual(resolveSteamPlayerCountRange('30d', index, now), { from: '2026-10-02', to: '2026-11-01' })
    assert.deepEqual(resolveSteamPlayerCountRange('24h', index, now), { from: '2026-10-31', to: '2026-11-01' })
    assert.deepEqual(getDefaultSteamPlayerCountRange(index, now), resolveSteamPlayerCountRange('24h', index, now))
    assert.deepEqual(resolveSteamPlayerCountRange(null, index, now), resolveSteamPlayerCountRange('24h', index, now))
  }
})

test('relative periods roll over precisely at JST midnight across month and leap-year boundaries', () => {
  assert.deepEqual(resolveSteamPlayerCountRange('today', null, new Date('2024-02-29T14:59:59.999Z')), { from: '2024-02-29', to: '2024-02-29' })
  const midnight = new Date('2024-02-29T15:00:00.000Z')
  assert.deepEqual(resolveSteamPlayerCountRange('today', null, midnight), { from: '2024-03-01', to: '2024-03-01' })
  assert.deepEqual(resolveSteamPlayerCountRange('yesterday', null, midnight), { from: '2024-02-29', to: '2024-02-29' })
  assert.deepEqual(resolveSteamPlayerCountRange('7d', null, midnight), { from: '2024-02-23', to: '2024-03-01' })
  assert.deepEqual(resolveSteamPlayerCountRange('30d', null, midnight), { from: '2024-01-31', to: '2024-03-01' })
})

test('all follows observed JST bounds and custom ranges stay fixed without manifest clamping', () => {
  const now = new Date('2026-11-02T03:00:00.000Z')
  const index = manifest([descriptor('2026-10-31', '2026-10-31T15:00:00.000Z'), descriptor('2026-10-01', '2026-10-01T15:00:00.000Z')])
  assert.deepEqual(resolveSteamPlayerCountRange('all', index, now), { from: '2026-10-02', to: '2026-11-01' })
  assert.deepEqual(resolveSteamPlayerCountRange('all', manifest(), now), { from: '2026-11-02', to: '2026-11-02' })
  const custom = { from: '2026-09-01', to: '2026-11-03' }
  assert.deepEqual(resolveSteamPlayerCountRange(custom, index, now), custom)
  assert.throws(() => resolveSteamPlayerCountRange({ from: '2026-11-03', to: '2026-09-01' }), /reversed/)
})

test('the default rolling window is exactly 24 hours across JST midnight, leap days and years', () => {
  for (const [end, start, fromDate, toDate] of [
    ['2024-02-29T15:00:00.000Z', '2024-02-28T15:00:00.000Z', '2024-02-29', '2024-03-01'],
    ['2026-12-31T15:12:34.567Z', '2026-12-30T15:12:34.567Z', '2026-12-31', '2027-01-01'],
  ]) {
    const now = new Date(end)
    const expected = { from: start, to: end }
    assert.deepEqual(resolveSteamPlayerCountTimeWindow('24h', now), expected)
    assert.deepEqual(resolveSteamPlayerCountTimeWindow(null, now), expected)
    assert.equal(Date.parse(end) - Date.parse(start), 24 * 60 * 60 * 1000)
    assert.deepEqual(resolveSteamPlayerCountRange('24h', null, now), { from: fromDate, to: toDate })
  }
  for (const period of ['today', 'yesterday', 'all'] as const) {
    assert.equal(resolveSteamPlayerCountTimeWindow(period, new Date('2026-11-03T03:00:00.000Z')), null)
  }
  assert.equal(resolveSteamPlayerCountTimeWindow({ from: '2026-11-02', to: '2026-11-03' }), null)
  assert.throws(() => resolveSteamPlayerCountTimeWindow('24h', new Date('invalid')), /timestamp/)
})

test('seven and thirty day windows preserve the time of day across a leap-month boundary', () => {
  const now = new Date('2024-03-01T03:12:34.567Z')
  for (const [period, days, from] of [
    ['7d', 7, '2024-02-23T03:12:34.567Z'],
    ['30d', 30, '2024-01-31T03:12:34.567Z'],
  ] as const) {
    const window = resolveSteamPlayerCountTimeWindow(period, now)!
    assert.deepEqual(window, { from, to: '2024-03-01T03:12:34.567Z' })
    assert.equal(Date.parse(window.to) - Date.parse(window.from), days * 24 * 60 * 60 * 1000)
    assert.deepEqual(resolveSteamPlayerCountRange(period, null, now), { from: from.slice(0, 10), to: '2024-03-01' })
    assert.throws(() => resolveSteamPlayerCountTimeWindow(period, new Date('invalid')), /timestamp/)
  }
})

test('longer rolling windows clip boundary observations and coverage instead of counting whole boundary dates', () => {
  const now = new Date('2026-11-03T03:20:00.000Z')
  for (const [period, days] of [['7d', 7], ['30d', 30]] as const) {
    const window = resolveSteamPlayerCountTimeWindow(period, now)!
    const range = resolveSteamPlayerCountRange(period, null, now)
    const first = observation(window.from, 0), last = observation(window.to, 200)
    const values = [
      observation(new Date(Date.parse(window.from) - 1).toISOString(), 10000), first, last,
      observation(new Date(Date.parse(window.to) + 1).toISOString(), 10000),
    ]
    assert.deepEqual(filterSteamPlayerCountObservations(values, range, 'all', window), [first, last])
    const rows = buildSteamPlayerCountHourlyComparison(values, range, 'all', now, window)
    assert.equal(rows.reduce((sum, row) => sum + row.expectedSlots, 0), 96 * days + 1)
    assert.equal(rows[12].expectedSlots, 4 * days + 1)
    assert.equal(rows[12].totalDays, days + 1)
    assert.equal(rows[13].expectedSlots, 4 * days)
    assert.equal(rows[13].totalDays, days)
    assert.equal(getSteamPlayerCountEligibleDates(range, 'all', now, window).length, days + 1)
  }
})

test('the rolling observation window includes exact endpoints and excludes surrounding values before slot deduplication', () => {
  const now = new Date('2026-11-03T03:20:00.000Z')
  const range = resolveSteamPlayerCountRange('24h', null, now), window = resolveSteamPlayerCountTimeWindow('24h', now)!
  const first = observation(window.from, 0), last = observation(window.to, 200)
  const values = [
    observation('2026-11-02T03:19:59.999Z', 10000), first,
    observation('2026-11-02T03:20:00.001Z', 10000), last,
    observation('2026-11-03T03:20:00.001Z', 10000),
  ]
  assert.deepEqual(filterSteamPlayerCountObservations(values, range, 'all', window), [first, last])
  assert.throws(() => filterSteamPlayerCountObservations(values, range, 'all', { from: window.to, to: window.from }), /reversed/)
})

test('partial hours retain intersecting quarter coverage without combining two dates into a complete hour', () => {
  const now = new Date('2026-11-03T03:20:00.000Z')
  const range = resolveSteamPlayerCountRange('24h', null, now), window = resolveSteamPlayerCountTimeWindow('24h', now)!
  const values = [
    observation('2026-11-02T03:19:59.999Z', 10000),
    ...['20', '30', '45'].map(minute => observation(`2026-11-02T03:${minute}:00.000Z`, 100)),
    ...['00', '15', '30'].map(minute => observation(`2026-11-03T03:${minute}:00.000Z`, 200)),
    ...['00', '15', '30', '45'].map(minute => observation(`2026-11-02T04:${minute}:00.000Z`, 0)),
  ]
  const rows = buildSteamPlayerCountHourlyComparison(values, range, 'all', now, window)
  assert.deepEqual(rows[12], { hour: 12, mean: null, validDays: 0, totalDays: 2, observedSlots: 5, expectedSlots: 5 })
  assert.deepEqual(rows[13], { hour: 13, mean: 0, validDays: 1, totalDays: 1, observedSlots: 4, expectedSlots: 4 })
  assert.deepEqual(rows[11], { hour: 11, mean: null, validDays: 0, totalDays: 1, observedSlots: 0, expectedSlots: 4 })
  assert.equal(rows.reduce((sum, row) => sum + row.expectedSlots, 0), 97)
  assert.deepEqual(getSteamPlayerCountEligibleDates(range, 'all', now, window), ['2026-11-02', '2026-11-03'])
  assert.equal(getSteamPlayerCountEligibleDates(range, 'all', now, { from: '2026-11-03T04:00:00.000Z', to: '2026-11-03T05:00:00.000Z' }).length, 0)
})

test('four actual quarters can complete a current hour before its end while missing quarters stay unavailable', () => {
  const now = new Date('2026-11-03T03:50:00.000Z')
  const range = resolveSteamPlayerCountRange('24h', null, now), window = resolveSteamPlayerCountTimeWindow('24h', now)!
  const values = ['07', '22', '37', '47'].map(minute => observation(`2026-11-03T03:${minute}:00.000Z`, 300))
  const rows = buildSteamPlayerCountHourlyComparison(values, range, 'all', now, window)
  assert.deepEqual(rows[12], { hour: 12, mean: 300, validDays: 1, totalDays: 2, observedSlots: 4, expectedSlots: 5 })
  assert.equal(buildSteamPlayerCountHourlyComparison(values.slice(0, 3), range, 'all', now, window)[12].mean, null)
})

test('rolling coverage counts a quarter ending at the window start as outside and respects JST weekdays', () => {
  const now = new Date('2026-10-31T15:00:00.000Z') // Sunday 00:00 JST.
  const range = resolveSteamPlayerCountRange('24h', null, now), window = resolveSteamPlayerCountTimeWindow('24h', now)!
  const weekend = buildSteamPlayerCountHourlyComparison([], range, 'weekend', now, window)
  assert.equal(weekend[23].expectedSlots, 4)
  assert.equal(weekend[23].totalDays, 1)
  assert.equal(weekend[0].expectedSlots, 5)
  assert.equal(weekend[0].totalDays, 2)
  assert.equal(weekend.reduce((sum, row) => sum + row.expectedSlots, 0), 97)
  assert.ok(buildSteamPlayerCountHourlyComparison([], range, 'weekday', now, window)
    .every(row => row.mean === null && row.totalDays === 0 && row.expectedSlots === 0))
})

test('coverage excludes pre-collection dates without shortening the selected calendar or hiding later missing slots', () => {
  const now = new Date('2026-11-02T03:00:00.000Z'), index = manifest([descriptor('2026-10-31', '2026-10-31T15:00:00.000Z')])
  const selected = { from: '0002-01-01', to: '9999-12-31' }
  const comparison = getSteamPlayerCountComparisonRange(selected, index, now)
  assert.deepEqual(comparison, { from: '2026-11-01', to: '2026-11-02' })
  assert.deepEqual(selected, { from: '0002-01-01', to: '9999-12-31' })
  assert.equal(buildSteamPlayerCountHourlyComparison([], comparison, 'all', now)[0].totalDays, 2)
  for (const empty of [getSteamPlayerCountComparisonRange(selected, manifest(), now),
    getSteamPlayerCountComparisonRange({ from: '2026-10-01', to: '2026-10-31' }, index, now)]) {
    assert.equal(empty, null)
    const rows = buildSteamPlayerCountHourlyComparison([], empty, 'all', now)
    assert.equal(rows.length, 24)
    assert.ok(rows.every(row => row.mean === null && row.totalDays === 0 && row.expectedSlots === 0 && row.observedSlots === 0))
  }
})
