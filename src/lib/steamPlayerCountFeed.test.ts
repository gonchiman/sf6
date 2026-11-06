import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createSteamPlayerCountController, createSteamPlayerCountFeed, shouldAcceptSteamPlayerCountPublication,
  STEAM_PLAYER_COUNT_HISTORY_BASE_URL, type SteamPlayerCountPublication } from './steamPlayerCountFeed.ts'
import { filterSteamPlayerCountObservations, getSteamPlayerCountJstDate, resolveSteamPlayerCountTimeWindow,
  STEAM_PLAYER_COUNT_APP_ID, STEAM_PLAYER_COUNT_SOURCE_URL } from './steamPlayerCount.ts'
import { getSteamPlayerCountGame, STEAM_PLAYER_COUNT_GAMES } from './steamPlayerCountGames.ts'
import { startPublishedDataRefresh } from './publishedDataRefresh.ts'
import type { SteamPlayerCountAppId, SteamPlayerCountDateRange, SteamPlayerCountDay, SteamPlayerCountDayDescriptor, SteamPlayerCountManifest, SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'

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
function inRange(observations: SteamPlayerCountObservation[], range: SteamPlayerCountDateRange): SteamPlayerCountObservation[] {
  return observations.filter(item => { const date = getSteamPlayerCountJstDate(item.observedAt); return range.from <= date && date <= range.to })
}

function gameDay(appId: SteamPlayerCountAppId): SteamPlayerCountDay { return { ...day(), appId } }
function gameManifest(appId: SteamPlayerCountAppId, values = [gameDay(appId)]): SteamPlayerCountManifest {
  return { ...manifest(values), appId, sourceUrl: getSteamPlayerCountGame(appId).sourceUrl }
}

test('default feed URLs preserve SF6 history and isolate the other four game directories', async () => {
  for (const game of STEAM_PLAYER_COUNT_GAMES) {
    const urls: string[] = [], value = gameDay(game.appId)
    const expectedBase = `https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/steam-player-count-history/${game.historyPath}/`
    const feed = createSteamPlayerCountFeed({ appId: game.appId, fetch: async input => {
      const url = String(input); urls.push(url)
      return json(url.endsWith('index.json') ? gameManifest(game.appId) : value)
    } })
    const result = await feed.loadPublication()
    assert.equal(result.baseUrl, expectedBase)
    assert.equal(result.manifest.appId, game.appId)
    assert.equal(urls[0], `${expectedBase}index.json`)
    assert.ok(urls[1].startsWith(`${expectedBase}days/`))
    if (game.appId === STEAM_PLAYER_COUNT_APP_ID) assert.equal(result.baseUrl, STEAM_PLAYER_COUNT_HISTORY_BASE_URL)

    const fallbackUrls: string[] = []
    const fallback = createSteamPlayerCountFeed({ appId: game.appId, fetch: async input => {
      const url = String(input); fallbackUrls.push(url)
      return url.startsWith('https:') ? unavailable() : json(gameManifest(game.appId, []))
    } })
    assert.equal((await fallback.loadPublication()).baseUrl, `/${game.bundledPath}/`)
    assert.equal(fallbackUrls[1], `/${game.bundledPath}/index.json`)
  }
})

test('explicit feed bases are exact directory overrides and never receive extra game paths', async () => {
  const appId = 1778820, urls: string[] = []
  const feed = createSteamPlayerCountFeed({ appId, historyBaseUrl: 'https://fixtures.example/history', localBaseUrl: '/fixtures/bundle', fetch: async input => {
    const url = String(input); urls.push(url)
    return url.startsWith('https:') ? unavailable() : json(gameManifest(appId, []))
  } })
  assert.equal((await feed.loadPublication()).baseUrl, '/fixtures/bundle/')
  assert.deepEqual(urls, ['https://fixtures.example/history/index.json', '/fixtures/bundle/index.json'])
})

test('separate game feeds never share pending publications, observations, or day caches even with identical fixture bases', async () => {
  const calls = new Map<SteamPlayerCountAppId, number>()
  const feeds = [1364780, 1778820] as const
  const results = await Promise.all(feeds.map(async appId => {
    const value = gameDay(appId)
    value.observations = value.observations.map(item => ({ ...item, playerCount: appId === 1364780 ? 100 : 200 }))
    const feed = createSteamPlayerCountFeed({ appId, historyBaseUrl, localBaseUrl, fetch: async input => {
      calls.set(appId, (calls.get(appId) ?? 0) + 1)
      return json(String(input).endsWith('index.json') ? gameManifest(appId, [value]) : value)
    } })
    const published = await feed.loadPublication()
    const first = await feed.loadRange(published, { from: value.date, to: value.date })
    const second = await feed.loadRange(published, { from: value.date, to: value.date })
    assert.deepEqual(second, first)
    assert.equal(calls.get(appId), 2)
    return { feed, published, values: first }
  }))
  assert.equal(results[0].values[0].playerCount, 100)
  assert.equal(results[1].values[0].playerCount, 200)
  const before = [...calls.values()]
  await assert.rejects(results[1].feed.loadRange(results[0].published, { from: '2026-10-31', to: '2026-10-31' }), /appId/)
  assert.deepEqual([...calls.values()], before)
})

test('a wrong game manifest, source URL, or day payload fails rather than being relabeled', async () => {
  const appId = 1778820
  for (const failure of ['manifest-app', 'source', 'day-app'] as const) {
    const sf6 = day(), index = gameManifest(appId)
    if (failure === 'manifest-app') index.appId = STEAM_PLAYER_COUNT_APP_ID
    if (failure === 'source') index.sourceUrl = STEAM_PLAYER_COUNT_SOURCE_URL
    if (failure === 'day-app') index.days = [descriptor(sf6)]
    const feed = createSteamPlayerCountFeed({ appId, historyBaseUrl, localBaseUrl, fetch: async input => {
      const url = String(input)
      if (url.startsWith(localBaseUrl)) return unavailable()
      return json(url.endsWith('index.json') ? index : sf6)
    } })
    await assert.rejects(feed.loadPublication())
  }
})

test('publication acceptance never treats a different title or source as an append', () => {
  const previous = publication()
  const next = { ...previous, manifest: gameManifest(1778820) }
  assert.equal(shouldAcceptSteamPlayerCountPublication(previous, next), false)
  assert.equal(shouldAcceptSteamPlayerCountPublication(previous, { ...previous,
    manifest: { ...previous.manifest, sourceUrl: getSteamPlayerCountGame(1778820).sourceUrl } }), false)
})

test('disposing an in-flight game controller prevents its late data from replacing a newly selected game', async () => {
  let release: () => void = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  const received: SteamPlayerCountPublication[] = []
  const sf6 = createSteamPlayerCountController({ loadPublication: async () => { await pending; return publication() },
    loadRange: async () => day().observations }, state => { if (state.publication) received.push(state.publication) }, { from: '2026-10-31', to: '2026-10-31' })
  const oldRequest = sf6.refresh()
  sf6.dispose()
  const tekkenPublication = { ...publication(), manifest: gameManifest(1778820) }
  const tekken = createSteamPlayerCountController({ loadPublication: async () => tekkenPublication,
    loadRange: async () => gameDay(1778820).observations }, state => { if (state.publication) received.push(state.publication) }, { from: '2026-10-31', to: '2026-10-31' })
  await tekken.refresh()
  release()
  await oldRequest
  assert.deepEqual(received.map(item => item.manifest.appId), [1778820])
  assert.equal(tekken.getState().publication?.manifest.appId, 1778820)
})

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

test('large custom ranges request only manifest shards whose observed JST dates intersect', async () => {
  const values = [day('2026-10-01'), day('2026-10-31', ['15:00'])], requests: string[] = []
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    return json(url.endsWith('index.json') ? manifest(values) : values.find(value => url.includes(value.date)))
  })
  const published = await feed.loadPublication()
  assert.deepEqual(await feed.loadRange(published, { from: '0002-01-01', to: '9999-12-31' }), values.flatMap(value => value.observations))
  assert.equal(requests.length, 3)
  assert.deepEqual(await feed.loadRange(published, { from: '2026-10-31', to: '2026-10-31' }), [])
  assert.equal(requests.length, 3)
})

