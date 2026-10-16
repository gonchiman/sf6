import assert from 'node:assert/strict'
import test from 'node:test'
import { collectMrDistribution, mrDistributionPageUrl, MrDistributionCollectionError } from './mr-distribution-collector.ts'
import type { MrDistributionCollectionOptions, MrDistributionPage } from './mr-distribution-collector.ts'

const START = Date.parse('2026-10-16T08:00:00.000Z')
function options(fetchPage: MrDistributionCollectionOptions['fetchPage']): MrDistributionCollectionOptions {
  let clock = 0
  return { fetchPage, maxRequests: 600, now: () => new Date(START + clock++) }
}
function source(config: {
  counts?: number[]; currentCounts?: (request: number) => number[]
  change?: (page: MrDistributionPage, request: number) => MrDistributionPage
} = {}) {
  let requests = 0
  const pages: number[] = []
  return {
    get requests() { return requests }, get pages() { return pages },
    fetchPage: async (pageNumber: number, sourceUrl: string): Promise<MrDistributionPage> => {
      requests++; pages.push(pageNumber)
      const counts = config.currentCounts?.(requests) ?? config.counts ?? Array.from({ length: 26 }, () => 4)
      const totalCount = counts.reduce((sum, value) => sum + value, 0), pageSize = 20
      const offset = (pageNumber - 1) * pageSize
      const entries = Array.from({ length: Math.max(0, Math.min(20, totalCount - offset)) }, (_, i) => {
        let position = offset + i, bin = 25
        while (bin > 0 && position >= counts[bin]) position -= counts[bin--]
        return { masterRating: bin * 100, accountKey: `private-transient-${requests}-${offset + i}` }
      })
      const page = { sourceUrl, page: pageNumber, pageSize, totalCount, totalPages: Math.ceil(totalCount / 20), entries }
      return config.change?.(page, requests) ?? page
    },
  }
}
const rejects = (code: string) => (error: unknown) => error instanceof MrDistributionCollectionError && error.code === code

test('all 25 thresholds and 26 exclusive-upper-bound bins use row positions, retaining ties and only aggregate evidence', async () => {
  const reader = source()
  const progress: number[] = []
  const data = await collectMrDistribution({ ...options(reader.fetchPage), onBoundary: count => { progress.push(count) } })
  assert.equal(data.totalCount, 104)
  assert.deepEqual(data.entries.map(entry => entry.count), Array.from({ length: 26 }, () => 4))
  assert.deepEqual(data.entries.map(entry => entry.maximum), [...Array.from({ length: 25 }, (_, i) => (i + 1) * 100), null])
  assert.deepEqual(data.observation.boundaries.map(entry => entry.countAtOrAbove), Array.from({ length: 25 }, (_, i) => (25 - i) * 4))
  assert.deepEqual(progress, Array.from({ length: 25 }, (_, i) => i + 1))
  assert.equal(data.observation.totalAtStart, 104)
  assert.equal(data.observation.totalAtEnd, 104)
  assert.doesNotMatch(JSON.stringify(data), /private-transient|accountKey|masterRating/)
  assert.equal(reader.pages.at(-2), 1)
  assert.equal(reader.pages.at(-1), 6)
})

test('fresh head/tail observations prove empty bins and zero/all cumulative boundaries, including page edges', async () => {
  const counts = Array.from({ length: 26 }, () => 0)
  counts[5] = 20; counts[15] = 20; counts[20] = 20
  const reader = source({ counts })
  const data = await collectMrDistribution(options(reader.fetchPage))
  assert.deepEqual(data.entries.map(entry => entry.count), counts)
  assert.equal(data.observation.boundaries[0].countAtOrAbove, 60)
  assert.equal(data.observation.boundaries.at(-1)?.countAtOrAbove, 0)
  assert.ok(reader.pages.filter(page => page === 1).length > 1)
  assert.ok(reader.pages.filter(page => page === 3).length > 1)
  assert.ok(reader.requests >= 29)
})

test('changing totals are recorded and new low-MR rows belong only to the bottom bin', async () => {
  const reader = source({ currentCounts: request => [100 + request, ...Array.from({ length: 25 }, () => 4)] })
  const data = await collectMrDistribution(options(reader.fetchPage))
  assert.equal(data.observation.totalAtStart, 201)
  assert.equal(data.observation.totalAtEnd, 200 + reader.requests)
  assert.equal(data.observation.minTotal, 201)
  assert.equal(data.observation.maxTotal, data.totalCount)
  assert.equal(data.entries[0].count, 100 + reader.requests)
  assert.ok(data.entries.slice(1).every(entry => entry.count === 4))
})

