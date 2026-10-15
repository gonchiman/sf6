import assert from 'node:assert/strict'
import test from 'node:test'
import { collectRankDistributionEstimate } from './rank-distribution-estimate.ts'
import type { RankDistributionEstimateOptions } from './rank-distribution-estimate.ts'
import { RankDistributionCollectionError } from './rank-distribution-collector.ts'
import { RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'
import type { RankBoundaryPage } from './rank-distribution-boundaries.ts'
import type { RankDistributionCheckpoint } from './rank-distribution-checkpoint.ts'

const evidence = { status: 'confirmed' as const, sourceUrl: RANK_BOUNDARY_SOURCE_URL, note: '人工テスト専用の確認根拠。' }
const start = Date.parse('2026-10-15T08:00:00Z')
function options(fetchPage: RankDistributionEstimateOptions['fetchPage']): RankDistributionEstimateOptions {
  let clock = 0
  return {
    fetchPage, currentMappingEvidence: evidence, maxLpAccountUnitEvidence: evidence, unrankedTailEvidence: evidence,
    now: () => new Date(start + clock++ * 1000), maxRequests: 1000,
  }
}

function reader(configuration: {
  counts?: number[]
  currentCounts?: (request: number) => number[]
  change?: (page: RankBoundaryPage, request: number) => RankBoundaryPage
} = {}) {
  let requests = 0
  const pages: number[] = []
  const fixedCounts = configuration.counts ?? Array.from({ length: 36 }, () => 4)
  return {
    fetchPage: async (pageNumber: number, sourceUrl: string): Promise<RankBoundaryPage> => {
      requests++
      pages.push(pageNumber)
      const counts = configuration.currentCounts?.(requests) ?? fixedCounts
      const totalCount = counts.reduce((sum, count) => sum + count, 0)
      const pageSize = 20
      const offset = (pageNumber - 1) * pageSize
      const entries = Array.from({ length: Math.max(0, Math.min(pageSize, totalCount - offset)) }, (_, index) => {
        let position = offset + index
        let rankId = 36
        while (rankId > 1 && position >= counts[rankId - 1]) position -= counts[--rankId]
        return {
          rankId, leaguePoint: totalCount - offset - index,
          // Intentionally changes at every read, as identities do not define the boundary.
          accountKey: `private-identity-${requests}-${offset + index}`,
        }
      })
      const result = { sourceUrl, page: pageNumber, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize), entries }
      return configuration.change?.(result, requests) ?? result
    },
    get requests() { return requests },
    get pages() { return pages },
  }
}

function errorCode(code: string) {
  return (error: unknown): boolean => error instanceof RankDistributionCollectionError && error.code === code
}

function checkpoint(counts = Array.from({ length: 36 }, () => 4), rankIds = Array.from({ length: 35 }, (_, index) => index + 2)): RankDistributionCheckpoint {
  const totalCount = counts.reduce((sum, count) => sum + count, 0)
  return {
    schemaVersion: 1, method: 'boundary-search-estimate', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
    pageSize: 20, savedAt: new Date(start - 1000).toISOString(),
    hints: rankIds.map(rankId => ({ rankId, countAtOrAbove: counts.slice(rankId - 1).reduce((sum, count) => sum + count, 0),
      totalCount, observedAt: new Date(start - 2000).toISOString() })),
  }
}