test('relative controller selections recalculate on refresh after JST midnight without clamping to the manifest', async () => {
  for (const selection of ['24h', 'today', 'yesterday', '7d', '30d', null] as const) {
    let now = new Date('2026-10-31T14:59:59.999Z')
    const ranges: SteamPlayerCountDateRange[] = []
    const controller = createSteamPlayerCountController({ loadPublication: async () => publication([]),
      loadRange: async (_publication, range) => { ranges.push(range); return [] } }, () => {}, selection, () => now)
    await controller.refresh()
    assert.equal(controller.getState().range.to, selection === 'yesterday' ? '2026-10-30' : '2026-10-31')
    now = new Date('2026-10-31T15:00:00.000Z')
    await controller.refresh()
    const expected = selection === 'today' ? { from: '2026-11-01', to: '2026-11-01' }
      : selection === 'yesterday' ? { from: '2026-10-31', to: '2026-10-31' }
      : selection === '30d' ? { from: '2026-10-02', to: '2026-11-01' }
        : selection === '7d' ? { from: '2026-10-25', to: '2026-11-01' } : { from: '2026-10-31', to: '2026-11-01' }
    assert.equal(controller.getState().status, 'ready')
    assert.deepEqual(controller.getState().range, expected)
    assert.deepEqual(ranges.at(-1), expected)
    assert.equal(controller.getState().now.getTime(), now.getTime())
  }
})

