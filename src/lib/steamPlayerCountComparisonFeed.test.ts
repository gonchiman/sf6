import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { SteamPlayerCountAppId, SteamPlayerCountDateRange, SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'
import { filterSteamPlayerCountObservations, getSteamPlayerCountJstDate, resolveSteamPlayerCountTimeWindow } from './steamPlayerCount.ts'
import { createSteamPlayerCountComparisonController, steamPlayerCountComparisonAppIds, type SteamPlayerCountComparisonState } from './steamPlayerCountComparisonFeed.ts'
import type { SteamPlayerCountFeed, SteamPlayerCountPublication } from './steamPlayerCountFeed.ts'
import { getSteamPlayerCountGame } from './steamPlayerCountGames.ts'

const ids = [1364780, 1778820] as const
const selected = { from: '2026-11-02', to: '2026-11-03' }
const clock = () => new Date('2026-11-04T03:00:00.000Z')

function value(appId: SteamPlayerCountAppId, times = ['2026-11-02T00:00:00.000Z'], count = 100, source: 'history' | 'bundled' = 'history') {
  const observations: SteamPlayerCountObservation[] = times.map(time => ({
    id: `obs-${time.replaceAll(':', '-').replaceAll('.', '-')}`, observedAt: time, requestStartedAt: time, playerCount: count, runId: null, runAttempt: null,
  }))
  const dates = [...new Set(times.map(time => time.slice(0, 10)))].sort()
  const publication: SteamPlayerCountPublication = { source, baseUrl: `https://fixture.example/${appId}/`, manifest: {
    schemaVersion: 1, appId, sourceUrl: getSteamPlayerCountGame(appId).sourceUrl, generatedAt: clock().toISOString(),
    days: dates.map(date => {
      const values = observations.filter(item => item.observedAt.startsWith(date))
      return { date, path: `days/${date}.json`, sha256: createHash('sha256').update(JSON.stringify(values)).digest('hex'),
        observationCount: values.length, firstObservedAt: values[0].observedAt, lastObservedAt: values.at(-1)!.observedAt }
    }),
  } }
  return { publication, observations }
}
function inRange(observations: readonly SteamPlayerCountObservation[], range: SteamPlayerCountDateRange) {
  return observations.filter(item => { const date = getSteamPlayerCountJstDate(item.observedAt); return date >= range.from && date <= range.to })
}
function fixture() {
  const values = new Map(ids.map(id => [id, value(id)])), saved = new Map<SteamPlayerCountPublication, SteamPlayerCountObservation[]>()
  const publicationFailures = new Set<number>(), rangeFailures = new Set<number>()
  const requestedRanges: { appId: SteamPlayerCountAppId; range: SteamPlayerCountDateRange }[] = []
  const createFeed = (appId: SteamPlayerCountAppId): SteamPlayerCountFeed => ({
    loadPublication: async () => {
      if (publicationFailures.has(appId)) throw new Error('publication unavailable')
      const current = values.get(appId as typeof ids[number])!
      saved.set(current.publication, current.observations)
      return current.publication
    },
    loadRange: async (publication, range) => {
      requestedRanges.push({ appId, range })
      if (rangeFailures.has(appId)) throw new Error('shard unavailable')
      return inRange(saved.get(publication)!, range)
    },
  })
  return { values, publicationFailures, rangeFailures, requestedRanges, createFeed }
}

test('selected games are validated, deduplicated and ordered by the registry', () => {
  assert.deepEqual(steamPlayerCountComparisonAppIds([1778820, 1364780, 1778820]), ids)
  assert.throws(() => steamPlayerCountComparisonAppIds([]), /1件以上/)
  assert.throws(() => steamPlayerCountComparisonAppIds([1 as SteamPlayerCountAppId]), /不正/)
})

test('all uses the intersection of observed JST dates, and loads exactly that range for every game', async () => {
  const data = fixture()
  data.values.set(ids[0], value(ids[0], ['2026-11-01T14:45:00.000Z', '2026-11-02T15:00:00.000Z']))
  data.values.set(ids[1], value(ids[1], ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z']))
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, 'all', { createFeed: data.createFeed, now: clock })
  await controller.refresh()
  const state = controller.getState()
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.range, selected)
  assert.deepEqual(state.dataRange, selected)
  assert.deepEqual(state.comparisonRange, selected)
  assert.ok(data.requestedRanges.every(item => JSON.stringify(item.range) === JSON.stringify(selected)))
  assert.equal(state.entries[0].observations.length, 1)
  assert.equal(state.entries[1].observations.length, 2)
  assert.equal(state.now.toISOString(), clock().toISOString())
})

test('rolling presets load every intersecting date while the comparison starts at the latest collection start', async () => {
  const data = fixture()
  data.values.set(ids[0], value(ids[0], ['2026-10-31T00:00:00.000Z', '2026-11-03T00:00:00.000Z']))
  data.values.set(ids[1], value(ids[1], ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z']))
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, '7d', { createFeed: data.createFeed, now: clock })
  await controller.refresh()
  assert.deepEqual(controller.getState().range, { from: '2026-10-28', to: '2026-11-04' })
  assert.deepEqual(controller.getState().dataRange, selected)
  assert.deepEqual(controller.getState().comparisonRange, { from: '2026-11-02', to: '2026-11-04' })
})

test('empty or non-overlapping histories stay explicit and never masquerade as a smaller comparison', async () => {
  for (const times of [[], ['2026-11-03T00:00:00.000Z']]) {
    const data = fixture()
    data.values.set(ids[1], value(ids[1], times))
    const controller = createSteamPlayerCountComparisonController(ids, () => {}, 'all', { createFeed: data.createFeed, now: clock })
    await controller.refresh()
    assert.equal(controller.getState().status, 'ready')
    assert.equal(controller.getState().entries.length, 2)
    assert.equal(controller.getState().dataRange, null)
    assert.equal(controller.getState().comparisonRange, null)
  }
})

test('an initial failure identifies the game and exposes no partial comparison; retry recovers', async () => {
  const data = fixture()
  data.publicationFailures.add(ids[1])
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, selected, { createFeed: data.createFeed, now: clock })
  await controller.refresh()
  assert.equal(controller.getState().status, 'error')
  assert.deepEqual(controller.getState().entries, [])
  assert.deepEqual(controller.getState().failedAppIds, [ids[1]])
  data.publicationFailures.clear()
  await controller.refresh()
  assert.equal(controller.getState().status, 'ready')
  assert.equal(controller.getState().entries.length, 2)
  assert.deepEqual(controller.getState().failedAppIds, [])
})

test('partial refresh failures retain all previously verified game values as one snapshot', async () => {
  const data = fixture()
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, selected, { createFeed: data.createFeed, now: clock })
  await controller.refresh()
  const old = controller.getState()
  data.values.set(ids[0], value(ids[0], ['2026-11-02T00:00:00.000Z', '2026-11-02T00:15:00.000Z']))
  data.rangeFailures.add(ids[1])
  await controller.refresh()
  assert.equal(controller.getState().status, 'ready')
  assert.equal(controller.getState().entries, old.entries)
  assert.equal(controller.getState().now.getTime(), old.now.getTime())
  assert.equal(controller.getState().refreshError, true)
  assert.deepEqual(controller.getState().failedAppIds, [ids[1]])
  data.rangeFailures.clear()
  await controller.refresh()
  assert.equal(controller.getState().entries[0].observations.length, 2)
  assert.equal(controller.getState().refreshError, false)
})

