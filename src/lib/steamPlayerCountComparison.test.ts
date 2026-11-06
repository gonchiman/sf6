import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSteamPlayerCountGameComparison } from './steamPlayerCountComparison.ts'
import { resolveSteamPlayerCountRange, resolveSteamPlayerCountTimeWindow } from './steamPlayerCount.ts'
import { STEAM_PLAYER_COUNT_GAMES } from './steamPlayerCountGames.ts'
import type { SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'

const range = { from: '2026-11-02', to: '2026-11-03' }
const now = new Date('2026-11-03T15:00:00.000Z')
const [sf6, tekken] = STEAM_PLAYER_COUNT_GAMES
function observation(time: string, playerCount: number, id = time): SteamPlayerCountObservation {
  return { id, observedAt: time, requestStartedAt: time, playerCount, runId: null, runAttempt: null }
}
function hour(date: string, utcHour: number, values: number | readonly number[], offsetSeconds = 0): SteamPlayerCountObservation[] {
  return [0, 15, 30, 45].map((minute, quarter) => observation(
    new Date(Date.parse(`${date}T${String(utcHour).padStart(2, '0')}:00:00.000Z`) + minute * 60_000 + offsetSeconds * 1000).toISOString(),
    typeof values === 'number' ? values : values[quarter]))
}

test('one missing quarter excludes that date/hour for every game while retaining shared coverage', () => {
  const first = [...hour('2026-11-02', 0, 100), ...hour('2026-11-03', 0, 900)]
  const second = [...hour('2026-11-02', 0, 200, 4), ...hour('2026-11-03', 0, 800, 4).slice(0, 3)]
  const result = buildSteamPlayerCountGameComparison([{ game: sf6, observations: first }, { game: tekken, observations: second }], range, 'all', now)
  assert.deepEqual(result.hourly[9], { hour: 9, mean: null, validDays: 1, totalDays: 2, observedSlots: 7, expectedSlots: 8 })
  assert.deepEqual(result.series.map(series => [series.hourly[9].mean, series.periodMean, series.peak]), [[100, 100, 100], [200, 200, 200]])
  assert.equal(result.commonDays, 1)
  assert.equal(result.commonHours, 1)
  assert.equal(result.commonSlots, 4)
  assert.equal(result.expectedSlots, 192)
})

test('period means weight dates equally despite different numbers of complete hours', () => {
  const observations = [...hour('2026-11-02', 0, 100), ...hour('2026-11-02', 1, 300), ...hour('2026-11-03', 0, [800, 1000, 1200, 1000])]
  const result = buildSteamPlayerCountGameComparison([
    { game: sf6, observations },
    { game: tekken, observations: observations.map(item => ({ ...item, playerCount: item.playerCount * 2 })) },
  ], range, 'all', now)
  assert.equal(result.series[0].periodMean, 600) // Day means 200 and 1000, rather than a 466.67 pooled mean.
  assert.equal(result.series[0].peak, 1200)
  assert.equal(result.series[0].hourly[9].mean, 550)
  assert.equal(result.series[0].hourly[10].mean, 300)
  assert.equal(result.series[1].periodMean, 1200)
  assert.equal(result.series[1].peak, 2400)
  assert.equal(result.commonDays, 2)
  assert.equal(result.commonHours, 3)
  assert.equal(result.commonSlots, 12)
})

test('actual zero remains zero and empty or nonoverlapping observations remain unavailable', () => {
  const zero = buildSteamPlayerCountGameComparison([{ game: sf6, observations: hour('2026-11-02', 0, 0) }], range, 'all', now)
  assert.equal(zero.series[0].periodMean, 0)
  assert.equal(zero.series[0].peak, 0)
  assert.equal(zero.series[0].hourly[9].mean, 0)
  assert.equal(zero.series[0].hourly[10].mean, null)
  for (const observations of [[], hour('2026-11-03', 0, 900)]) {
    const result = buildSteamPlayerCountGameComparison([{ game: sf6, observations: hour('2026-11-02', 0, 100) }, { game: tekken, observations }], range, 'all', now)
    assert.ok(result.series.every(item => item.periodMean === null && item.peak === null && item.hourly.every(row => row.mean === null)))
    assert.equal(result.commonHours, 0)
    assert.equal(result.commonSlots, 0)
  }
  const absentRange = buildSteamPlayerCountGameComparison([{ game: sf6, observations: [] }], null, 'all', now)
  assert.equal(absentRange.totalDays, 0)
  assert.equal(absentRange.expectedSlots, 0)
  assert.equal(buildSteamPlayerCountGameComparison([], range, 'all', now).expectedSlots, 0)
})

test('common observations use actual JST slots, weekday filters, and each game\'s earliest observation', () => {
  // Friday UTC 15:00 is Saturday JST 00:00; each game's API response time differs within a slot.
  const saturday = hour('2026-10-30', 15, 100)
  const monday = hour('2026-11-01', 15, 300)
  const retry = observation('2026-11-01T15:05:00.000Z', 10000, 'retry')
  const tie = { ...monday[0], id: 'z', playerCount: 20000 }
  const first = [...saturday, ...monday, retry, tie].reverse()
  const second = [...hour('2026-10-30', 15, 200, 5), ...hour('2026-11-01', 15, 600, 5)]
  const selected = { from: '2026-10-31', to: '2026-11-02' }
  const weekday = buildSteamPlayerCountGameComparison([{ game: sf6, observations: first }, { game: tekken, observations: second }], selected, 'weekday', now)
  assert.equal(weekday.totalDays, 1)
  assert.equal(weekday.series[0].periodMean, 300)
  assert.equal(weekday.series[1].periodMean, 600)
  assert.equal(weekday.series[0].hourly[0].mean, 300)
  const weekend = buildSteamPlayerCountGameComparison([{ game: sf6, observations: first }, { game: tekken, observations: second }], selected, 'weekend', now)
  assert.equal(weekend.totalDays, 2)
  assert.equal(weekend.series[0].periodMean, 100)
  assert.equal(weekend.commonDays, 1)
})

test('future observations and not-yet-observed quarters cannot complete the current hour', () => {
  const clock = new Date('2026-11-01T15:31:00.000Z')
  const result = buildSteamPlayerCountGameComparison([
    { game: sf6, observations: hour('2026-11-01', 15, 100) },
    { game: tekken, observations: hour('2026-11-01', 15, 200, 70) },
  ], range, 'all', clock)
  assert.equal(result.hourly[0].observedSlots, 2)
  assert.equal(result.hourly[0].expectedSlots, 3)
  assert.equal(result.expectedSlots, 3)
  assert.equal(result.totalDays, 1)
  assert.equal(result.commonSlots, 0)
  assert.equal(result.series[0].periodMean, null)
})

test('input order and a common scaling of counts do not alter comparison membership or normalized shape', () => {
  const observations = [...hour('2026-11-02', 0, 100), ...hour('2026-11-02', 1, 300)]
  const inputs = [{ game: sf6, observations }, { game: tekken, observations: observations.map(item => ({ ...item, playerCount: item.playerCount * 10 })) }]
  const result = buildSteamPlayerCountGameComparison(inputs, range, 'all', now)
  const reversed = buildSteamPlayerCountGameComparison([...inputs].reverse().map(input => ({ ...input, observations: [...input.observations].reverse() })), range, 'all', now)
  assert.deepEqual(reversed.hourly, result.hourly)
  assert.deepEqual([...reversed.series].reverse(), result.series)
  for (const item of result.series) {
    assert.deepEqual([9, 10].map(hour => item.hourly[hour].mean! / item.periodMean! * 100), [50, 150])
  }
  assert.throws(() => buildSteamPlayerCountGameComparison([inputs[0], inputs[0]], range, 'all', now), /重複/)
})

test('rolling comparisons exclude outside peaks, keep partial dates separate and preserve equal-day weighting', () => {
  const clock = new Date('2026-11-03T03:20:00.000Z')
  const selected = resolveSteamPlayerCountRange('24h', null, clock), window = resolveSteamPlayerCountTimeWindow('24h', clock)!
  const first = [
    ...hour('2026-11-02', 2, 10000), // Before the 24-hour window.
    ...hour('2026-11-02', 4, 100), ...hour('2026-11-02', 5, 300), ...hour('2026-11-03', 0, 1000),
    ...['20', '30', '45'].map(minute => observation(`2026-11-02T03:${minute}:00.000Z`, 9000)),
    ...['00', '15', '30'].map(minute => observation(`2026-11-03T03:${minute}:00.000Z`, 8000)),
  ]
  const second = first.map(item => ({ ...item, playerCount: item.playerCount * 2 }))
  const result = buildSteamPlayerCountGameComparison([{ game: sf6, observations: first }, { game: tekken, observations: second }], selected, 'all', clock, window)
  assert.equal(result.totalDays, 2)
  assert.equal(result.hourly[0].totalDays, 1)
  assert.equal(result.commonDays, 2)
  assert.equal(result.commonHours, 3)
  assert.equal(result.commonSlots, 12)
  assert.equal(result.expectedSlots, 97)
  assert.deepEqual(result.series.map(series => [series.periodMean, series.peak]), [[600, 1000], [1200, 2000]])
  assert.deepEqual(result.hourly[12], { hour: 12, mean: null, validDays: 0, totalDays: 2, observedSlots: 5, expectedSlots: 5 })
  assert.ok(result.series.every(series => series.hourly[12].mean === null))
})

test('rolling comparisons accept four observed zero quarters before the hour ends and exclude mismatched boundary observations', () => {
  const clock = new Date('2026-11-03T03:50:00.000Z')
  const selected = resolveSteamPlayerCountRange('24h', null, clock), window = resolveSteamPlayerCountTimeWindow('24h', clock)!
  const first = hour('2026-11-03', 3, 0)
  const second = hour('2026-11-03', 3, 0, 60)
  const complete = buildSteamPlayerCountGameComparison([{ game: sf6, observations: first }, { game: tekken, observations: second }], selected, 'all', clock, window)
  assert.deepEqual(complete.series.map(series => [series.hourly[12].mean, series.periodMean, series.peak]), [[0, 0, 0], [0, 0, 0]])
  assert.equal(complete.commonHours, 1)
  const missing = buildSteamPlayerCountGameComparison([{ game: sf6, observations: first }, { game: tekken, observations: second.slice(0, 3) }], selected, 'all', clock, window)
  assert.ok(missing.series.every(series => series.periodMean === null && series.peak === null))
  assert.equal(missing.commonHours, 0)
  const boundary = buildSteamPlayerCountGameComparison([
    { game: sf6, observations: [observation(window.from, 0), observation(window.to, 0)] },
    { game: tekken, observations: [observation(new Date(Date.parse(window.from) - 1).toISOString(), 500), observation(window.to, 0)] },
  ], selected, 'all', clock, window)
  assert.equal(boundary.hourly[12].observedSlots, 1)
  assert.equal(boundary.commonHours, 0)
})
