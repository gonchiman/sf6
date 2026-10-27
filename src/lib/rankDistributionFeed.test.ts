import assert from 'node:assert/strict'
import test from 'node:test'
import { RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_ESTIMATE_CHECKS, RANK_DISTRIBUTION_SOURCE,
  RANK_DISTRIBUTION_VALIDATION_CHECKS } from './rankDistribution.ts'
import { createRankDistributionFeed } from './rankDistributionFeed.ts'
import type { RankDistributionDataset, RankDistributionDescriptor, RankDistributionManifest } from '../types/rankDistribution.ts'

const historyBaseUrl = 'https://history.example/data/'
const localBaseUrl = '/sf6/data/rank-distribution/'
const json = (value: unknown): Response => new Response(JSON.stringify(value))
const unavailable = (): Response => new Response('', { status: 503 })

function dataset(day = '20'): RankDistributionDataset {
  return {
    schemaVersion: 1, id: `rank-${day}`, captureStartedAt: `2026-10-${day}T01:00:00.000Z`,
    captureEndedAt: `2026-10-${day}T01:15:00.000Z`, generatedAt: `2026-10-${day}T01:16:00.000Z`,
    source: { ...RANK_DISTRIBUTION_SOURCE, population: '人工テストの掲載アカウント', metric: 'ランク別掲載件数',
      unit: 'fighter-account', notes: ['人工テスト。'] },
    conditions: { ...RANK_DISTRIBUTION_CONDITIONS }, method: 'boundary-search', totalCount: 666,
    entries: Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, count: index + 1 })),
    validation: { status: 'verified', coverage: 'all-listed-accounts', checks: [...RANK_DISTRIBUTION_VALIDATION_CHECKS], notes: ['人工テスト。'] },
  }
}
function estimatedDataset(day = '20'): RankDistributionDataset {
  const value = dataset(day)
  return { ...value, method: 'boundary-search-estimate',
    validation: { status: 'estimated', coverage: 'all-rank-boundaries', checks: [...RANK_DISTRIBUTION_ESTIMATE_CHECKS], notes: ['人工テストの概数。'] },
    observation: { totalAtStart: 665, totalAtEnd: value.totalCount, minTotal: 665, maxTotal: 668,
      boundaries: Array.from({ length: 35 }, (_, index) => ({ rankId: index + 2, totalCount: value.totalCount,
        observedAt: `2026-10-${day}T01:05:00.000Z`,
        countAtOrAbove: value.entries.filter(entry => entry.rankId >= index + 2).reduce((total, entry) => total + entry.count, 0) })) },
  }
}
function descriptor(value: RankDistributionDataset): RankDistributionDescriptor {
  return { id: value.id, path: `snapshots/${value.id}.json`, captureStartedAt: value.captureStartedAt,
    captureEndedAt: value.captureEndedAt, totalCount: value.totalCount }
}
function manifest(values = [dataset()], generatedAt = '2026-10-21T00:00:00.000Z'): RankDistributionManifest {
  return { schemaVersion: 1, generatedAt, source: RANK_DISTRIBUTION_SOURCE, datasets: values.map(descriptor) }
}
function createFeed(fetchData: typeof fetch, timeoutMs = 500) {
  return createRankDistributionFeed({ fetch: fetchData, localBaseUrl, historyBaseUrl, timeoutMs })
}

test('LP feed verifies the latest aggregate before selecting history and preserves estimate evidence', async () => {
  const latest = estimatedDataset(), older = dataset('19'), requests: { url: string; options?: RequestInit }[] = []
  const feed = createFeed(async (input, options) => {
    const url = String(input); requests.push({ url, options })
    assert.ok(url.startsWith(historyBaseUrl))
    return json(url.endsWith('index.json') ? manifest([older, latest]) : latest)
  })
  const first = feed.loadPublication()
  assert.equal(feed.loadPublication(), first)
  const publication = await first
  assert.equal(publication.source, 'history')
  assert.ok(requests[1].url.startsWith(`${historyBaseUrl}snapshots/rank-20.json?`))
  assert.equal(requests[0].options?.cache, 'no-store')
  assert.ok(requests.every(request => request.options?.credentials === 'omit'))
  assert.deepEqual(await feed.loadDataset(publication, descriptor(latest)), latest)
  assert.equal(requests.length, 2)
})