test('observes every boundary and emits aggregate-only interval estimates', async () => {
  const source = reader()
  const progress: number[] = []
  const result = await collectRankDistributionEstimate({ ...options(source.fetchPage), onBoundary: count => { progress.push(count) } })
  assert.equal(result.method, 'boundary-search-estimate')
  assert.equal(result.validation.status, 'estimated')
  assert.equal(result.validation.coverage, 'all-rank-boundaries')
  assert.equal(result.entries.length, 36)
  assert.deepEqual(result.entries.map(entry => entry.count), Array.from({ length: 36 }, () => 4))
  assert.ok('observation' in result)
  const observation = result.observation!
  assert.deepEqual(observation.boundaries.map(boundary => boundary.rankId), Array.from({ length: 35 }, (_, index) => index + 2))
  assert.ok(observation.boundaries.every(boundary => boundary.observedAt >= result.captureStartedAt && boundary.observedAt <= result.captureEndedAt))
  assert.equal(observation.totalAtStart, 144)
  assert.equal(observation.totalAtEnd, 144)
  assert.ok(result.validation.checks.includes('changes-recorded'))
  assert.ok(!result.validation.checks.includes('total-count-stable'))
  assert.deepEqual(progress, Array.from({ length: 35 }, (_, index) => index + 1))
  assert.doesNotMatch(JSON.stringify(result), /private-identity|accountKey|leaguePoint/)
})

test('accepts changing totals and within-rank identities while recording every observed total', async () => {
  const source = reader({ currentCounts: request => [100 + request, ...Array.from({ length: 35 }, () => 4)] })
  const result = await collectRankDistributionEstimate(options(source.fetchPage))
  assert.ok('observation' in result)
  const observation = result.observation!
  assert.equal(observation.totalAtStart, 241)
  assert.equal(observation.totalAtEnd, 240 + source.requests)
  assert.equal(observation.minTotal, 241)
  assert.equal(observation.maxTotal, observation.totalAtEnd)
  assert.equal(result.totalCount, observation.totalAtEnd)
  assert.equal(result.entries.reduce((sum, entry) => sum + entry.count, 0), result.totalCount)
  assert.equal(result.entries[0].count, 100 + source.requests)
  assert.ok(result.entries.slice(1).every(entry => entry.count === 4))
})

test('uses bounded local refinement when an old hint moved', async () => {
  const initial = Array.from({ length: 36 }, () => 40)
  const moved = [...initial]
  moved[0] -= 5
  moved[1] += 5
  let moving = false
  let boundaryPageReads = 0
  const source = reader({
    currentCounts: () => moving ? moved : initial,
    change: page => {
      if (page.page === 71) { boundaryPageReads++; moving = true }
      return page
    },
  })
  const result = await collectRankDistributionEstimate(options(source.fetchPage))
  assert.deepEqual(result.entries.map(entry => entry.count), moved)
  assert.ok(boundaryPageReads >= 3, 'The stale hint must be disproved, locally refined and freshly confirmed')
  assert.ok(source.requests < 250)
})

test('handles empty ranks and boundaries on page edges without fabricating missing observations', async () => {
  const counts = Array.from({ length: 36 }, () => 0)
  counts[0] = 20
  counts[10] = 20
  counts[35] = 20
  const source = reader({ counts })
  const result = await collectRankDistributionEstimate(options(source.fetchPage))
  assert.deepEqual(result.entries.map(entry => entry.count), counts)
  assert.ok('observation' in result)
  assert.equal(result.observation!.boundaries.length, 35)
  assert.ok(source.requests >= 35)
})

test('follows the true final page when the page count grows during the ending check', async () => {
  let ending = false
  let endingReads = 0
  const source = reader({ currentCounts: () => {
    if (!ending) return Array.from({ length: 36 }, () => 4)
    endingReads++
    return [endingReads === 1 ? 20 : 41, ...Array.from({ length: 35 }, () => 4)]
  } })
  const result = await collectRankDistributionEstimate({ ...options(source.fetchPage), onBoundary: count => { if (count === 35) ending = true } })
  assert.equal(result.totalCount, 181)
  assert.equal(source.pages.at(-1), 10)
  assert.ok('observation' in result)
  assert.equal(result.observation!.totalAtEnd, 181)
  assert.equal(result.entries[0].count, 41)
})