test('24-hour refreshes advance their clock within the same dates and do not re-read endlessly as time passes', async () => {
  let now = new Date('2026-11-01T03:00:00.000Z'), reads = 0
  const values = day('2026-10-31', ['00:00', '03:00']).observations
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication(),
    loadRange: async (_publication, range) => {
      reads++
      assert.ok(reads <= 2, 'clock movement within a date must not trigger another read')
      now = new Date(now.getTime() + 250)
      return inRange(values, range)
    },
  }, () => {}, null, () => now)
  await controller.refresh()
  assert.equal(controller.getSelection(), '24h')
  assert.equal(controller.getState().now.toISOString(), '2026-11-01T03:00:00.250Z')
  // The feed retains complete dates so prior observations remain covered by the immutable-overlap check.
  assert.deepEqual(controller.getState().observations, values)
  now = new Date('2026-11-01T03:05:00.000Z')
  const pending = controller.refresh()
  assert.equal(controller.getState().now.toISOString(), '2026-11-01T03:05:00.000Z')
  await pending
  assert.equal(controller.getState().status, 'ready')
  assert.equal(controller.getState().now.toISOString(), '2026-11-01T03:05:00.250Z')
  assert.equal(reads, 2)
})

test('7-day and 30-day controllers retain full dates while their display windows move by elapsed time', async () => {
  for (const [selection, days] of [['7d', 7], ['30d', 30]] as const) {
    let now = new Date('2026-11-06T03:10:00.000Z')
    const start = now.getTime() - days * 24 * 60 * 60 * 1000
    const values = [start - 1, start, start + 5 * 60 * 1000, now.getTime()].map(time => observation(new Date(time).toISOString()))
    const storedDays: SteamPlayerCountDay[] = [...new Set(values.map(item => item.observedAt.slice(0, 10)))].map(date => ({
      schemaVersion: 1, appId: STEAM_PLAYER_COUNT_APP_ID, date, observations: values.filter(item => item.observedAt.startsWith(date)),
    }))
    const controller = createSteamPlayerCountController({ loadPublication: async () => publication(storedDays),
      loadRange: async (_publication, range) => inRange(values, range) }, () => {}, selection, () => now)
    await controller.refresh()
    const first = controller.getState()
    assert.deepEqual(first.range, { from: days === 7 ? '2026-10-30' : '2026-10-07', to: '2026-11-06' })
    assert.deepEqual(first.observations, values)
    assert.deepEqual(filterSteamPlayerCountObservations(first.observations, first.range, 'all',
      resolveSteamPlayerCountTimeWindow(controller.getSelection(), first.now)), values.slice(1))
    now = new Date(now.getTime() + 5 * 60 * 1000)
    await controller.refresh()
    const refreshed = controller.getState()
    assert.deepEqual(refreshed.range, first.range)
    assert.equal(refreshed.now.getTime(), now.getTime())
    assert.deepEqual(filterSteamPlayerCountObservations(refreshed.observations, refreshed.range, 'all',
      resolveSteamPlayerCountTimeWindow(controller.getSelection(), refreshed.now)), values.slice(2))
  }
})

