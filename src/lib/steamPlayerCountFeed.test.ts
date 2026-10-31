import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createSteamPlayerCountController, createSteamPlayerCountFeed, shouldAcceptSteamPlayerCountPublication, type SteamPlayerCountPublication } from './steamPlayerCountFeed.ts'
import { STEAM_PLAYER_COUNT_APP_ID, STEAM_PLAYER_COUNT_SOURCE_URL } from './steamPlayerCount.ts'
import type { SteamPlayerCountDay, SteamPlayerCountDayDescriptor, SteamPlayerCountManifest, SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'

const historyBaseUrl = 'https://history.example/public/', localBaseUrl = '/sf6/data/steam-player-count/'
const raw = (value: unknown): string => JSON.stringify(value)
const json = (value: unknown): Response => new Response(raw(value))
const unavailable = (): Response => new Response('', { status: 503 })
function observation(time: string, playerCount = 100): SteamPlayerCountObservation {
  return { id: `obs-${time.replace(/[:.]/g, '-')}`, requestStartedAt: time, observedAt: time, playerCount, runId: null, runAttempt: null }
}
function day(date = '2026-10-31', times = ['00:00', '00:15']): SteamPlayerCountDay {
  return { schemaVersion: 1, appId: STEAM_PLAYER_COUNT_APP_ID, date, observations: times.map(time => observation(`${date}T${time}:00.000Z`)) }
}
function descriptor(day: SteamPlayerCountDay): SteamPlayerCountDayDescriptor {
  return { date: day.date, path: `days/${day.date}.json`, sha256: createHash('sha256').update(raw(day)).digest('hex'),
    observationCount: day.observations.length, firstObservedAt: day.observations[0].observedAt, lastObservedAt: day.observations.at(-1)!.observedAt }
}
function manifest(days = [day()], generatedAt = '2026-11-01T00:00:00.000Z'): SteamPlayerCountManifest {
  return { schemaVersion: 1, appId: STEAM_PLAYER_COUNT_APP_ID, sourceUrl: STEAM_PLAYER_COUNT_SOURCE_URL, generatedAt, days: days.map(descriptor) }
}
function publication(days = [day()], source: 'history' | 'bundled' = 'history', generatedAt?: string): SteamPlayerCountPublication {
  return { manifest: manifest(days, generatedAt), source, baseUrl: source === 'history' ? historyBaseUrl : localBaseUrl }
}
function createFeed(fetchData: typeof fetch, timeoutMs = 500) { return createSteamPlayerCountFeed({ fetch: fetchData, historyBaseUrl, localBaseUrl, timeoutMs }) }

test('history loads deduplicate requests, validate SHA bytes and retain immutable day caches', async () => {
  const value = day(), requests: { url: string; options?: RequestInit }[] = []
  const feed = createFeed(async (input, options) => {
    const url = String(input); requests.push({ url, options })
    return json(url.endsWith('index.json') ? manifest([value]) : value)
  })
  const first = feed.loadPublication(), concurrent = feed.loadPublication()
  assert.equal(first, concurrent)
  const result = await first
  assert.equal(result.source, 'history')
  assert.ok(requests[1].url.endsWith(`?sha256=${descriptor(value).sha256}`))
  assert.equal(requests[0].options?.cache, 'no-store')
  requests.forEach(request => assert.equal(request.options?.credentials, 'omit'))
  assert.deepEqual(await feed.loadRange(result, { from: value.date, to: value.date }), value.observations)
  await feed.loadPublication()
  assert.equal(requests.filter(request => request.url.includes('/days/')).length, 1)
})

test('same-day appends get new hash URLs instead of accepting CDN bytes from the previous version', async () => {
  const original = day(), appended = day('2026-10-31', ['00:00', '00:15', '00:30']), urls: string[] = []
  let current = original
  const feed = createFeed(async input => {
    const url = String(input); urls.push(url)
    return json(url.endsWith('index.json') ? manifest([current]) : current)
  })
  const before = await feed.loadPublication()
  current = appended
  const after = await feed.loadPublication()
  assert.equal((await feed.loadRange(after, { from: current.date, to: current.date })).length, 3)
  assert.notEqual(before.manifest.days[0].sha256, after.manifest.days[0].sha256)
  assert.equal(urls.filter(url => url.includes('/days/')).length, 2)
})

test('invalid latest history falls back as a whole publication and a later retry can recover', async t => {
  for (const failure of ['http', 'json', 'schema', 'hash', 'metadata']) await t.test(failure, async () => {
    const value = day(), empty = manifest([])
    let fails = true
    const feed = createFeed(async input => {
      const url = String(input)
      if (url.startsWith(localBaseUrl)) return json(empty)
      if (!fails) return json(url.endsWith('index.json') ? manifest([value]) : value)
      if (failure === 'http') return unavailable()
      if (failure === 'json') return new Response('{')
      if (failure === 'schema') return json({ ...manifest([value]), privateKey: 'unexpected' })
      if (url.endsWith('index.json')) {
        const result = manifest([value])
        if (failure === 'metadata') result.days[0].observationCount++
        return json(result)
      }
      return failure === 'hash' ? new Response(`${raw(value)}\n`) : json(value)
    })
    assert.equal((await feed.loadPublication()).source, 'bundled')
    fails = false
    assert.equal((await feed.loadPublication()).source, 'history')
  })
})

test('JST selections load every intersecting UTC day and exclude observations outside the selected date', async () => {
  const previous = day('2026-10-30', ['14:59', '15:00', '23:45']), selected = day('2026-10-31', ['00:00', '14:59', '15:00'])
  const values = [previous, selected], requests: string[] = []
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    return json(url.endsWith('index.json') ? manifest(values) : values.find(value => url.includes(value.date)))
  })
  const result = await feed.loadPublication()
  assert.deepEqual((await feed.loadRange(result, { from: '2026-10-31', to: '2026-10-31' })).map(item => item.observedAt), [
    '2026-10-30T15:00:00.000Z', '2026-10-30T23:45:00.000Z', '2026-10-31T00:00:00.000Z', '2026-10-31T14:59:00.000Z',
  ])
  assert.equal(requests.filter(url => url.includes('/days/')).length, 2)
})

