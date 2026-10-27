import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPublishedDataController, type PublishedDataFeed, type PublishedDataState } from './publishedDataController.ts'

interface Publication {
  source: 'history' | 'bundled'
  baseUrl: string
  manifest: {
    generatedAt: string
    datasets: { id: string; captureEndedAt: string; totalCount: number }[]
    availability?: { status: 'collection-failed'; checkedAt: string }
  }
}

function publication(days: string[], source: Publication['source'] = 'history'): Publication {
  return { source, baseUrl: `${source}/`, manifest: { generatedAt: '2026-10-27T00:00:00.000Z',
    datasets: days.map(day => ({ id: `max-lp-${day}`, captureEndedAt: `2026-10-${day}T01:00:00.000Z`, totalCount: 3000000 })) } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function fixture(initial: Publication) {
  let next = initial
  let loadFailure = false
  const requests: { publication: Publication; id: string }[] = []
  const states: PublishedDataState<Publication>[] = []
  const feed: PublishedDataFeed<Publication> = {
    async loadPublication() { if (loadFailure) throw new Error('offline'); return next },
    async loadDataset(publication, descriptor) { requests.push({ publication, id: descriptor.id }) },
  }
  const controller = createPublishedDataController(feed, state => states.push(state))
  return { controller, feed, states, requests,
    setNext: (value: Publication) => { next = value }, setLoadFailure: (value: boolean) => { loadFailure = value } }
}

test('initial publication waits for the selected capture before making it ready', async () => {
  const first = publication(['17', '18'])
  const pending = deferred<void>()
  const started = deferred<void>()
  const item = fixture(first)
  item.feed.loadDataset = async (_, descriptor) => {
    assert.equal(descriptor.id, 'max-lp-18')
    started.resolve()
    await pending.promise
  }
  const refresh = item.controller.refresh()
  await started.promise
  assert.deepEqual(item.controller.getState(), { status: 'loading', publication: null, selectedId: null, refreshError: false })
  pending.resolve()
  await refresh
  assert.deepEqual(item.controller.getState(), { status: 'ready', publication: first, selectedId: 'max-lp-18', refreshError: false })
})

test('initial failure can be retried without exposing an unverified publication', async () => {
  const item = fixture(publication(['18']))
  item.setLoadFailure(true)
  await item.controller.refresh()
  assert.equal(item.controller.getState().status, 'error')
  assert.equal(item.controller.getState().publication, null)
  item.setLoadFailure(false)
  await item.controller.refresh()
  assert.equal(item.states[1].status, 'loading')
  assert.equal(item.controller.getState().status, 'ready')
})

test('refresh follows the latest capture and preserves an explicitly selected older capture', async () => {
  const item = fixture(publication(['17', '18']))
  await item.controller.refresh()
  item.setNext(publication(['17', '18', '19']))
  await item.controller.refresh()
  assert.equal(item.controller.getState().selectedId, 'max-lp-19')
  item.controller.setSelectedId('max-lp-17')
  item.setNext(publication(['17', '18', '19', '20']))
  await item.controller.refresh()
  assert.equal(item.controller.getState().selectedId, 'max-lp-17')
  assert.equal(item.requests.at(-1)?.id, 'max-lp-17')
})

test('network and selected-capture failures retain the usable publication and recover on retry', async () => {
  const first = publication(['17', '18']), next = publication(['17', '18', '19'])
  const item = fixture(first)
  await item.controller.refresh()
  item.setLoadFailure(true)
  await item.controller.refresh()
  assert.equal(item.controller.getState().publication, first)
  assert.equal(item.controller.getState().refreshError, true)
  item.setLoadFailure(false)
  item.setNext(next)
  item.feed.loadDataset = async () => { throw new Error('capture missing') }
  await item.controller.refresh()
  assert.equal(item.controller.getState().publication, first)
  assert.equal(item.controller.getState().selectedId, 'max-lp-18')
  assert.equal(item.controller.getState().status, 'ready')
  item.feed.loadDataset = async () => undefined
  await item.controller.refresh()
  assert.equal(item.controller.getState().publication, next)
  assert.equal(item.controller.getState().selectedId, 'max-lp-19')
  assert.equal(item.controller.getState().refreshError, false)
})

test('fallback and shortened histories do not discard successful displayed history', async () => {
  const first = publication(['17', '18'])
  const item = fixture(first)
  await item.controller.refresh()
  item.controller.setSelectedId('max-lp-17')
  for (const next of [publication(['17', '18'], 'bundled'), publication(['18', '19'])]) {
    item.setNext(next)
    await item.controller.refresh()
    assert.equal(item.controller.getState().publication, first)
    assert.equal(item.controller.getState().selectedId, 'max-lp-17')
    assert.equal(item.controller.getState().refreshError, true)
  }
  assert.equal(item.requests.length, 1)
})

test('same-capture availability updates are accepted and identical publications keep their identity', async () => {
  const first = publication(['18'])
  const item = fixture(first)
  await item.controller.refresh()
  item.setNext(structuredClone(first))
  await item.controller.refresh()
  assert.equal(item.controller.getState().publication, first)
  assert.equal(item.states.length, 1)
  const failed = publication(['18'])
  failed.manifest.availability = { status: 'collection-failed', checkedAt: '2026-10-27T00:00:00.000Z' }
  item.setNext(failed)
  await item.controller.refresh()
  assert.equal(item.controller.getState().publication, failed)
  assert.equal(item.controller.getState().selectedId, 'max-lp-18')
  assert.equal(item.controller.getState().refreshError, false)
})

test('a selection changed during refresh is preloaded before publication switches', async () => {
  const first = publication(['17', '18']), next = publication(['17', '18', '19'])
  const item = fixture(first)
  await item.controller.refresh()
  item.setNext(next)
  const newest = deferred<void>(), newestStarted = deferred<void>()
  const selected = deferred<void>(), selectedStarted = deferred<void>()
  item.feed.loadDataset = async (_, descriptor) => {
    if (descriptor.id === 'max-lp-19') { newestStarted.resolve(); await newest.promise }
    else { assert.equal(descriptor.id, 'max-lp-17'); selectedStarted.resolve(); await selected.promise }
  }
  const refresh = item.controller.refresh()
  await newestStarted.promise
  item.controller.setSelectedId('max-lp-17')
  newest.resolve()
  await selectedStarted.promise
  assert.equal(item.controller.getState().publication, first)
  selected.resolve()
  await refresh
  assert.equal(item.controller.getState().publication, next)
  assert.equal(item.controller.getState().selectedId, 'max-lp-17')
})

test('a failed changed selection keeps the previous publication and current selection', async () => {
  const first = publication(['17', '18'])
  const item = fixture(first)
  await item.controller.refresh()
  item.setNext(publication(['17', '18', '19']))
  item.feed.loadDataset = async (_, descriptor) => {
    if (descriptor.id === 'max-lp-19') item.controller.setSelectedId('max-lp-17')
    else throw new Error('selected capture missing')
  }
  await item.controller.refresh()
  assert.equal(item.controller.getState().publication, first)
  assert.equal(item.controller.getState().selectedId, 'max-lp-17')
  assert.equal(item.controller.getState().refreshError, true)
})

test('rapid repeated selection changes defer replacement after a bounded number of checks', async () => {
  const first = publication(['17', '18'])
  const item = fixture(first)
  await item.controller.refresh()
  item.setNext(publication(['17', '18', '19']))
  let checks = 0
  item.feed.loadDataset = async (_, descriptor) => {
    checks++
    item.controller.setSelectedId(descriptor.id === 'max-lp-17' ? 'max-lp-18' : 'max-lp-17')
  }
  await item.controller.refresh()
  assert.equal(checks, 3)
  assert.equal(item.controller.getState().publication, first)
})

test('concurrent refresh requests share one operation and disposed controllers cannot publish', async () => {
  const item = fixture(publication(['18']))
  const pending = deferred<Publication>()
  let requests = 0
  item.feed.loadPublication = () => { requests++; return pending.promise }
  const first = item.controller.refresh(), second = item.controller.refresh()
  assert.equal(first, second)
  assert.equal(requests, 1)
  item.controller.dispose()
  pending.resolve(publication(['18']))
  await first
  await item.controller.refresh()
  item.controller.setSelectedId('max-lp-18')
  assert.equal(requests, 1)
  assert.equal(item.states.length, 0)
  assert.equal(item.requests.length, 0)
})

test('an empty publication is a ready state without requesting an invented capture', async () => {
  const item = fixture(publication([]))
  await item.controller.refresh()
  assert.equal(item.controller.getState().status, 'ready')
  assert.equal(item.controller.getState().selectedId, null)
  assert.equal(item.requests.length, 0)
})
