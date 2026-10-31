import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGEND_ANALYSIS_SOURCE } from '../../src/lib/legendAnalysis.ts'
import { collectLegendAnalysisDataset, LegendAnalysisCollectionError } from './legend-analysis-collector.ts'
import type { CollectLegendAnalysisOptions, LegendAnalysisAttemptFailure, LegendAnalysisEntry, LegendAnalysisPage } from './legend-analysis-collector.ts'
import { LEGEND_ANALYSIS_CONDITIONS, LegendAnalysisDomError, legendAnalysisPageUrl } from './legend-analysis-dom.ts'

function fixture(rows?: LegendAnalysisEntry[], pageSize = 2) {
  const values = rows ?? Array.from({ length: 4 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
    characterId: index % 2 ? 'ken' : 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: index < 2 }))
  const requested: number[] = []
  let actChecks = 0
  const options: CollectLegendAnalysisOptions = {
    sourceUrl: LEGEND_ANALYSIS_SOURCE.url, pageUrl: legendAnalysisPageUrl,
    act: { id: 'act-13', label: 'Act 13' }, conditions: { ...LEGEND_ANALYSIS_CONDITIONS }, characterIds: ['ryu', 'ken'],
    characterNames: { ryu: 'リュウ', ken: 'ケン' }, membershipRule: 'official-legend-badge', membershipConfirmed: true,
    now: () => new Date('2026-10-16T00:00:00.000Z'), confirmAct: async () => { actChecks++ },
    fetchPage: async (page, sourceUrl): Promise<LegendAnalysisPage> => {
      requested.push(page)
      return { sourceUrl, page, pageSize, totalCount: values.length, from: (page - 1) * pageSize + 1,
        to: Math.min(page * pageSize, values.length), nextPage: page * pageSize < values.length ? page + 1 : null,
        actId: 'act-13', conditions: { ...LEGEND_ANALYSIS_CONDITIONS }, conditionsConfirmed: true, actConfirmed: true,
        rosterConfirmed: true, entries: structuredClone(values.slice((page - 1) * pageSize, page * pageSize)) }
    },
  }
  return { values, options, requested, actChecks: () => actChecks }
}

function adjacentFixture() {
  return fixture(Array.from({ length: 6 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
    characterId: index % 2 ? 'ken' : 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: index < 4 })))
}
function overlapWith(entry: LegendAnalysisEntry, original: LegendAnalysisEntry): void {
  entry.accountKey = original.accountKey; entry.characterId = original.characterId
}

test('complete capture aggregates account-character entries and rechecks both endpoints', async () => {
  const data = fixture()
  const progress: Array<{ phase: string; attempt: number; page: number | null }> = []
  data.options.onProgress = value => { progress.push(value) }
  // A single account may legitimately have different listed characters.
  data.values[1].accountKey = data.values[0].accountKey
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 2)
  assert.equal(result.dataset.characters[0].count, 1)
  assert.equal(result.dataset.characters[1].count, 1)
  assert.deepEqual(data.requested, [1, 2, 2, 1])
  assert.equal(data.actChecks(), 1)
  assert.deepEqual(progress, [
    { phase: 'listing', attempt: 1, page: 1 }, { phase: 'listing', attempt: 1, page: 2 },
    { phase: 'act-recheck', attempt: 1, page: null }, { phase: 'end-recheck', attempt: 1, page: 2 },
    { phase: 'start-recheck', attempt: 1, page: 1 }, { phase: 'complete', attempt: 1, page: null },
  ])
  assert.equal(JSON.stringify(result).includes('accountKey'), false)
  assert.equal(JSON.stringify(result).includes(data.values[0].accountKey), false)
})

test('opt-in player projection emits only accepted rows once after the final successful retry', async () => {
  const data = fixture()
  data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
  const read = data.options.fetchPage
  let reads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (++reads === 4) value.entries[0].playerName = 'Changed during recheck'
    return value
  }
  const callbacks: unknown[] = []
  data.options.onVerifiedPlayers = rows => { callbacks.push(rows) }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.retryCount, 1)
  assert.deepEqual(callbacks, [[
    { playerName: 'Synthetic 0', playerId: '10000', region: '日本', platform: 'Steam', characterId: 'ryu', rank: 1, masterRating: 2400 },
    { playerName: 'Synthetic 1', playerId: '10001', region: '日本', platform: 'Steam', characterId: 'ken', rank: 2, masterRating: 2399 },
  ]])
  assert.doesNotMatch(JSON.stringify(callbacks), /accountKey|Synthetic 2|Synthetic 3/)
  assert.doesNotMatch(JSON.stringify(result), /Synthetic|playerName|accountKey/)
})

