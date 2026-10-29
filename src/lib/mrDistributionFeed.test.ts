import assert from 'node:assert/strict'
import test from 'node:test'
import { MR_DISTRIBUTION_CHECKS, MR_DISTRIBUTION_CONDITIONS, MR_DISTRIBUTION_SOURCE, MR_DISTRIBUTION_THRESHOLDS } from './mrDistribution.ts'
import { createMrDistributionFeed } from './mrDistributionFeed.ts'
import { createPublishedDataController } from './publishedDataController.ts'
import type { MrDistributionDataset, MrDistributionDescriptor, MrDistributionManifest } from '../types/mrDistribution.ts'

const historyBaseUrl = 'https://history.example/public/'
const localBaseUrl = '/sf6/data/mr-distribution/'
const json = (value: unknown): Response => Response.json(value)
const unavailable = (): Response => new Response('', { status: 503 })

function dataset(day = '20', counts = Array.from({ length: 26 }, (_, index) => index + 1)): MrDistributionDataset {
  const entries = counts.map((count, index) => ({ minimum: index * 100, maximum: index === 25 ? null : (index + 1) * 100, count }))
  const totalCount = counts.reduce((total, count) => total + count, 0)
  return {
    schemaVersion: 1, id: `max-mr-estimate-test-${day}`, captureStartedAt: `2026-10-${day}T01:00:00Z`,
    captureEndedAt: `2026-10-${day}T01:10:00Z`, generatedAt: `2026-10-${day}T01:11:00Z`,
    source: { ...MR_DISTRIBUTION_SOURCE, population: '人工テストの今Act・最大MR一覧', metric: '100MR刻みの概数',
      unit: 'fighter-account', notes: ['人工テスト。'] },
    conditions: { ...MR_DISTRIBUTION_CONDITIONS }, method: 'boundary-search-estimate', binWidth: 100, totalCount, entries,
    observation: { totalAtStart: totalCount, totalAtEnd: totalCount, minTotal: totalCount, maxTotal: totalCount,
      boundaries: MR_DISTRIBUTION_THRESHOLDS.map(minimumMr => ({ minimumMr, totalCount, observedAt: `2026-10-${day}T01:05:00Z`,
        countAtOrAbove: entries.filter(bin => bin.minimum >= minimumMr).reduce((total, bin) => total + bin.count, 0) })) },
    validation: { status: 'estimated', coverage: 'all-mr-boundaries', checks: [...MR_DISTRIBUTION_CHECKS], notes: ['人工テストの全25境界。'] },
  }
}
function descriptor(value: MrDistributionDataset): MrDistributionDescriptor {
  return { id: value.id, path: `${value.id}.json`, captureStartedAt: value.captureStartedAt,
    captureEndedAt: value.captureEndedAt, totalCount: value.totalCount }
}
function manifest(values = [dataset()], generatedAt = '2026-10-23T02:00:00Z'): MrDistributionManifest {
  return { schemaVersion: 1, generatedAt, source: MR_DISTRIBUTION_SOURCE, datasets: values.map(descriptor) }
}
function feed(fetchData: typeof fetch, timeoutMs = 500) {
  return createMrDistributionFeed({ fetch: fetchData, historyBaseUrl, localBaseUrl, timeoutMs })
}

test('MR feed verifies all 26 bins and 25 boundaries before selecting history, with fresh index and shared bodies', async () => {
  const latest = dataset(), older = dataset('19'), requests: { url: string; options?: RequestInit }[] = []
  const client = feed(async (input, options) => {
    const url = String(input); requests.push({ url, options })
    assert.ok(url.startsWith(historyBaseUrl))
    return json(url.endsWith('index.json') ? manifest([older, latest]) : latest)
  })
  const pending = client.loadPublication()
  assert.equal(client.loadPublication(), pending)
  const publication = await pending
  assert.equal(publication.source, 'history')
  assert.equal(requests[0].options?.cache, 'no-store')
  assert.ok(requests.every(request => request.options?.credentials === 'omit'))
  assert.ok(requests[1].url.includes(latest.id))
  const [first, second] = await Promise.all([client.loadDataset(publication, descriptor(latest)), client.loadDataset(publication, descriptor(latest))])
  assert.deepEqual(first, latest)
  assert.equal(first, second)
  assert.equal(first.entries.length, 26)
  assert.equal(first.observation.boundaries.length, 25)
  assert.equal(requests.length, 2)
})