test('an initial shard failure retains the common data dates for narrowing the selection', async () => {
  const data = fixture()
  ids.forEach(id => data.values.set(id, value(id, ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z'])))
  data.rangeFailures.add(ids[1])
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, 'all', { createFeed: data.createFeed, now: clock })
  await controller.refresh()
  assert.equal(controller.getState().status, 'error')
  assert.deepEqual(controller.getState().range, selected)
  assert.deepEqual(controller.getState().dataRange, selected)
  assert.deepEqual(controller.getState().entries, [])
  data.rangeFailures.clear()
  controller.setRange({ from: '2026-11-03', to: '2026-11-03' })
  await controller.refresh()
  assert.equal(controller.getState().status, 'ready')
  assert.ok(controller.getState().entries.every(entry => entry.observations.length === 1))
})

test('an all-period expansion that cannot load fully keeps the previous common period and values', async () => {
  const data = fixture()
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, 'all', { createFeed: data.createFeed, now: clock })
  await controller.refresh()
  const old = controller.getState()
  ids.forEach(id => data.values.set(id, value(id, ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z'])))
  data.rangeFailures.add(ids[1])
  await controller.refresh()
  assert.equal(controller.getState().status, 'ready')
  assert.equal(controller.getState().entries, old.entries)
  assert.deepEqual(controller.getState().range, old.range)
  assert.equal(controller.getState().refreshError, true)
})

test('bundled fallback or a regressed publication cannot mix with newly updated peers', async () => {
  for (const regression of ['bundled', 'empty'] as const) {
    const data = fixture()
    const controller = createSteamPlayerCountComparisonController(ids, () => {}, selected, { createFeed: data.createFeed, now: clock })
    await controller.refresh()
    const old = controller.getState().entries
    data.values.set(ids[0], value(ids[0], ['2026-11-02T00:00:00.000Z', '2026-11-02T00:15:00.000Z']))
    data.values.set(ids[1], regression === 'bundled' ? value(ids[1], undefined, 100, 'bundled') : value(ids[1], []))
    await controller.refresh()
    assert.equal(controller.getState().entries, old)
    assert.equal(controller.getState().refreshError, true)
    assert.deepEqual(controller.getState().failedAppIds, [ids[1]])
  }
})

test('a range change cannot mix a stale title with updated peers or restore the previous range', async () => {
  for (const regression of ['bundled', 'empty'] as const) {
    const data = fixture()
    const times = ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z']
    ids.forEach(id => data.values.set(id, value(id, times)))
    const controller = createSteamPlayerCountComparisonController(ids, () => {}, selected, { createFeed: data.createFeed, now: clock })
    await controller.refresh()
    data.values.set(ids[0], value(ids[0], [...times, '2026-11-03T00:15:00.000Z']))
    data.values.set(ids[1], regression === 'bundled' ? value(ids[1], times, 100, 'bundled') : value(ids[1], []))
    const narrowed = { from: '2026-11-03', to: '2026-11-03' }
    controller.setRange(narrowed)
    await controller.refresh()
    assert.equal(controller.getState().status, 'error')
    assert.deepEqual(controller.getState().range, narrowed)
    assert.deepEqual(controller.getState().entries, [])
    assert.deepEqual(controller.getState().failedAppIds, [ids[1]])

    data.values.set(ids[1], value(ids[1], times))
    await controller.refresh()
    assert.equal(controller.getState().status, 'ready')
    assert.deepEqual(controller.getState().range, narrowed)
    assert.deepEqual(controller.getState().entries.map(entry => entry.observations.length), [2, 1])
    assert.equal(controller.getState().refreshError, false)
  }
})

test('a growing publication is rejected when a previously loaded observation changes', async () => {
  const data = fixture()
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, selected, { createFeed: data.createFeed, now: clock })
  await controller.refresh()
  const old = controller.getState().entries
  data.values.set(ids[0], value(ids[0], ['2026-11-02T00:00:00.000Z', '2026-11-02T00:15:00.000Z'], 999))
  await controller.refresh()
  assert.equal(controller.getState().entries, old)
  assert.deepEqual(controller.getState().failedAppIds, [ids[0]])
})

test('selection changes during a failed range read clear old points and publish only the final dates', async () => {
  const data = fixture()
  ids.forEach(id => data.values.set(id, value(id, ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z'])))
  let release: () => void = () => {}, entered: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const ready: SteamPlayerCountComparisonState[] = []
  let first = true
  const controller = createSteamPlayerCountComparisonController(ids, state => { if (state.status === 'ready') ready.push(state) }, selected, {
    now: clock, createFeed: appId => {
      const base = data.createFeed(appId)
      return { ...base, loadRange: async (publication, range) => {
        if (first) { first = false; entered(); await gate; throw new Error('old selection failed') }
        return base.loadRange(publication, range)
      } }
    },
  })
  const pending = controller.refresh()
  await started
  controller.setRange({ from: '2026-11-03', to: '2026-11-03' })
  assert.deepEqual(controller.getState().entries, [])
  release()
  await pending
  assert.equal(ready.length, 1)
  assert.deepEqual(ready[0].range, { from: '2026-11-03', to: '2026-11-03' })
  assert.ok(ready[0].entries.every(entry => entry.observations.length === 1 && entry.observations[0].observedAt.startsWith('2026-11-03')))
})

test('JST midnight failures do not show yesterday under today', async () => {
  const data = fixture()
  let now = new Date('2026-11-02T14:59:59.999Z')
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, 'today', { createFeed: data.createFeed, now: () => now })
  await controller.refresh()
  now = new Date('2026-11-02T15:00:00.000Z')
  data.publicationFailures.add(ids[0])
  await controller.refresh()
  assert.equal(controller.getState().status, 'error')
  assert.deepEqual(controller.getState().range, { from: '2026-11-03', to: '2026-11-03' })
  assert.deepEqual(controller.getState().entries, [])
})

test('24-hour comparisons share a completion clock and refresh within the same dates without repeated reads', async () => {
  const data = fixture()
  let now = new Date('2026-11-03T03:00:00.000Z'), reads = 0
  const times = ['2026-11-02T00:00:00.000Z', '2026-11-02T03:00:00.000Z', '2026-11-03T00:00:00.000Z']
  ids.forEach(id => data.values.set(id, value(id, times)))
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, undefined, {
    now: () => now, createFeed: appId => {
      const base = data.createFeed(appId)
      return { ...base, loadRange: async (publication, range) => {
        reads++
        assert.ok(reads <= 4, 'clock movement within a date must not restart the batch')
        now = new Date(now.getTime() + 100)
        return base.loadRange(publication, range)
      } }
    },
  })
  await controller.refresh()
  assert.equal(controller.getSelection(), '24h')
  assert.equal(reads, 2)
  assert.equal(controller.getState().now.toISOString(), '2026-11-03T03:00:00.200Z')
  assert.ok(controller.getState().entries.every(entry => entry.observations.length === 3))
  now = new Date('2026-11-03T03:05:00.000Z')
  const pending = controller.refresh()
  assert.equal(controller.getState().now.toISOString(), '2026-11-03T03:05:00.000Z')
  await pending
  assert.equal(reads, 4)
  assert.equal(controller.getState().status, 'ready')
  assert.equal(controller.getState().now.toISOString(), '2026-11-03T03:05:00.200Z')
})

test('7-day and 30-day comparisons use one moving time window for every selected game', async () => {
  for (const [selection, days] of [['7d', 7], ['30d', 30]] as const) {
    const data = fixture()
    let now = new Date('2026-11-06T03:10:00.000Z')
    const start = now.getTime() - days * 24 * 60 * 60 * 1000
    const times = [start - 1, start, start + 5 * 60 * 1000, now.getTime()].map(time => new Date(time).toISOString())
    ids.forEach(id => data.values.set(id, value(id, times)))
    const controller = createSteamPlayerCountComparisonController(ids, () => {}, selection, { createFeed: data.createFeed, now: () => now })
    await controller.refresh()
    const first = controller.getState()
    const expectedRange = { from: days === 7 ? '2026-10-30' : '2026-10-07', to: '2026-11-06' }
    assert.deepEqual(first.range, expectedRange)
    assert.ok(data.requestedRanges.every(item => JSON.stringify(item.range) === JSON.stringify(expectedRange)))
    const displayedTimes = () => {
      const state = controller.getState(), window = resolveSteamPlayerCountTimeWindow(controller.getSelection(), state.now)
      return state.entries.map(entry => filterSteamPlayerCountObservations(entry.observations, state.range, 'all', window).map(item => item.observedAt))
    }
    assert.deepEqual(displayedTimes(), ids.map(() => times.slice(1)))
    now = new Date(now.getTime() + 5 * 60 * 1000)
    await controller.refresh()
    assert.deepEqual(controller.getState().range, expectedRange)
    assert.equal(controller.getState().now.getTime(), now.getTime())
    assert.deepEqual(displayedTimes(), ids.map(() => times.slice(2)))
  }
})

test('24-hour comparison failures move the clock without mixing titles and discard obsolete midnight bounds', async () => {
  for (const failure of ['publication', 'range']) {
    const data = fixture()
    let now = new Date('2026-11-02T14:50:00.000Z')
    const controller = createSteamPlayerCountComparisonController(ids, () => {}, '24h', { createFeed: data.createFeed, now: () => now })
    await controller.refresh()
    const verified = controller.getState().entries
    now = new Date('2026-11-02T14:55:00.000Z')
    if (failure === 'publication') data.publicationFailures.add(ids[0])
    else data.rangeFailures.add(ids[0])
    await controller.refresh()
    assert.equal(controller.getState().status, 'ready')
    assert.equal(controller.getState().entries, verified)
    assert.equal(controller.getState().refreshError, true)
    assert.equal(controller.getState().now.getTime(), now.getTime())
    now = new Date('2026-11-02T15:00:00.000Z')
    await controller.refresh()
    assert.equal(controller.getState().status, 'error')
    assert.deepEqual(controller.getState().entries, [])
    assert.deepEqual(controller.getState().range, { from: '2026-11-02', to: '2026-11-03' })
    assert.equal(controller.getState().now.getTime(), now.getTime())
  }
})

test('a 24-hour comparison crossing midnight retries dates once and publishes only matching clock and values', async () => {
  const data = fixture()
  let now = new Date('2026-11-02T14:59:59.900Z'), reads = 0
  const ready: SteamPlayerCountComparisonState[] = []
  ids.forEach(id => data.values.set(id, value(id, ['2026-11-02T00:00:00.000Z', '2026-11-02T15:00:00.000Z'])))
  const controller = createSteamPlayerCountComparisonController(ids, state => { if (state.status === 'ready') ready.push(state) }, '24h', {
    now: () => now, createFeed: appId => {
      const base = data.createFeed(appId)
      return { ...base, loadRange: async (publication, range) => {
        reads++
        assert.ok(reads <= 4)
        now = new Date(now.getTime() + 100)
        return base.loadRange(publication, range)
      } }
    },
  })
  await controller.refresh()
  assert.equal(reads, 4)
  assert.equal(ready.length, 1)
  assert.deepEqual(ready[0].range, { from: '2026-11-02', to: '2026-11-03' })
  assert.equal(ready[0].now.getTime(), now.getTime())
  assert.ok(ready[0].entries.every(entry => entry.observations.length === 2))
})

test('disposing while a request is pending suppresses every late result', async () => {
  const data = fixture()
  let release: () => void = () => {}, updates = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const controller = createSteamPlayerCountComparisonController(ids, () => { updates++ }, selected, { now: clock,
    createFeed: appId => { const base = data.createFeed(appId); return { ...base, loadPublication: async () => { await gate; return base.loadPublication() } } },
  })
  const pending = controller.refresh()
  controller.dispose()
  const before = updates
  release()
  await pending
  assert.equal(updates, before)
})
