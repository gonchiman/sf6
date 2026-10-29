import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS, summarizeLegendMr } from './legendAnalysis.ts'
import { createLegendAnalysisFeed } from './legendAnalysisFeed.ts'
import type { LegendAnalysisDataset, LegendAnalysisDescriptor, LegendAnalysisManifest } from '../types/legendAnalysis.ts'

const historyBaseUrl = 'https://history.example/public/'
const localBaseUrl = '/sf6/data/legend-analysis/'
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const unavailable = (): Response => new Response('', { status: 503 })

function dataset(day = '20', mr = 2200): LegendAnalysisDataset {
  const capture = `2026-10-${day}T01:00:00.000Z`
  const summary = summarizeLegendMr([mr])
  return {
    schemaVersion: 1, id: `legend-${day}`, captureStartedAt: capture, captureEndedAt: capture, generatedAt: capture,
    source: { ...LEGEND_ANALYSIS_SOURCE, population: '人工テストの掲載エントリー', metric: 'キャラ構成とMR分布',
      unit: 'account-character', notes: ['人工テスト。'] },
    act: { id: 'act-13', label: 'Act 13' }, definitionVersion: 'legend-listed-v1', membershipRule: 'official-legend-badge',
    conditions: { region: 'all', platform: 'all', characters: 'all', users: 'source-default' }, totalCount: 1,
    characterIds: ['ryu'], characters: [{ characterId: 'ryu', name: 'リュウ', count: 1, mr: summary }], mr: summary,
    validation: { status: 'verified', coverage: 'all-listed-legend-entries', checks: [...LEGEND_ANALYSIS_VALIDATION_CHECKS], notes: ['人工テスト。'] },
  }
}
function descriptor(value: LegendAnalysisDataset): LegendAnalysisDescriptor {
  return { id: value.id, path: `${value.id}.json`, actId: value.act.id, definitionVersion: value.definitionVersion,
    membershipRule: value.membershipRule, conditions: value.conditions, captureStartedAt: value.captureStartedAt,
    captureEndedAt: value.captureEndedAt, totalCount: value.totalCount }
}
function manifest(values = [dataset()], generatedAt = '2026-10-21T00:00:00.000Z'): LegendAnalysisManifest {
  return { schemaVersion: 1, source: LEGEND_ANALYSIS_SOURCE, generatedAt, datasets: values.map(descriptor) }
}
function createFeed(fetchData: typeof fetch, timeoutMs = 500) {
  return createLegendAnalysisFeed({ fetch: fetchData, localBaseUrl, historyBaseUrl, timeoutMs })
}

test('history is preferred, concurrent publication loads share work, and the latest verified body is cached', async () => {
  const latest = dataset('20'), previous = dataset('19'), requests: { url: string; options?: RequestInit }[] = []
  const feed = createFeed(async (input, options) => {
    const url = String(input); requests.push({ url, options })
    assert.ok(url.startsWith(historyBaseUrl))
    return json(url.endsWith('index.json') ? manifest([previous, latest]) : latest)
  })
  const first = feed.loadPublication(), concurrent = feed.loadPublication()
  assert.equal(first, concurrent)
  const publication = await first
  assert.equal(publication.source, 'history')
  assert.equal(publication.baseUrl, historyBaseUrl)
  assert.equal(requests.length, 2)
  assert.ok(requests[1].url.includes('legend-20.json'))
  assert.equal(requests[0].options?.cache, 'no-store')
  for (const request of requests) assert.equal(request.options?.credentials, 'omit')
  assert.deepEqual(await feed.loadDataset(publication, descriptor(latest)), latest)
  assert.equal(requests.length, 2)
})