test('LP manifest failures select a bundled publication without mixing its capture source', async t => {
  for (const failure of ['network', 'http', 'private-field', 'invalid-path']) await t.test(failure, async () => {
    const local = dataset('19'), requests: string[] = []
    const feed = createFeed(async input => {
      const url = String(input); requests.push(url)
      if (url.startsWith(historyBaseUrl)) {
        if (failure === 'network') throw new Error('offline')
        if (failure === 'http') return unavailable()
        if (failure === 'private-field') return json({ ...manifest(), playerIds: ['private'] })
        return json({ ...manifest(), datasets: [{ ...descriptor(dataset()), path: '../outside.json' }] })
      }
      return json(url.endsWith('index.json') ? manifest([local]) : local)
    })
    const publication = await feed.loadPublication()
    assert.equal(publication.source, 'bundled')
    assert.deepEqual(await feed.loadDataset(publication, descriptor(local)), local)
    assert.equal(requests.length, 3)
  })
})

test('invalid LP counts, conditions, estimate evidence and publication metadata trigger whole-publication fallback', async t => {
  const latest = dataset(), estimate = estimatedDataset(), local = dataset('19')
  const invalid: Record<string, unknown> = {
    'missing-rank': { ...latest, entries: latest.entries.slice(1) },
    'total-mismatch': { ...latest, entries: latest.entries.map(entry => ({ ...entry, count: 0 })) },
    'changed-condition': { ...latest, conditions: { ...latest.conditions, character: 'ryu' } },
    'missing-boundary': { ...estimate, observation: { ...estimate.observation!, boundaries: estimate.observation!.boundaries.slice(1) } },
    'private-field': { ...latest, playerIds: ['private'] },
    'newer-than-manifest': { ...latest, generatedAt: '2026-10-22T00:00:00Z' },
    'different-source': { ...latest, source: { ...latest.source, url: 'https://www.streetfighter.com/6/buckler/en/ranking/league' } },
    'different-id': { ...latest, id: 'other-id' },
  }
  for (const [name, value] of Object.entries(invalid)) await t.test(name, async () => {
    const feed = createFeed(async input => {
      const url = String(input)
      if (url.startsWith(localBaseUrl)) return json(url.endsWith('index.json') ? manifest([local]) : local)
      return json(url.endsWith('index.json') ? manifest([latest]) : value)
    })
    const publication = await feed.loadPublication()
    assert.equal(publication.source, 'bundled')
    assert.equal(publication.manifest.datasets[0].id, local.id)
  })
})

test('LP publications refresh after success, retain collection failures, and do not cache an unavailable history', async () => {
  let online = false, current = manifest([dataset('19')])
  const requests: string[] = []
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    if (url.startsWith(historyBaseUrl) && !online) return unavailable()
    if (url.endsWith('index.json')) return json(current)
    return json(url.includes('rank-20') ? dataset() : dataset('19'))
  })
  assert.equal((await feed.loadPublication()).source, 'bundled')
  online = true
  current = manifest([dataset(), dataset('19')])
  current.availability = { status: 'collection-failed', checkedAt: current.generatedAt, message: '直近の取得失敗' }
  const publication = await feed.loadPublication()
  assert.equal(publication.source, 'history')
  assert.equal(publication.manifest.datasets.length, 2)
  assert.equal(publication.manifest.availability?.status, 'collection-failed')
  assert.equal(requests.filter(url => url === `${historyBaseUrl}index.json`).length, 2)
})