test('opt-in player projection rejects missing names before output and never runs on failed rechecks', async () => {
  for (const scenario of ['missing', 'changed'] as const) {
    const data = fixture()
    data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
    let callbacks = 0
    data.options.onVerifiedPlayers = () => { callbacks++ }
    if (scenario === 'missing') delete data.values[0].playerName
    else {
      const read = data.options.fetchPage
      data.options.fetchPage = async (page, url) => {
        const value = await read(page, url)
        if (data.requested.length % 4 === 0) value.entries[0].playerName = 'Changed during recheck'
        return value
      }
    }
    await assert.rejects(collectLegendAnalysisDataset(data.options), LegendAnalysisCollectionError)
    assert.equal(callbacks, 0)
  }
})

test('opt-in projection requires official player attributes without affecting aggregate-only collection', async () => {
  for (const [field, value] of [['playerId', undefined], ['playerId', 'https://example.com/1'], ['playerId', '1'.repeat(21)],
    ['region', undefined], ['region', ''], ['region', '日本\n'], ['platform', undefined], ['platform', 'Steam\u0000'], ['platform', 'x'.repeat(65)]] as const) {
    const data = fixture()
    data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
    Object.assign(data.values[0], { [field]: value })
    let callbacks = 0
    data.options.onVerifiedPlayers = () => { callbacks++ }
    await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError
      && error.code === 'evidence-unconfirmed' && error.validationCheck === 'entry-values')
    assert.equal(callbacks, 0)
    delete data.options.onVerifiedPlayers
    const aggregate = await collectLegendAnalysisDataset(data.options)
    assert.equal(aggregate.dataset.totalCount, 2)
    assert.doesNotMatch(JSON.stringify(aggregate), /playerId|Synthetic|accountKey|platform":"Steam/)
  }
})

test('Legend cutoff follows displayed badges across tied rank and page boundaries, without a 500 cap', async () => {
  const rows = Array.from({ length: 520 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'), characterId: 'ryu',
    rank: index >= 486 && index < 504 ? 487 : index + 1,
    masterRating: index < 486 ? 3000 - index : index < 504 ? 2183 : 2182 - (index - 504), isLegend: index < 504 }))
  const data = fixture(rows, 20)
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 504)
  assert.equal(result.dataset.mr.min, 2183)
  assert.equal(result.dataset.characters[1].count, 0)
  assert.equal(result.dataset.characters[1].mr.min, null)
  assert.equal(result.pagesRead, 26)
  assert.equal(result.requestCount, 28)
})

test('same account-character duplicate causes bounded capture retry and failure, never deletion', async () => {
  const data = fixture()
  const retries: number[] = []
  data.options.onRetry = count => { retries.push(count) }
  data.values[1] = { ...data.values[0], rank: 2, masterRating: 2399 }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError && error.code === 'duplicate-entry')
  assert.deepEqual(data.requested, [1, 1])
  assert.deepEqual(retries, [1])
})

test('adjacent recovery verifies the previous page and atomically replaces the candidate without losing or duplicating its valid prefix', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage
  let secondReads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    // The first row is valid and must not enter seen/accepted before the later overlap is detected.
    if (page === 2 && ++secondReads === 1) overlapWith(value.entries[1], data.values[1])
    return value
  }
  const events: string[] = []
  data.options.onPageRecovery = state => { events.push(state); throw new Error('diagnostic callback failure') }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.deepEqual(events, ['started', 'succeeded'])
  assert.deepEqual(data.requested, [1, 2, 1, 2, 3, 3, 1])
  assert.equal(result.requestCount, 7); assert.equal(result.pagesRead, 3); assert.equal(result.retryCount, 0)
  assert.equal(result.dataset.totalCount, 4)
  assert.deepEqual(result.dataset.characters.map(row => row.count), [2, 2])
  assert.equal(result.dataset.mr.min, 2397); assert.equal(result.dataset.mr.max, 2400)
  assert.equal(data.actChecks(), 1)
})

test('changed adjacent evidence falls back to a complete attempt and never reports a successful local recovery', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage
  let firstReads = 0, secondReads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 2 && ++secondReads === 1) overlapWith(value.entries[1], data.values[1])
    if (page === 1 && ++firstReads === 2) value.entries[0].masterRating++
    return value
  }
  const events: string[] = [], failures: LegendAnalysisAttemptFailure[] = []
  data.options.onPageRecovery = state => { events.push(state) }
  data.options.onAttemptFailure = failure => { failures.push(failure) }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.retryCount, 1); assert.equal(result.dataset.totalCount, 4)
  assert.deepEqual(events, ['started'])
  assert.deepEqual(data.requested, [1, 2, 1, 1, 2, 3, 3, 1])
  assert.deepEqual(failures, [{ attempt: 1, phase: 'listing', page: 1, code: 'source-changed',
    validationCheck: 'adjacent-recheck', recheckChangeKinds: ['legend-entries'] }])
})