test('network, HTTP, invalid JSON and invalid manifests fall back to the complete bundled publication', async t => {
  for (const failure of ['network', 'http', 'json', 'schema']) await t.test(failure, async () => {
    const requests: string[] = [], local = dataset('19')
    const feed = createFeed(async input => {
      const url = String(input); requests.push(url)
      if (url.startsWith(historyBaseUrl)) {
        if (failure === 'network') throw new Error('offline')
        if (failure === 'http') return unavailable()
        if (failure === 'json') return new Response('{')
        return json({ ...manifest(), playerIds: ['not-public'] })
      }
      return json(url.endsWith('index.json') ? manifest([local]) : local)
    })
    const publication = await feed.loadPublication()
    assert.equal(publication.source, 'bundled')
    assert.deepEqual(await feed.loadDataset(publication, descriptor(local)), local)
    assert.equal(requests.length, 3)
    assert.ok(requests[2].startsWith(localBaseUrl))
  })
})

test('unavailable or invalid latest history captures cause a whole-publication fallback', async t => {
  for (const failure of ['http', 'descriptor', 'private-field', 'publication-time']) await t.test(failure, async () => {
    const latest = dataset(), local = dataset('19'), requests: string[] = []
    const feed = createFeed(async input => {
      const url = String(input); requests.push(url)
      if (url.startsWith(localBaseUrl)) return json(url.endsWith('index.json') ? manifest([local]) : local)
      if (url.endsWith('index.json')) return json(manifest([latest]))
      if (failure === 'http') return unavailable()
      if (failure === 'descriptor') return json({ ...latest, id: 'other-id' })
      if (failure === 'private-field') return json({ ...latest, playerIds: ['not-public'] })
      return json({ ...latest, generatedAt: '2026-10-22T00:00:00.000Z' })
    })
    const publication = await feed.loadPublication()
    assert.equal(publication.source, 'bundled')
    assert.equal(publication.manifest.datasets[0].id, local.id)
    assert.equal(requests.length, 4)
  })
})

test('later loads refresh the manifest and select new history even if a bundled import has a later generatedAt', async () => {
  const older = dataset('19'), latest = dataset('20'), requests: string[] = []
  let current = manifest([older]), historyAvailable = false
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    if (url.startsWith(localBaseUrl)) return json(url.endsWith('index.json') ? manifest([older], '2026-10-27T00:00:00.000Z') : older)
    if (!historyAvailable) return unavailable()
    if (url.endsWith('index.json')) return json(current)
    return json(url.includes(latest.id) ? latest : older)
  })
  assert.equal((await feed.loadPublication()).source, 'bundled')
  historyAvailable = true
  const history = await feed.loadPublication()
  assert.equal(history.source, 'history')
  current = manifest([latest, older], '2026-10-22T00:00:00.000Z')
  const updated = await feed.loadPublication()
  assert.equal(updated.manifest.datasets[0].id, latest.id)
  assert.equal(requests.filter(url => url === `${historyBaseUrl}index.json`).length, 3)
  assert.equal(requests.filter(url => url === `${localBaseUrl}index.json`).length, 1)
})

test('a valid collection failure retains the available history and does not become a successful zero capture', async () => {
  const latest = dataset(), input = manifest([latest])
  input.availability = { status: 'collection-failed', checkedAt: input.generatedAt, message: '取得失敗' }
  const feed = createFeed(async url => json(String(url).endsWith('index.json') ? input : latest))
  const publication = await feed.loadPublication()
  assert.equal(publication.source, 'history')
  assert.equal(publication.manifest.availability?.status, 'collection-failed')
  assert.equal(publication.manifest.datasets[0].totalCount, 1)
})

test('a previous capture failure stays on its publication source, retries, and never substitutes a bundled body', async () => {
  const latest = dataset(), previous = dataset('19'), requests: string[] = []
  let validPrevious = false
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    assert.ok(url.startsWith(historyBaseUrl))
    if (url.endsWith('index.json')) return json(manifest([latest, previous]))
    if (url.includes(previous.id)) return json(validPrevious ? previous : { ...previous, id: 'wrong-id' })
    return json(latest)
  })
  const publication = await feed.loadPublication()
  await assert.rejects(feed.loadDataset(publication, descriptor(previous)), /一致しません/)
  validPrevious = true
  const [a, b] = await Promise.all([feed.loadDataset(publication, descriptor(previous)), feed.loadDataset(publication, descriptor(previous))])
  assert.deepEqual(a, previous)
  assert.equal(a, b)
  assert.equal(requests.filter(url => url.includes(previous.id)).length, 2)
})