test('all thresholds below the final tail share its fresh total and time as a growing listing gains rows', async () => {
  const reader = source({ currentCounts: request => Array.from({ length: 26 }, (_, bin) => bin < 5 || bin === 25 ? 0 : bin === 5 ? 100 + request : 4) })
  const data = await collectMrDistribution(options(reader.fetchPage))
  assert.ok(data.entries.slice(0, 5).every(entry => entry.count === 0))
  const lower = data.observation.boundaries.slice(0, 5)
  assert.ok(lower.every(boundary => boundary.countAtOrAbove === data.totalCount && boundary.totalCount === data.totalCount))
  assert.equal(new Set(lower.map(boundary => boundary.observedAt)).size, 1)
  assert.equal(data.observation.boundaries.at(-1)?.countAtOrAbove, 0)
  assert.equal(data.entries.at(-1)?.count, 0)
  assert.ok(data.observation.maxTotal > data.observation.minTotal)
})

test('a 520,000-row synthetic listing is binary searched within the bounded budget without a full scan', async () => {
  const reader = source({ counts: Array.from({ length: 26 }, () => 20000) })
  const data = await collectMrDistribution(options(reader.fetchPage))
  assert.equal(data.totalCount, 520000)
  assert.ok(reader.requests < 400, `read ${reader.requests} pages`)
  assert.ok(new Set(reader.pages).size < 400)
  assert.ok(reader.pages.some(page => page > 20000))
})

test('a moved boundary is freshly refined while lower bins remain consistent', async () => {
  const initial = Array.from({ length: 26 }, () => 40)
  const moved = [...initial]; moved[0] -= 25; moved[1] += 25
  let moving = false
  const reader = source({ currentCounts: () => moving ? moved : initial,
    change: page => { if (page.page === 51) moving = true; return page } })
  const data = await collectMrDistribution(options(reader.fetchPage))
  assert.deepEqual(data.entries.map(entry => entry.count), moved)
  assert.ok(reader.requests < 250)
})

test('fixed URL rejects old Acts, extra user filters, different characters and duplicate page parameters', () => {
  const valid = mrDistributionPageUrl(100)
  assert.equal(new URL(valid).searchParams.get('page'), '100')
  for (const url of [valid.replace('season_type=1', 'season_type=2'), valid.replace('character_filter=2', 'character_filter=1'),
    `${valid}&user_status=1`, `${valid}&page=2`, valid.replace('www.streetfighter.com', 'example.com')]) {
    assert.throws(() => mrDistributionPageUrl(100, url), rejects('conditions-changed'))
  }
})

test('malformed pages, unknown MR, duplicate private keys and ordering inversions never yield a partial dataset', async () => {
  for (const [kind, code] of [['url', 'conditions-changed'], ['missing', 'invalid-page'], ['negative', 'invalid-page'],
    ['duplicate', 'invalid-page'], ['order', 'observation-changed']] as const) {
    const reader = source({ change: page => {
      if (kind === 'url') page.sourceUrl += '&private=synthetic-secret'
      if (kind === 'missing') page.entries.pop()
      if (kind === 'negative') page.entries[0].masterRating = -1
      if (kind === 'duplicate') page.entries[1].accountKey = page.entries[0].accountKey
      if (kind === 'order') { page.entries[0].masterRating = 1; page.entries[1].masterRating = 99999 }
      return page
    } })
    await assert.rejects(collectMrDistribution(options(reader.fetchPage)), rejects(code))
  }
})

test('changing observations that reverse cumulative thresholds are rejected instead of generating negative bin counts', async () => {
  let late = false
  const reader = source({ currentCounts: () => {
    const counts = Array.from({ length: 26 }, () => 4)
    if (late) counts[25] += 100
    return counts
  } })
  await assert.rejects(collectMrDistribution({ ...options(reader.fetchPage), onBoundary: count => { if (count === 1) late = true } }), rejects('observation-changed'))
})

test('request/time/cancellation bounds and text-bearing transport errors stop before returning a dataset', async () => {
  const reader = source()
  await assert.rejects(collectMrDistribution({ ...options(reader.fetchPage), maxRequests: 2 }), rejects('request-limit'))
  assert.equal(reader.requests, 2)
  let tick = 0
  await assert.rejects(collectMrDistribution({ ...options(source().fetchPage), now: () => new Date(START + tick++ * 1_800_001) }), rejects('time-limit'))
  await assert.rejects(collectMrDistribution({ ...options(source().fetchPage), signal: AbortSignal.abort() }), rejects('cancelled'))
  await assert.rejects(collectMrDistribution(options(async () => { throw new Error('private-cookie-value') })), error =>
    error instanceof MrDistributionCollectionError && error.code === 'page-read-failed' && !error.message.includes('private-cookie-value'))
})