test('persistent overlap gets only one local recovery across complete attempts and never becomes a partial success', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage
  data.options.fetchPage = async (page, url) => { const value = await read(page, url); if (page === 2) overlapWith(value.entries[1], data.values[1]); return value }
  const events: string[] = []
  data.options.onPageRecovery = state => { events.push(state) }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError && error.code === 'duplicate-entry')
  assert.deepEqual(events, ['started'])
  assert.deepEqual(data.requested, [1, 2, 1, 2, 1, 2])
  assert.equal(data.actChecks(), 0)
})

test('earlier-page and within-page overlaps are not eligible for adjacent recovery', async () => {
  for (const kind of ['earlier-page', 'within-page'] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = []
    data.options.onPageRecovery = state => { events.push(state) }
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (kind === 'earlier-page' && page === 3) overlapWith(value.entries[0], data.values[0])
      if (kind === 'within-page' && page === 2) for (const entry of value.entries) overlapWith(entry, data.values[1])
      return value
    }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.code === 'duplicate-entry')
    assert.deepEqual(events, [])
    assert.deepEqual(data.requested, kind === 'earlier-page' ? [1, 2, 3] : [1, 2])
  }
})

test('a recovered page must pass entry-count, ordering and Legend-contiguity checks before success is emitted', async () => {
  for (const mutate of [
    (page: LegendAnalysisPage) => { page.entries.pop() },
    (page: LegendAnalysisPage) => { page.entries[1].masterRating = 9999 },
    (page: LegendAnalysisPage) => { page.entries[0].isLegend = false },
  ]) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = []
    let secondReads = 0
    data.options.onPageRecovery = state => { events.push(state) }
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 2) { if (++secondReads === 1) overlapWith(value.entries[1], data.values[1]); else mutate(value) }
      return value
    }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), LegendAnalysisCollectionError)
    assert.deepEqual(events, ['started'])
    assert.deepEqual(data.requested, [1, 2, 1, 2])
  }
})

test('equal ranks and MR across pages remain valid for distinct account-character identities', async () => {
  const data = adjacentFixture(), events: string[] = []
  data.values.forEach(entry => { entry.rank = 1; entry.masterRating = 2400 })
  data.values[2].accountKey = data.values[1].accountKey // Same account, a different character across pages.
  data.options.onPageRecovery = state => { events.push(state) }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 4)
  assert.deepEqual(events, []); assert.deepEqual(data.requested, [1, 2, 3, 3, 1])
})

test('local recovery preserves global request bounds and immediately propagates cancellation or denied transport', async () => {
  for (const kind of ['budget', 'denied', 'cancelled'] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = [], controller = new AbortController()
    const denied = new LegendAnalysisDomError('http-denied')
    let firstReads = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 2) overlapWith(value.entries[1], data.values[1])
      if (page === 1 && ++firstReads === 2 && kind === 'denied') throw denied
      return value
    }
    data.options.onPageRecovery = state => { events.push(state); if (kind === 'cancelled') controller.abort() }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, signal: controller.signal,
      ...(kind === 'budget' ? { maxRequests: 3 } : {}) }), error => kind === 'denied' ? error === denied
        : error instanceof LegendAnalysisCollectionError && error.code === (kind === 'budget' ? 'request-limit' : 'cancelled'))
    assert.deepEqual(events, ['started'])
    assert.deepEqual(data.requested, kind === 'cancelled' ? [1, 2] : [1, 2, 1])
    assert.equal(data.actChecks(), 0)
  }
})

test('attempt diagnostics preserve the first validation failure when the following attempt fails in transport', async () => {
  const data = fixture(), original = data.options.fetchPage
  const failures: LegendAnalysisAttemptFailure[] = [], retries: number[] = []
  data.options.onAttemptFailure = failure => { failures.push(failure) }
  data.options.onRetry = count => { retries.push(count) }
  let count = 0
  const transportFailure = new Error('private transport response and session')
  data.options.fetchPage = async (page, url) => {
    if (++count === 2) throw transportFailure
    const value = await original(page, url)
    value.entries[1].accountKey = value.entries[0].accountKey
    value.entries[1].characterId = value.entries[0].characterId
    return value
  }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error === transportFailure)
  assert.deepEqual(retries, [1])
  assert.deepEqual(failures, [{ attempt: 1, phase: 'listing', page: 1, code: 'duplicate-entry',
    validationCheck: 'duplicate-entry', recheckChangeKinds: null }])
  assert.doesNotMatch(JSON.stringify(failures), /accountKey|profile|private transport|session/)
})