test('older day failures retry on the selected source and never borrow bundled records', async () => {
  const older = day('2026-10-30'), latest = day(), requests: string[] = []
  let available = false
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    assert.ok(url.startsWith(historyBaseUrl))
    if (url.endsWith('index.json')) return json(manifest([older, latest]))
    if (url.includes(older.date)) return available ? json(older) : unavailable()
    return json(latest)
  })
  const result = await feed.loadPublication(), range = { from: older.date, to: older.date }
  await assert.rejects(feed.loadRange(result, range), /読み込めません/)
  available = true
  assert.equal((await feed.loadRange(result, range)).length, 2)
  assert.equal(requests.filter(url => url.includes(`/days/${older.date}`)).length, 2)
})

test('unlisted files and changed sources cannot issue requests', async () => {
  const value = day(), requests: string[] = []
  const feed = createFeed(async input => { const url = String(input); requests.push(url); return json(url.endsWith('index.json') ? manifest([value]) : value) })
  const result = await feed.loadPublication(), expected = descriptor(value)
  await assert.rejects(feed.loadDay(result, { ...expected, sha256: 'f'.repeat(64) }), /一覧と一致/)
  await assert.rejects(feed.loadDay(result, descriptor(day('2026-10-30'))), /一覧と一致/)
  await assert.rejects(feed.loadDay({ ...result, baseUrl: 'https://other.example/' }, expected), /取得元が一致/)
  assert.equal(requests.length, 2)
})

test('timeout bounds stalled body reads and resets for recovery', async () => {
  const value = day(), signals: AbortSignal[] = []
  let stalled = true
  const feed = createFeed(async (input, options) => {
    const url = String(input)
    if (url.startsWith(localBaseUrl)) return json(manifest([]))
    if (stalled && !url.endsWith('index.json')) {
      signals.push(options!.signal!)
      return { ok: true, text: () => new Promise<string>(() => {}) } as Response
    }
    return json(url.endsWith('index.json') ? manifest([value]) : value)
  }, 10)
  assert.equal((await feed.loadPublication()).source, 'bundled')
  assert.equal(signals[0].aborted, true)
  stalled = false
  assert.equal((await feed.loadPublication()).source, 'history')
})