test('24-hour failed refreshes advance the clock but preserve data only while its requested dates remain valid', async () => {
  for (const failure of ['publication', 'range']) {
    let now = new Date('2026-10-31T14:50:00.000Z'), fail = false
    const values = day().observations
    const controller = createSteamPlayerCountController({
      loadPublication: async () => { if (fail && failure === 'publication') throw new Error('offline'); return publication() },
      loadRange: async (_publication, range) => { if (fail && failure === 'range') throw new Error('missing'); return inRange(values, range) },
    }, () => {}, '24h', () => now)
    await controller.refresh()
    const verified = controller.getState().observations
    now = new Date('2026-10-31T14:55:00.000Z'); fail = true
    await controller.refresh()
    assert.equal(controller.getState().status, 'ready')
    assert.equal(controller.getState().refreshError, true)
    assert.equal(controller.getState().observations, verified)
    assert.equal(controller.getState().now.getTime(), now.getTime())
    now = new Date('2026-10-31T15:00:00.000Z')
    await controller.refresh()
    assert.equal(controller.getState().status, 'error')
    assert.deepEqual(controller.getState().observations, [])
    assert.deepEqual(controller.getState().range, { from: '2026-10-31', to: '2026-11-01' })
    assert.equal(controller.getState().now.getTime(), now.getTime())
  }
})

test('a pending 24-hour read crossing midnight settles once with matching dates and clock', async () => {
  let now = new Date('2026-10-31T14:59:59.900Z'), reads = 0
  const ready: { range: SteamPlayerCountDateRange; now: Date }[] = []
  const values = day('2026-10-31', ['00:00', '15:00']).observations
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication(),
    loadRange: async (_publication, range) => {
      reads++
      assert.ok(reads <= 2)
      now = new Date(now.getTime() + 200)
      return inRange(values, range)
    },
  }, state => { if (state.status === 'ready') ready.push({ range: state.range, now: state.now }) }, '24h', () => now)
  await controller.refresh()
  assert.equal(reads, 2)
  assert.deepEqual(ready, [{ range: { from: '2026-10-31', to: '2026-11-01' }, now }])
  assert.deepEqual(controller.getState().observations, values)
})

test('custom dates remain fixed when a preset with identical dates is changed before midnight', async () => {
  let now = new Date('2026-10-31T14:59:59.999Z')
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication([]), loadRange: async () => [] }, () => {}, 'today', () => now)
  await controller.refresh()
  const custom = { ...controller.getState().range }
  controller.setRange(custom)
  await controller.refresh()
  now = new Date('2026-10-31T15:00:00.000Z')
  await controller.refresh()
  assert.deepEqual(controller.getState().range, custom)
  controller.setRange('today')
  await controller.refresh()
  assert.deepEqual(controller.getState().range, { from: '2026-11-01', to: '2026-11-01' })
  controller.setRange('yesterday')
  await controller.refresh()
  assert.deepEqual(controller.getState().range, custom)
})

test('all follows newly observed JST dates while empty all stays an unobserved today placeholder', async () => {
  let value = day('2026-10-31', ['14:45'])
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication([value]),
    loadRange: async (_publication, range) => inRange(value.observations, range) }, () => {}, 'all', () => new Date('2026-11-01T03:00:00.000Z'))
  await controller.refresh()
  assert.deepEqual(controller.getState().range, { from: '2026-10-31', to: '2026-10-31' })
  value = day('2026-10-31', ['14:45', '15:00'])
  await controller.refresh()
  assert.deepEqual(controller.getState().range, { from: '2026-10-31', to: '2026-11-01' })
  assert.equal(controller.getState().observations.length, 2)
  const empty = createSteamPlayerCountController({ loadPublication: async () => publication([]), loadRange: async () => [] }, () => {}, 'all', () => new Date('2026-11-02T03:00:00.000Z'))
  await empty.refresh()
  assert.deepEqual(empty.getState().range, { from: '2026-11-02', to: '2026-11-02' })
  assert.deepEqual(empty.getState().observations, [])
})