test('searches a three-million-row virtual population without enumerating it', async t => {
  const counts = Array.from({ length: 36 }, () => 80_000)
  counts[35] += 180_715
  const source = reader({ counts })
  const result = await collectRankDistributionEstimate(options(source.fetchPage))
  assert.equal(result.totalCount, 3_060_715)
  assert.deepEqual(result.entries.map(entry => entry.count), counts)
  assert.ok(source.requests < 600, `Read ${source.requests} pages`)
  assert.ok(new Set(source.pages).size < 500)
  t.diagnostic(`Synthetic only: ${source.requests} page reads for ${result.totalCount} accounts and all 35 boundaries`)
})

test('rejects unknown ranks, row ordering violations, missing rows and within-page duplicates', async () => {
  const cases: Array<{ code: string; change: (page: RankBoundaryPage) => RankBoundaryPage }> = [
    { code: 'unknown-rank', change: page => ({ ...page, entries: [{ ...page.entries[0], rankId: 0 }, ...page.entries.slice(1)] }) },
    { code: 'observation-changed', change: page => ({ ...page, entries: [{ ...page.entries[0], leaguePoint: 0 }, ...page.entries.slice(1)] }) },
    { code: 'observation-changed', change: page => ({ ...page, entries: [{ ...page.entries[0], rankId: 1 }, ...page.entries.slice(1)] }) },
    { code: 'invalid-page', change: page => ({ ...page, entries: page.entries.slice(1) }) },
    { code: 'invalid-page', change: page => ({ ...page, entries: page.entries.map((entry, index) => ({ ...entry, accountKey: index < 2 ? 'duplicate-private' : entry.accountKey })) }) },
  ]
  for (const item of cases) {
    const source = reader({ change: item.change })
    await assert.rejects(collectRankDistributionEstimate(options(source.fetchPage)), errorCode(item.code))
  }
})

test('rejects changed conditions, page layout, and unverified evidence', async () => {
  const changedUrl = reader({ change: page => ({ ...page, sourceUrl: page.sourceUrl.replace('platform=1', 'platform=2') }) })
  await assert.rejects(collectRankDistributionEstimate(options(changedUrl.fetchPage)), errorCode('conditions-changed'))
  const wrongPages = reader({ change: page => ({ ...page, totalPages: page.totalPages + 1 }) })
  await assert.rejects(collectRankDistributionEstimate(options(wrongPages.fetchPage)), errorCode('invalid-page'))
  const source = reader()
  await assert.rejects(collectRankDistributionEstimate({ ...options(source.fetchPage), currentMappingEvidence: { ...evidence, status: 'unconfirmed' } as never }), errorCode('evidence-unconfirmed'))
  assert.equal(source.requests, 0)
})

test('rejects boundaries that cross or exceed the end total instead of normalizing counts', async () => {
  const normal = Array.from({ length: 36 }, () => 40)
  let switched = false
  const smaller = [...normal]
  smaller[0] = 0
  smaller[1] = 0
  smaller[2] += 80
  // The rank-3 cumulative boundary moves above the previously observed rank-2 boundary.
  const source = reader({
    currentCounts: () => switched ? smaller : normal,
  })
  // A large decrease at the very end must also be rejected if old boundaries no longer fit.
  let shrinking = false
  const tailShrink = reader({ currentCounts: () => shrinking ? [...Array.from({ length: 35 }, () => 0), 10] : normal })
  await assert.rejects(collectRankDistributionEstimate({ ...options(tailShrink.fetchPage), onBoundary: count => { if (count === 35) shrinking = true } }), errorCode('observation-changed'))
  await assert.rejects(collectRankDistributionEstimate({ ...options(source.fetchPage), onBoundary: count => { if (count === 1) switched = true } }), errorCode('observation-changed'))
})

test('honors request limits and cancellation and never returns a partial dataset', async () => {
  const source = reader()
  await assert.rejects(collectRankDistributionEstimate({ ...options(source.fetchPage), maxRequests: 2 }), errorCode('request-limit'))
  assert.equal(source.requests, 2)
  const controller = new AbortController()
  controller.abort()
  const untouched = reader()
  await assert.rejects(collectRankDistributionEstimate({ ...options(untouched.fetchPage), signal: controller.signal }), errorCode('cancelled'))
  assert.equal(untouched.requests, 0)
})