test('dataset caches separate identical capture IDs from different sources and publication versions', async () => {
  const history = dataset('20', 2200), bundled = dataset('20', 2300), requests: string[] = []
  let remoteAvailable = true, generatedAt = '2026-10-21T00:00:00.000Z'
  const feed = createFeed(async input => {
    const url = String(input); requests.push(url)
    if (url.startsWith(historyBaseUrl) && !remoteAvailable) return unavailable()
    const value = url.startsWith(historyBaseUrl) ? history : bundled
    return json(url.endsWith('index.json') ? manifest([value], generatedAt) : value)
  })
  const remote = await feed.loadPublication()
  assert.equal((await feed.loadDataset(remote, descriptor(history))).mr.mean, 2200)
  remoteAvailable = false
  const local = await feed.loadPublication()
  assert.equal((await feed.loadDataset(local, descriptor(bundled))).mr.mean, 2300)
  remoteAvailable = true
  generatedAt = '2026-10-22T00:00:00.000Z'
  await feed.loadPublication()
  assert.equal(requests.filter(url => url.startsWith(historyBaseUrl) && url.includes('legend-20.json')).length, 2)
})

test('unlisted descriptors, changed conditions and changed publication sources cannot issue requests', async () => {
  const latest = dataset(), requests: string[] = []
  const feed = createFeed(async input => {
    requests.push(String(input))
    return json(String(input).endsWith('index.json') ? manifest([latest]) : latest)
  })
  const publication = await feed.loadPublication()
  await assert.rejects(feed.loadDataset(publication, descriptor(dataset('19'))), /一覧と一致/)
  await assert.rejects(feed.loadDataset(publication, { ...descriptor(latest), conditions: { ...latest.conditions, region: 'jp' } }), /一覧と一致/)
  await assert.rejects(feed.loadDataset({ ...publication, baseUrl: 'https://other.example/' }, descriptor(latest)), /取得元が一致/)
  assert.equal(requests.length, 2)
})

test('timeouts cover ignored aborts and stalled body reads, fall back, and permit later history retries', async t => {
  for (const stalled of ['manifest', 'latest-body']) await t.test(stalled, async () => {
    const latest = dataset(), local = dataset('19'), signals: AbortSignal[] = []
    let shouldStall = true
    const feed = createFeed(async (input, options) => {
      const url = String(input)
      if (url.startsWith(localBaseUrl)) return json(url.endsWith('index.json') ? manifest([local]) : local)
      const stall = shouldStall && (stalled === 'manifest' ? url.endsWith('index.json') : !url.endsWith('index.json'))
      if (stall) {
        signals.push(options!.signal!)
        if (stalled === 'manifest') return new Promise<Response>(() => {})
        return { ok: true, json: () => new Promise<unknown>(() => {}) } as Response
      }
      return json(url.endsWith('index.json') ? manifest([latest]) : latest)
    }, 10)
    assert.equal((await feed.loadPublication()).source, 'bundled')
    assert.equal(signals[0].aborted, true)
    shouldStall = false
    assert.equal((await feed.loadPublication()).source, 'history')
  })
})

test('failure of both sources clears the publication request for retry', async () => {
  let available = false
  const latest = dataset()
  const feed = createFeed(async input => available ? json(String(input).endsWith('index.json') ? manifest([latest]) : latest) : unavailable())
  await assert.rejects(feed.loadPublication(), /読み込めません/)
  available = true
  assert.equal((await feed.loadPublication()).source, 'history')
})