test('LP capture failures retry on their selected source and do not fall back per dataset', async () => {
  let previousValid = false
  const latest = dataset(), previous = dataset('19'), requests: string[] = []
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    assert.ok(url.startsWith(historyBaseUrl))
    if (url.endsWith('index.json')) return json(manifest([latest, previous]))
    if (url.includes(previous.id)) return previousValid ? json(previous) : unavailable()
    return json(latest)
  })
  const publication = await feed.loadPublication()
  await assert.rejects(feed.loadDataset(publication, descriptor(previous)), /読み込めません/)
  previousValid = true
  const [a, b] = await Promise.all([feed.loadDataset(publication, descriptor(previous)), feed.loadDataset(publication, descriptor(previous))])
  assert.deepEqual(a, previous)
  assert.equal(a, b)
  await assert.rejects(feed.loadDataset({ ...publication, baseUrl: localBaseUrl }, descriptor(latest)), /取得元が一致/)
  await assert.rejects(feed.loadDataset(publication, { ...descriptor(latest), totalCount: 1 }), /一覧と一致/)
  assert.equal(requests.filter(url => url.includes(previous.id)).length, 2)
})

test('LP latest selection and publication checks compare actual instants across timezone offsets', async () => {
  const earlier = { ...dataset('20'), captureStartedAt: '2026-10-20T10:00:00+09:00', captureEndedAt: '2026-10-20T10:15:00+09:00', generatedAt: '2026-10-20T10:16:00+09:00' }
  const latest = { ...dataset('19'), captureStartedAt: '2026-10-20T02:00:00Z', captureEndedAt: '2026-10-20T02:15:00Z', generatedAt: '2026-10-20T11:16:00+09:00' }
  const requests: string[] = []
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    return json(url.endsWith('index.json') ? manifest([earlier, latest], '2026-10-20T03:00:00Z') : latest)
  })
  assert.equal((await feed.loadPublication()).source, 'history')
  assert.ok(requests[1].includes('rank-19.json'))
  assert.equal(requests.length, 2)
})

test('LP caches do not reuse bodies across sources or corrected publication versions', async () => {
  const original = dataset(), corrected = dataset()
  corrected.entries[0].count += 1
  corrected.entries[1].count -= 1
  let online = true, current = original, generatedAt = '2026-10-21T00:00:00Z'
  const requests: string[] = []
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    if (url.startsWith(historyBaseUrl) && !online) return unavailable()
    const value = url.startsWith(historyBaseUrl) ? current : corrected
    return json(url.endsWith('index.json') ? manifest([value], generatedAt) : value)
  })
  const first = await feed.loadPublication()
  assert.equal((await feed.loadDataset(first, descriptor(original))).entries[0].count, 1)
  online = false
  const bundled = await feed.loadPublication()
  assert.equal((await feed.loadDataset(bundled, descriptor(original))).entries[0].count, 2)
  online = true
  current = corrected
  generatedAt = '2026-10-22T00:00:00Z'
  const updated = await feed.loadPublication()
  assert.equal((await feed.loadDataset(updated, descriptor(original))).entries[0].count, 2)
  assert.equal(requests.filter(url => url.startsWith(historyBaseUrl) && url.includes('snapshots/')).length, 2)
})

test('LP stalled latest body times out, falls back as a publication, and is retried after recovery', async () => {
  const latest = dataset(), local = dataset('19')
  let stalled = true, stalledSignal: AbortSignal | null = null
  const feed = createFeed(async (input, options) => {
    const url = String(input)
    if (url.startsWith(localBaseUrl)) return json(url.endsWith('index.json') ? manifest([local]) : local)
    if (url.endsWith('index.json')) return json(manifest([latest]))
    if (stalled) {
      stalledSignal = options!.signal!
      return { ok: true, json: () => new Promise<unknown>(() => {}) } as Response
    }
    return json(latest)
  }, 10)
  assert.equal((await feed.loadPublication()).source, 'bundled')
  assert.equal((stalledSignal as AbortSignal | null)?.aborted, true)
  stalled = false
  assert.equal((await feed.loadPublication()).source, 'history')
})

test('LP distinguishes unavailable publications from a valid empty manifest and permits later retry', async () => {
  let online = false
  const feed = createFeed(async () => online ? json(manifest([])) : unavailable())
  await assert.rejects(feed.loadPublication(), /ランク分布データを読み込めません/)
  online = true
  const publication = await feed.loadPublication()
  assert.equal(publication.source, 'history')
  assert.equal(publication.manifest.datasets.length, 0)
})
