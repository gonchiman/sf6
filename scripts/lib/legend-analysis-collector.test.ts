import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGEND_ANALYSIS_SOURCE } from '../../src/lib/legendAnalysis.ts'
import { collectLegendAnalysisDataset, LegendAnalysisCollectionError } from './legend-analysis-collector.ts'
import type { CollectLegendAnalysisOptions, LegendAnalysisAttemptFailure, LegendAnalysisEntry, LegendAnalysisPage } from './legend-analysis-collector.ts'
import { LEGEND_ANALYSIS_CONDITIONS, LegendAnalysisDomError, legendAnalysisPageUrl } from './legend-analysis-dom.ts'
import type { LegendOrderRecheck } from './legend-order-diagnostics.ts'

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
    validationCheck: 'mr-order', recheckChangeKinds: null, orderDiagnostic: { boundary: 'within-page',
      previous: { page: 1, rowIndex: 1, rank: 1, masterRating: 2400 },
      current: { page: 1, rowIndex: 2, rank: 2, masterRating: 9999 },
      sameEntry: false, duplicateInAccepted: false, duplicateWithinCurrentPage: false } }])
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

test('order diagnostics report the first violating pair and duplicate identity flags without private data', async () => {
  for (const check of ['rank-order', 'mr-order'] as const) {
    for (const boundary of ['within-page', 'between-pages'] as const) {
      const data = adjacentFixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = []
      const failingPage = boundary === 'within-page' ? 2 : 3
      data.options.onAttemptFailure = value => { failures.push(value) }
      data.options.fetchPage = async (page, url) => {
        const value = await read(page, url)
        if (page === failingPage) {
          const index = boundary === 'within-page' ? 1 : 0
          const previous = boundary === 'within-page' ? value.entries[0] : data.values[3]
          const current = value.entries[index]
          overlapWith(current, previous)
          current.playerName = 'secret-player-name'; current.playerId = 'secret-player-id'
          if (check === 'rank-order') current.rank = previous.rank - 1
          else current.masterRating = previous.masterRating + 1
          // A later row would also fail, but the first pair must remain the recorded one.
          if (index === 0) value.entries[1].masterRating = 9999
        }
        return value
      }
      await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error =>
        error instanceof LegendAnalysisCollectionError && error.validationCheck === check)
      assert.equal(failures.length, 1)
      const previous = data.values[boundary === 'within-page' ? 2 : 3]
      assert.deepEqual(failures[0].orderDiagnostic, {
        boundary,
        previous: { page: 2, rowIndex: boundary === 'within-page' ? 1 : 2, rank: previous.rank, masterRating: previous.masterRating },
        current: { page: failingPage, rowIndex: boundary === 'within-page' ? 2 : 1,
          rank: check === 'rank-order' ? previous.rank - 1 : boundary === 'within-page' ? 4 : 5,
          masterRating: check === 'mr-order' ? previous.masterRating + 1 : boundary === 'within-page' ? 2397 : 2396 },
        sameEntry: true, duplicateInAccepted: boundary === 'between-pages', duplicateWithinCurrentPage: boundary === 'within-page',
      })
      assert.doesNotMatch(JSON.stringify(failures), /accountKey|characterId|playerName|playerId|secret|https?:/)
      assert.equal(JSON.stringify(failures).includes(previous.accountKey), false)
    }
  }
})

test('rank and MR ties inside and across pages require no order recheck', async () => {
  const data = adjacentFixture()
  data.values.forEach(entry => { entry.rank = 1; entry.masterRating = 2400 })
  let rechecks = 0
  data.options.recheckOrderFailure = async () => { rechecks++; return { status: 'unavailable', elapsedMs: 1000 } }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 4)
  assert.equal(rechecks, 0)
})