test('attempt diagnostics report each failed recheck without changing bounded retries', async () => {
  const data = fixture(), original = data.options.fetchPage
  const failures: LegendAnalysisAttemptFailure[] = [], retries: number[] = []
  data.options.onAttemptFailure = failure => { failures.push(failure) }
  data.options.onRetry = count => { retries.push(count) }
  let count = 0
  data.options.fetchPage = async (page, url) => {
    const value = await original(page, url)
    if (++count % 3 === 0) value.entries[0].masterRating++
    return value
  }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError
    && error.code === 'source-changed' && error.validationCheck === 'end-recheck')
  assert.deepEqual(retries, [1])
  assert.deepEqual(data.requested, [1, 2, 2, 1, 2, 2])
  assert.deepEqual(failures, [1, 2].map(attempt => ({ attempt, phase: 'end-recheck', page: 2,
    code: 'source-changed', validationCheck: 'end-recheck', recheckChangeKinds: ['non-legend-entries'] })))
})

test('successful retry retains failure evidence and a diagnostic callback cannot replace collection errors', async () => {
  const data = fixture(), original = data.options.fetchPage
  const failures: LegendAnalysisAttemptFailure[] = []
  data.options.onAttemptFailure = failure => { failures.push(failure); throw new Error('diagnostic output failed') }
  let count = 0
  data.options.fetchPage = async (page, url) => {
    const value = await original(page, url)
    if (++count === 1) value.entries[1].masterRating = 9999
    return value
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.retryCount, 1)
  assert.deepEqual(failures, [{ attempt: 1, phase: 'listing', page: 1, code: 'source-changed',
    validationCheck: 'mr-order', recheckChangeKinds: null }])
  assert.equal(result.dataset.totalCount, 2)
})

test('attempt diagnostics allow only enum fields even on a deliberately malformed collection error', async () => {
  const data = fixture()
  const secret = 'synthetic-player-token-url'
  const malformed = Object.assign(new LegendAnalysisCollectionError('read-failed'), {
    code: secret, validationCheck: secret, recheckChangeKinds: [secret], playerName: secret, sourceUrl: secret,
  })
  const failures: LegendAnalysisAttemptFailure[] = []
  data.options.fetchPage = async () => { throw malformed }
  data.options.onAttemptFailure = failure => { failures.push(failure) }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error === malformed)
  assert.deepEqual(failures, [{ attempt: 1, phase: 'listing', page: 1, code: 'read-failed',
    validationCheck: 'unclassified', recheckChangeKinds: null }])
  assert.equal(JSON.stringify(failures).includes(secret), false)
})

test('fixed checks distinguish first rank, row position, rank order and MR order without changing rejection', async () => {
  const cases = [
    { check: 'first-rank', page: 1, mutate: (value: LegendAnalysisPage) => { value.entries[0].rank = 2 } },
    { check: 'rank-position', page: 1, mutate: (value: LegendAnalysisPage) => { value.entries[1].rank = 3 } },
    { check: 'rank-order', page: 2, mutate: (value: LegendAnalysisPage) => { value.entries[0].rank = 1 } },
    { check: 'mr-order', page: 2, mutate: (value: LegendAnalysisPage) => { value.entries[0].masterRating = 9999 } },
  ]
  for (const item of cases) {
    const data = fixture(), read = data.options.fetchPage
    data.options.fetchPage = async (page, url) => { const value = await read(page, url); if (page === item.page) item.mutate(value); return value }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error =>
      error instanceof LegendAnalysisCollectionError && error.code === 'source-changed' && error.validationCheck === item.check && error.recheckChangeKinds === undefined)
  }
})

