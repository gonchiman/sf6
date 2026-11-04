import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { SteamPlayerCountAppId, SteamPlayerCountDateRange, SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'
import { getSteamPlayerCountJstDate } from './steamPlayerCount.ts'
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

test('presets keep calendar dates while the comparison starts at the latest collection start', async () => {
  const data = fixture()
  data.values.set(ids[0], value(ids[0], ['2026-10-31T00:00:00.000Z', '2026-11-03T00:00:00.000Z']))
  data.values.set(ids[1], value(ids[1], ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z']))
  const controller = createSteamPlayerCountComparisonController(ids, () => {}, '7d', { createFeed: data.createFeed, now: clock })
  await controller.refresh()
  assert.deepEqual(controller.getState().range, { from: '2026-10-29', to: '2026-11-04' })
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
  assert.equal(controller.getState().now, old.now)
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