test('a resolved order reread is diagnostic only and the entire capture still retries', async () => {
  const data = fixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], events: string[] = []
  data.options.fetchPage = async (page, url) => {
    events.push(`read-${page}`)
    const value = await read(page, url)
    if (data.requested.length === 1) value.entries[1].masterRating = 2401
    return value
  }
  const recheck: LegendOrderRecheck = { status: 'observed', elapsedMs: 1000, page: 1, from: 1, to: 2, totalCount: 4,
    sameEntries: true, sameRanksAndMr: false, previous: { rank: 1, masterRating: 2400 }, current: { rank: 2, masterRating: 2399 },
    currentSameEntry: true, previousSameEntry: true, rankInversionWithinPage: false, mrInversionWithinPage: false }
  data.options.recheckOrderFailure = async (page, rowIndex) => {
    events.push('reread')
    assert.equal(page.page, 1); assert.equal(rowIndex, 2); assert.equal(page.entries[1].masterRating, 2401)
    return recheck
  }
  data.options.onAttemptFailure = value => { failures.push(value); events.push('failure') }
  data.options.onRetry = () => { events.push('retry') }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.retryCount, 1)
  assert.equal(result.requestCount, 5)
  assert.deepEqual(events, ['read-1', 'reread', 'failure', 'retry', 'read-1', 'read-2', 'read-2', 'read-1'])
  assert.deepEqual(failures[0].orderRecheck, recheck)
  assert.equal(failures[0].orderDiagnostic?.current.masterRating, 2401)
  assert.equal(result.dataset.mr.max, 2400)
})

test('persistent inversions reread once per attempt with a maximum of three attempts', async () => {
  const data = fixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = []
  let rechecks = 0
  data.options.fetchPage = async (page, url) => { const value = await read(page, url); value.entries[1].masterRating = 2401; return value }
  data.options.recheckOrderFailure = async () => { rechecks++; return { status: 'unavailable', elapsedMs: 1000 } }
  data.options.onAttemptFailure = value => { failures.push(value) }
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 3 }), error =>
    error instanceof LegendAnalysisCollectionError && error.validationCheck === 'mr-order')
  assert.equal(rechecks, 3)
  assert.deepEqual(data.requested, [1, 1, 1])
  assert.deepEqual(failures.map(value => [value.attempt, value.orderRecheck]), [1, 2, 3].map(attempt => [attempt, { status: 'unavailable', elapsedMs: 1000 }]))
})

test('order reread access failures preserve the original diagnostic and abort without masking the exact error', async () => {
  for (const error of [new LegendAnalysisDomError('http-denied'), new Error('secret-auth-response'),
    new LegendAnalysisCollectionError('cancelled', 'cancellation')]) {
    const data = fixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], retries: number[] = []
    let rechecks = 0
    data.options.fetchPage = async (page, url) => { const value = await read(page, url); value.entries[1].masterRating = 2401; return value }
    data.options.recheckOrderFailure = async () => { rechecks++; throw error }
    data.options.onAttemptFailure = value => { failures.push(value) }
    data.options.onRetry = value => { retries.push(value) }
    await assert.rejects(collectLegendAnalysisDataset(data.options), actual => actual === error)
    assert.equal(rechecks, 1); assert.deepEqual(retries, []); assert.deepEqual(data.requested, [1])
    assert.equal(failures.length, 1)
    assert.equal(failures[0].validationCheck, 'mr-order')
    assert.equal(failures[0].orderDiagnostic?.current.masterRating, 2401)
    assert.deepEqual(failures[0].orderRecheck, { status: 'failed' })
    assert.doesNotMatch(JSON.stringify(failures), /secret|http-denied|cancelled/)
  }
})

test('unrelated validation failures never perform an order reread or gain order diagnostic fields', async () => {
  for (const mutate of [
    (page: LegendAnalysisPage) => { page.conditionsConfirmed = false },
    (page: LegendAnalysisPage) => { page.entries[0].rank = 2 },
    (page: LegendAnalysisPage) => { page.entries[1].rank = 3 },
    (page: LegendAnalysisPage) => { overlapWith(page.entries[1], page.entries[0]) },
  ]) {
    const data = fixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = []
    let rechecks = 0
    data.options.fetchPage = async (page, url) => { const value = await read(page, url); mutate(value); return value }
    data.options.recheckOrderFailure = async () => { rechecks++; return { status: 'failed' } }
    data.options.onAttemptFailure = value => { failures.push(value) }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), LegendAnalysisCollectionError)
    assert.equal(rechecks, 0)
    assert.equal('orderDiagnostic' in failures[0], false)
    assert.equal('orderRecheck' in failures[0], false)
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