test('replaces transport errors with fixed safe errors and validates monotonic capture times', async () => {
  await assert.rejects(collectRankDistributionEstimate(options(async () => { throw new Error('private-cookie-secret-player') })), error => {
    assert.ok(error instanceof RankDistributionCollectionError)
    assert.equal(error.code, 'page-read-failed')
    assert.doesNotMatch(error.message, /private-cookie-secret-player/)
    assert.equal(error.cause, undefined)
    return true
  })
  const source = reader()
  let clock = 0
  await assert.rejects(collectRankDistributionEstimate({ ...options(source.fetchPage), now: () => new Date(start - clock++) }), errorCode('invalid-time'))
})

test('saved boundary positions shorten a large search while all 35 boundaries receive new observations', async () => {
  const counts = Array.from({ length: 36 }, () => 80_000)
  counts[35] += 180_715
  const saved = checkpoint(counts)
  const source = reader({ counts })
  const progress: number[] = []
  const snapshots: RankDistributionCheckpoint[] = []
  const result = await collectRankDistributionEstimate({ ...options(source.fetchPage), checkpoint: saved,
    onBoundary: count => { progress.push(count) }, onCheckpoint: value => { snapshots.push(value) } })
  assert.deepEqual(result.entries.map(entry => entry.count), counts)
  assert.ok(source.requests < 150, `Used ${source.requests} fresh reads, not the complete binary search`)
  assert.ok(source.requests >= 39, 'Every boundary still requires at least one fresh read plus terminal checks')
  assert.deepEqual(progress, Array.from({ length: 35 }, (_, index) => index + 1))
  assert.equal(snapshots.length, 35)
  assert.ok(snapshots.every(value => value.hints.length === 35))
  assert.ok(result.observation!.boundaries.every(boundary => Date.parse(boundary.observedAt) >= start))
  assert.ok(result.observation!.boundaries.every(boundary => !saved.hints.some(hint => hint.observedAt === boundary.observedAt)))
  assert.equal(result.captureStartedAt, new Date(start).toISOString())
  assert.doesNotMatch(JSON.stringify(snapshots), /private-identity|accountKey|leaguePoint|entries/)
})

test('a stale saved position is disproved and refined rather than accepted as a current boundary', async () => {
  const oldCounts = Array.from({ length: 36 }, () => 40)
  const counts = [...oldCounts]
  counts[0] -= 5
  counts[1] += 5
  const source = reader({ counts })
  const old = checkpoint(oldCounts)
  const result = await collectRankDistributionEstimate({ ...options(source.fetchPage), checkpoint: old })
  assert.deepEqual(result.entries.map(entry => entry.count), counts)
  assert.notEqual(result.observation!.boundaries[0].countAtOrAbove, old.hints[0].countAtOrAbove)
  assert.ok(source.pages.filter(page => page === 71).length >= 2)
  assert.ok(result.observation!.boundaries.every(boundary => Date.parse(boundary.observedAt) >= start))
})

test('missing hint ranks run first and snapshots preserve old hints while replacing only freshly confirmed records', async () => {
  const old = checkpoint(undefined, [2, 3, 4])
  const source = reader()
  const snapshots: RankDistributionCheckpoint[] = []
  const result = await collectRankDistributionEstimate({ ...options(source.fetchPage), checkpoint: old,
    onCheckpoint: async value => { snapshots.push(value) } })
  assert.equal(snapshots[0].hints.length, 4)
  assert.equal(snapshots[0].hints.find(hint => Date.parse(hint.observedAt) >= start)!.rankId, 5)
  for (const hint of old.hints) assert.deepEqual(snapshots[0].hints.find(value => value.rankId === hint.rankId), hint)
  assert.equal(snapshots[31].hints.length, 35)
  assert.equal(snapshots[31].hints.filter(hint => Date.parse(hint.observedAt) < start).length, 3)
  assert.ok(snapshots.at(-1)!.hints.every(hint => Date.parse(hint.observedAt) >= start))
  assert.deepEqual(result.observation!.boundaries.map(boundary => boundary.rankId), Array.from({ length: 35 }, (_, index) => index + 2))
  assert.equal(result.observation!.boundaries[0].observedAt, snapshots[32].hints.find(hint => hint.rankId === 2)!.observedAt)
  assert.deepEqual(result.entries.map(entry => entry.count), Array.from({ length: 36 }, () => 4))
})