test('midnight refresh failures clear the previous day rather than displaying it as today', async () => {
  for (const failure of ['publication', 'range']) {
    let now = new Date('2026-10-31T14:59:59.999Z'), fail = false
    const controller = createSteamPlayerCountController({
      loadPublication: async () => { if (fail && failure === 'publication') throw new Error('offline'); return publication() },
      loadRange: async (_publication, range) => { if (fail && failure === 'range') throw new Error('missing'); return inRange(day().observations, range) },
    }, () => {}, 'today', () => now)
    await controller.refresh()
    assert.equal(controller.getState().observations.length, 2)
    now = new Date('2026-10-31T15:00:00.000Z'); fail = true
    await controller.refresh()
    assert.equal(controller.getState().status, 'error')
    assert.deepEqual(controller.getState().range, { from: '2026-11-01', to: '2026-11-01' })
    assert.deepEqual(controller.getState().observations, [])
  }
})

test('a pending request crossing JST midnight resolves the new dates before any result is displayed', async () => {
  let now = new Date('2026-10-31T14:59:59.999Z'), release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ranges: SteamPlayerCountDateRange[] = [], ready: SteamPlayerCountDateRange[] = []
  const values = day('2026-10-31', ['14:45', '15:00']).observations
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication(),
    loadRange: async (_publication, range) => { ranges.push(range); if (ranges.length === 1) await gate; return inRange(values, range) },
  }, state => { if (state.status === 'ready') ready.push(state.range) }, 'today', () => now)
  const pending = controller.refresh()
  await Promise.resolve()
  now = new Date('2026-10-31T15:00:00.000Z')
  assert.equal(controller.refresh(), pending)
  release()
  await pending
  assert.deepEqual(ranges, [{ from: '2026-10-31', to: '2026-10-31' }, { from: '2026-11-01', to: '2026-11-01' }])
  assert.deepEqual(ready, [{ from: '2026-11-01', to: '2026-11-01' }])
  assert.deepEqual(controller.getState().observations, [values[1]])
})

test('rapid preset changes during a failed range request cannot restore an earlier selection', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve }), ranges: SteamPlayerCountDateRange[] = []
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication(),
    loadRange: async (_publication, range) => {
      ranges.push(range)
      if (ranges.length === 1) { await gate; throw new Error('old range failed') }
      return inRange(day().observations, range)
    },
  }, () => {}, '30d', () => new Date('2026-11-01T03:00:00.000Z'))
  const pending = controller.refresh()
  await Promise.resolve()
  controller.setRange('today')
  controller.setRange('yesterday')
  assert.deepEqual(controller.getState().observations, [])
  release()
  await pending
  assert.equal(controller.getState().status, 'ready')
  assert.deepEqual(controller.getState().range, { from: '2026-10-31', to: '2026-10-31' })
  assert.deepEqual(controller.getState().observations, day().observations)
  assert.equal(ranges.length, 2)
})

test('a rolling period still rejects changed or missing observations in its overlapping days', async () => {
  let now = new Date('2026-10-31T14:59:59.999Z'), corrupted = false
  const values = day().observations
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication(),
    loadRange: async () => corrupted ? values.slice(1) : values }, () => {}, '7d', () => now)
  await controller.refresh()
  corrupted = true; now = new Date('2026-10-31T15:00:00.000Z')
  await controller.refresh()
  assert.equal(controller.getState().status, 'error')
  assert.deepEqual(controller.getState().range, { from: '2026-10-25', to: '2026-11-01' })
  assert.deepEqual(controller.getState().observations, [])
})

test('visibility restoration refreshes a relative period after the tab crossed JST midnight', async () => {
  let now = new Date('2026-10-31T14:59:59.999Z'), visibility = 'hidden', refreshes = 0
  let onVisibility: () => void = () => {}, pending = Promise.resolve()
  const controller = createSteamPlayerCountController({ loadPublication: async () => publication([]), loadRange: async () => [] }, () => {}, 'today', () => now)
  await controller.refresh()
  const stop = startPublishedDataRefresh(() => { refreshes++; pending = controller.refresh() }, {
    document: { get visibilityState() { return visibility }, addEventListener: (_type, listener) => { onVisibility = listener }, removeEventListener: () => {} },
    window: { setInterval: () => 1, clearInterval: () => {} },
  })
  now = new Date('2026-10-31T15:00:00.000Z')
  onVisibility()
  assert.equal(refreshes, 0)
  visibility = 'visible'; onVisibility()
  await pending
  assert.equal(refreshes, 1)
  assert.deepEqual(controller.getState().range, { from: '2026-11-01', to: '2026-11-01' })
  stop(); onVisibility()
  assert.equal(refreshes, 1)
})