test('metadata, entry validation, duplicate and Legend continuity failures have fixed checks', async () => {
  const cases = [
    { check: 'page-identity', mutate: (page: LegendAnalysisPage) => { page.page++ } },
    { check: 'source-conditions', mutate: (page: LegendAnalysisPage) => { page.conditionsConfirmed = false } },
    { check: 'source-act', mutate: (page: LegendAnalysisPage) => { page.actId = 'act-12' } },
    { check: 'source-roster', mutate: (page: LegendAnalysisPage) => { page.rosterConfirmed = false } },
    { check: 'page-size', mutate: (page: LegendAnalysisPage) => { page.pageSize = 0 } },
    { check: 'pagination', mutate: (page: LegendAnalysisPage) => { page.from++ } },
    { check: 'entry-count', mutate: (page: LegendAnalysisPage) => { page.entries.pop() } },
    { check: 'entry-values', mutate: (page: LegendAnalysisPage) => { page.entries[0].masterRating = -1 } },
    { check: 'character-roster', mutate: (page: LegendAnalysisPage) => { page.entries[0].characterId = 'unknown' } },
    { check: 'duplicate-entry', mutate: (page: LegendAnalysisPage) => { page.entries[1].accountKey = page.entries[0].accountKey; page.entries[1].characterId = page.entries[0].characterId } },
    { check: 'legend-contiguity', mutate: (page: LegendAnalysisPage) => { page.entries[0].isLegend = false } },
    { check: 'legend-presence', mutate: (page: LegendAnalysisPage) => { page.entries.forEach(entry => { entry.isLegend = false }) } },
  ]
  for (const item of cases) {
    const data = fixture(), read = data.options.fetchPage
    data.options.fetchPage = async (page, url) => { const value = await read(page, url); item.mutate(value); return value }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error =>
      error instanceof LegendAnalysisCollectionError && error.validationCheck === item.check)
  }
})

test('recheck mismatch kinds distinguish private Legend rows, non-Legend rows and metadata using enum lists only', async () => {
  for (const legendChanged of [false, true]) {
    const data = fixture(), read = data.options.fetchPage
    const seen = new Map<number, number>()
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url), count = (seen.get(page) ?? 0) + 1; seen.set(page, count)
      if (count === 2 && page === (legendChanged ? 1 : 2)) value.entries[0].masterRating++
      return value
    }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => {
      assert.ok(error instanceof LegendAnalysisCollectionError)
      assert.equal(error.validationCheck, legendChanged ? 'start-recheck' : 'end-recheck')
      assert.deepEqual(error.recheckChangeKinds, [legendChanged ? 'legend-entries' : 'non-legend-entries'])
      assert.equal(JSON.stringify(error).includes(data.values[0].accountKey), false)
      return true
    })
  }
  const data = fixture([{ accountKey: '1'.padStart(64, '0'), characterId: 'ryu', rank: 1, masterRating: 2400, isLegend: true }]), read = data.options.fetchPage
  let count = 0
  data.options.fetchPage = async (page, url) => { const value = await read(page, url); if (++count === 2) value.pageSize = 3; return value }
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error =>
    error instanceof LegendAnalysisCollectionError && error.validationCheck === 'end-recheck' && JSON.stringify(error.recheckChangeKinds) === JSON.stringify(['metadata']))
})

test('changed first page on recheck fails after finite retries', async () => {
  const data = fixture()
  const original = data.options.fetchPage
  let firstReads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await original(page, url)
    if (page === 1 && ++firstReads % 2 === 0) value.entries[0].masterRating++
    return value
  }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError && error.code === 'source-changed')
  assert.equal(data.requested.length, 8)
})

test('changing global MASTER population does not invalidate an unchanged Legend prefix', async () => {
  const data = fixture(), original = data.options.fetchPage
  let extra = 0
  data.options.fetchPage = async (page, url) => {
    const value = await original(page, url)
    value.totalCount = 800000 + extra++
    value.nextPage = page + 1
    return value
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 2)
  assert.equal(result.requestCount, 4)
})

test('missing membership evidence, request limits and cancellation fail closed', async () => {
  const data = fixture()
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, membershipConfirmed: false }), /evidence-unconfirmed/)
  assert.equal(data.requested.length, 0)
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxRequests: 3 }), /request-limit/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, signal: controller.signal }), /cancelled/)
})

test('invalid condition, Act, character and reversed ordering are rejected', async () => {
  for (const mutate of [
    (page: LegendAnalysisPage) => { page.conditions.platform = 'different' },
    (page: LegendAnalysisPage) => { page.actId = 'act-12' },
    (page: LegendAnalysisPage) => { page.entries[0].characterId = 'unknown' },
    (page: LegendAnalysisPage) => { page.entries[1].masterRating = 9999 },
    (page: LegendAnalysisPage) => { page.entries[0].isLegend = false },
    (page: LegendAnalysisPage) => { page.nextPage = null },
  ]) {
    const data = fixture(), original = data.options.fetchPage
    data.options.fetchPage = async (page, url) => { const value = await original(page, url); mutate(value); return value }
    await assert.rejects(collectLegendAnalysisDataset(data.options))
  }
})