test('interrupted captures grow durable search hints and a new capture rechecks every boundary', async () => {
  let saved: RankDistributionCheckpoint | undefined
  for (let capture = 0; capture < 3; capture++) {
    const source = reader()
    const controller = new AbortController()
    let confirmed = 0
    let clock = 0
    await assert.rejects(collectRankDistributionEstimate({ ...options(source.fetchPage), checkpoint: saved,
      now: () => new Date(start + capture * 60_000 + clock++ * 1000),
      signal: controller.signal, onBoundary: () => { confirmed++; if (confirmed === 2) controller.abort() },
      onCheckpoint: value => { saved = value },
    }), errorCode('cancelled'))
    assert.equal(saved!.hints.length, (capture + 1) * 2)
  }
  const source = reader()
  const progress: number[] = []
  let clock = 0
  const result = await collectRankDistributionEstimate({ ...options(source.fetchPage), checkpoint: saved,
    now: () => new Date(start + 3 * 60_000 + clock++ * 1000),
    onBoundary: count => { progress.push(count) } })
  assert.equal(result.observation!.boundaries.length, 35)
  assert.deepEqual(progress, Array.from({ length: 35 }, (_, index) => index + 1))
  assert.ok(result.observation!.boundaries.every(boundary => Date.parse(boundary.observedAt) >= start + 3 * 60_000))
})

test('checkpoint callbacks receive isolated aggregate copies and their raw failures are sanitized', async () => {
  const source = reader()
  const result = await collectRankDistributionEstimate({ ...options(source.fetchPage), onCheckpoint: value => {
    value.hints[0].countAtOrAbove = Number.MAX_SAFE_INTEGER
  } })
  assert.deepEqual(result.entries.map(entry => entry.count), Array.from({ length: 36 }, () => 4))
  const failing = reader()
  await assert.rejects(collectRankDistributionEstimate({ ...options(failing.fetchPage), onCheckpoint: async () => {
    throw new Error('private-cookie-checkpoint-write-error')
  } }), error => {
    assert.ok(error instanceof RankDistributionCollectionError)
    assert.equal(error.code, 'collection-rejected')
    assert.doesNotMatch(String(error), /private-cookie/)
    assert.equal(error.cause, undefined)
    return true
  })
})

test('invalid, future or incompatible checkpoints never become current confirmations', async () => {
  for (const value of [
    { ...checkpoint(), sourceUrl: 'https://example.com/private' },
    { ...checkpoint(), savedAt: new Date(start + 1000).toISOString() },
    { ...checkpoint(), privateRows: ['private'] },
    { ...checkpoint(), hints: [{ ...checkpoint().hints[0], accountKey: 'private' }] },
  ]) {
    const source = reader()
    await assert.rejects(collectRankDistributionEstimate({ ...options(source.fetchPage), checkpoint: value as RankDistributionCheckpoint }), errorCode('invalid-options'))
    assert.equal(source.requests, 0)
  }
  const source = reader()
  await assert.rejects(collectRankDistributionEstimate({ ...options(source.fetchPage), checkpoint: { ...checkpoint(), pageSize: 10 } }), errorCode('invalid-page'))
  assert.equal(source.requests, 1)
  const capped = reader()
  await assert.rejects(collectRankDistributionEstimate({ ...options(capped.fetchPage), checkpoint: checkpoint(), maxRequests: 2 }), errorCode('request-limit'))
  assert.equal(capped.requests, 2)
})