test('publication acceptance rejects regressions but allows delayed older observations to append', () => {
  const old = publication([day('2026-10-31', ['00:15'])])
  assert.equal(shouldAcceptSteamPlayerCountPublication(old, publication([day('2026-10-31', ['00:00', '00:15'])])), true)
  assert.equal(shouldAcceptSteamPlayerCountPublication(old, publication([], 'bundled')), false)
  assert.equal(shouldAcceptSteamPlayerCountPublication(old, publication([])), false)
  assert.equal(shouldAcceptSteamPlayerCountPublication(old, publication([day('2026-10-31', ['00:15'])], 'history', '2026-10-31T23:00:00.000Z')), false)
  const changed = day('2026-10-31', ['00:15']); changed.observations[0].playerCount = 200
  assert.equal(shouldAcceptSteamPlayerCountPublication(old, publication([changed])), false)
})

test('refresh failures, stale indexes, and fallback preserve the previously verified range', async () => {
  const original = publication(), observations = day().observations
  let mode: 'ready' | 'network' | 'fallback' | 'range' | 'stale' = 'ready'
  const controller = createSteamPlayerCountController({
    loadPublication: async () => {
      if (mode === 'network') throw new Error('offline')
      return mode === 'fallback' ? publication([], 'bundled') : mode === 'stale' ? publication([]) : original
    },
    loadRange: async () => { if (mode === 'range') throw new Error('missing day'); return observations },
  }, () => {}, { from: '2026-10-31', to: '2026-10-31' })
  await controller.refresh()
  for (const failure of ['network', 'fallback', 'range', 'stale'] as const) {
    mode = failure
    await controller.refresh()
    assert.equal(controller.getState().status, 'ready')
    assert.equal(controller.getState().refreshError, true)
    assert.deepEqual(controller.getState().observations, observations)
    assert.equal(controller.getState().publication, original)
  }
  mode = 'ready'
  await controller.refresh()
  assert.equal(controller.getState().refreshError, false)
})

test('a growing manifest cannot silently change or remove previously loaded observations', async () => {
  const initial = day(), changed = day('2026-10-31', ['00:00', '00:15', '00:30'])
  changed.observations[0].playerCount = 999
  let value = initial
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication([value]), loadRange: async () => value.observations }, () => {}, { from: initial.date, to: initial.date })
  await controller.refresh()
  value = changed
  await controller.refresh()
  assert.deepEqual(controller.getState().observations, initial.observations)
  assert.equal(controller.getState().refreshError, true)
})

test('range changes during an in-flight refresh load the final selection and clear old points', async () => {
  const selected = { from: '2026-10-31', to: '2026-10-31' }, earlier = { from: '2026-10-30', to: '2026-10-30' }
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const controller = createSteamPlayerCountController({
    loadPublication: async () => { await gate; return publication([day('2026-10-30'), day()]) },
    loadRange: async (_publication, range) => day(range.from).observations,
  }, () => {}, selected)
  const request = controller.refresh()
  controller.setRange(earlier)
  assert.deepEqual(controller.getState().observations, [])
  release()
  await request
  assert.equal(controller.getState().status, 'ready')
  assert.deepEqual(controller.getState().range, earlier)
  assert.deepEqual(controller.getState().observations, day('2026-10-30').observations)
})

test('range errors are explicit and disposing prevents late results', async () => {
  let failed = true, updates = 0
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication(), loadRange: async () => {
    if (failed) throw new Error('failure')
    return day().observations
  } }, () => { updates++ }, { from: '2026-10-31', to: '2026-10-31' })
  await controller.refresh()
  assert.equal(controller.getState().status, 'error')
  failed = false
  await controller.refresh()
  assert.equal(controller.getState().status, 'ready')
  const before = updates
  controller.dispose()
  await controller.refresh()
  assert.equal(updates, before)
})

test('initial range failure keeps the verified manifest available so the user can narrow to a readable date', async () => {
  const older = day('2026-10-30'), latest = day(), verified = publication([older, latest])
  const broadRange = { from: older.date, to: latest.date }, latestRange = { from: latest.date, to: latest.date }
  const controller = createSteamPlayerCountController({
    loadPublication: async () => verified,
    loadRange: async (_publication, range) => {
      if (range.from === older.date) throw new Error('older day temporarily unavailable')
      return latest.observations
    },
  }, () => {}, broadRange)
  await controller.refresh()
  assert.equal(controller.getState().status, 'error')
  assert.equal(controller.getState().publication, verified)
  assert.deepEqual(controller.getState().range, broadRange)
  assert.deepEqual(controller.getState().observations, [])
  controller.setRange(latestRange)
  await controller.refresh()
  assert.equal(controller.getState().status, 'ready')
  assert.deepEqual(controller.getState().range, latestRange)
  assert.deepEqual(controller.getState().observations, latest.observations)
})