test('invalid MR publication or incomplete/latest capture selects a wholly bundled source', async t => {
  const latest = dataset(), older = dataset('19')
  const invalidBodies: Record<string, unknown> = {
    'missing-bin': { ...latest, entries: latest.entries.slice(1) },
    'missing-boundary': { ...latest, observation: { ...latest.observation, boundaries: latest.observation.boundaries.slice(1) } },
    'cumulative-mismatch': { ...latest, observation: { ...latest.observation, boundaries: latest.observation.boundaries.map(boundary => ({ ...boundary, countAtOrAbove: 0 })) } },
    'previous-act': { ...latest, conditions: { ...latest.conditions, act: 'previous' } },
    'wrong-character-scope': { ...latest, conditions: { ...latest.conditions, character: 'all' } },
    'lp-source': { ...latest, source: { ...latest.source, url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league' } },
    'private-field': { ...latest, playerIds: ['private'] },
    'descriptor-mismatch': { ...latest, id: 'another-capture' },
    'newer-than-publication': { ...latest, generatedAt: '2026-10-24T00:00:00Z' },
  }
  for (const [name, value] of Object.entries(invalidBodies)) await t.test(name, async () => {
    const client = feed(async input => {
      const url = String(input)
      if (url.startsWith(localBaseUrl)) return json(url.endsWith('index.json') ? manifest([older]) : older)
      return json(url.endsWith('index.json') ? manifest([latest]) : value)
    })
    const publication = await client.loadPublication()
    assert.equal(publication.source, 'bundled')
    assert.deepEqual(await client.loadDataset(publication, descriptor(older)), older)
  })
  for (const value of [
    { ...manifest(), cookie: 'private' },
    { ...manifest(), datasets: [{ ...descriptor(latest), path: '../outside.json' }] },
    { ...manifest(), source: { ...MR_DISTRIBUTION_SOURCE, url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league' } },
  ]) {
    const client = feed(async input => String(input).startsWith(historyBaseUrl) ? json(value)
      : json(String(input).endsWith('index.json') ? manifest([older]) : older))
    assert.equal((await client.loadPublication()).source, 'bundled')
  }
})

test('MR historical reads retry on the selected source and reject altered descriptor or source', async () => {
  const latest = dataset(), older = dataset('19'), requests: string[] = []
  let oldAvailable = false
  const client = feed(async input => {
    const url = String(input); requests.push(url)
    assert.ok(url.startsWith(historyBaseUrl))
    if (url.endsWith('index.json')) return json(manifest([latest, older]))
    if (url.includes(older.id)) return oldAvailable ? json(older) : unavailable()
    return json(latest)
  })
  const publication = await client.loadPublication()
  await assert.rejects(client.loadDataset(publication, descriptor(older)), /読み込めません/)
  oldAvailable = true
  assert.deepEqual(await client.loadDataset(publication, descriptor(older)), older)
  await assert.rejects(client.loadDataset(publication, { ...descriptor(latest), totalCount: 0 }), /一覧と一致/)
  await assert.rejects(client.loadDataset({ ...publication, baseUrl: localBaseUrl }, descriptor(latest)), /取得元が一致/)
  assert.equal(requests.filter(url => url.includes(older.id)).length, 2)
})

test('MR refresh follows latest captures, keeps past selection, and preserves good data on outage', async () => {
  const first = dataset('19'), second = dataset('20'), third = dataset('21')
  let current = manifest([first]), online = true
  const client = feed(async input => {
    const url = String(input)
    if (!online && url.startsWith(historyBaseUrl)) return unavailable()
    if (url.endsWith('index.json')) return json(url.startsWith(localBaseUrl) ? manifest([first]) : current)
    return json([first, second, third].find(value => url.includes(value.id)))
  })
  const controller = createPublishedDataController(client, () => {})
  await controller.refresh()
  assert.equal(controller.getState().selectedId, first.id)
  current = manifest([second, first])
  await controller.refresh()
  assert.equal(controller.getState().selectedId, second.id)
  controller.setSelectedId(first.id)
  current = manifest([third, second, first])
  current.availability = { status: 'collection-failed', checkedAt: current.generatedAt, message: '直近の取得失敗' }
  await controller.refresh()
  assert.equal(controller.getState().selectedId, first.id)
  assert.equal(controller.getState().publication?.manifest.availability?.status, 'collection-failed')
  const good = controller.getState().publication
  online = false
  await controller.refresh()
  assert.equal(controller.getState().publication, good)
  assert.equal(controller.getState().refreshError, true)
  assert.equal(controller.getState().selectedId, first.id)
  controller.dispose()
})

test('MR feed retries an unavailable history and caches corrected counts by publication', async () => {
  const original = dataset(), corrected = dataset('20', [2, 1, ...Array.from({ length: 24 }, (_, index) => index + 3)])
  let online = false, current = original, generatedAt = '2026-10-21T00:00:00Z'
  const client = feed(async input => {
    const url = String(input)
    if (!online && url.startsWith(historyBaseUrl)) return unavailable()
    const value = url.startsWith(historyBaseUrl) ? current : original
    return json(url.endsWith('index.json') ? manifest([value], generatedAt) : value)
  })
  assert.equal((await client.loadPublication()).source, 'bundled')
  online = true
  const initial = await client.loadPublication()
  assert.equal(initial.source, 'history')
  assert.equal((await client.loadDataset(initial, descriptor(original))).entries[0].count, 1)
  current = corrected; generatedAt = '2026-10-22T00:00:00Z'
  const updated = await client.loadPublication()
  assert.equal((await client.loadDataset(updated, descriptor(corrected))).entries[0].count, 2)
})

test('MR timeout preserves bundled availability and a true zero capture remains a validated distribution', async () => {
  const empty = { ...manifest([]), availability: { status: 'not-collected', checkedAt: '2026-10-23T02:00:00Z', message: '未取得' } }
  let stalled = true
  const zero = dataset('20', Array(26).fill(0))
  const client = feed(async input => {
    const url = String(input)
    if (url.startsWith(localBaseUrl)) return json(empty)
    if (url.endsWith('index.json')) return json(manifest([zero]))
    return stalled ? { ok: true, json: () => new Promise<unknown>(() => {}) } as Response : json(zero)
  }, 10)
  const fallback = await client.loadPublication()
  assert.equal(fallback.source, 'bundled')
  assert.equal(fallback.manifest.datasets.length, 0)
  assert.equal(fallback.manifest.availability?.status, 'not-collected')
  stalled = false
  const publication = await client.loadPublication()
  assert.equal(publication.source, 'history')
  assert.equal((await client.loadDataset(publication, descriptor(zero))).totalCount, 0)
})
