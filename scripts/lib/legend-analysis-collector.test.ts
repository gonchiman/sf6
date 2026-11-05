import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGEND_ANALYSIS_SOURCE } from '../../src/lib/legendAnalysis.ts'
import { collectLegendAnalysisDataset, LegendAnalysisCollectionError } from './legend-analysis-collector.ts'
import type { CollectLegendAnalysisOptions, LegendAnalysisAttemptFailure, LegendAnalysisEntry, LegendAnalysisPage } from './legend-analysis-collector.ts'
import { LEGEND_ANALYSIS_CONDITIONS, LegendAnalysisDomError, legendAnalysisPageUrl } from './legend-analysis-dom.ts'
import type { LegendEndpointRecheck, LegendMissingMemberDetail, LegendOrderPosition, LegendOrderRecheck, LegendPageRecoveryRange } from './legend-order-diagnostics.ts'

const absentMember = (firstSeen: LegendOrderPosition, firstSeenSource: LegendMissingMemberDetail['firstSeenSource'],
  lastSeen = firstSeen, observations = 1): LegendMissingMemberDetail => ({ firstSeen, lastSeen, firstSeenSource, observations,
  accountPresence: 'absent-from-range', sameAccountRowsCount: 0, sameAccountPositions: [] })

function fixture(rows?: LegendAnalysisEntry[], pageSize = 2) {
  const values: LegendAnalysisEntry[] = rows ?? Array.from({ length: 4 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
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
function replaceListedMember(entry: LegendAnalysisEntry): void {
  entry.accountKey = 'f'.repeat(64)
  if (entry.playerId !== undefined) entry.playerId = '999'
}

test('complete capture aggregates account-character entries and rechecks both endpoints', async () => {
  const data = fixture()
  const progress: Array<{ phase: string; attempt: number; page: number | null }> = []
  const endpoints: LegendEndpointRecheck[] = []
  data.options.onProgress = value => { progress.push(value) }
  data.options.onEndpointRecheck = value => { endpoints.push(value) }
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
  assert.deepEqual(endpoints, [
    { attempt: 1, phase: 'end-recheck', page: 2, status: 'unchanged', changeKinds: [] },
    { attempt: 1, phase: 'start-recheck', page: 1, status: 'unchanged', changeKinds: [] },
  ])
})

test('endpoint value and label updates keep the complete validated capture without retry or mixing observations', async () => {
  for (const target of [1, 2]) for (const kind of ['rank', 'master-rating', 'player-labels'] as const) {
    const data = fixture(), read = data.options.fetchPage, endpoints: LegendEndpointRecheck[] = []
    data.values.forEach((entry, index) => Object.assign(entry, { playerName: `Original ${index}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
    const before = structuredClone(data.values)
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === (target === 1 ? 4 : 3)) {
        if (kind === 'rank') value.entries[1].rank = value.entries[0].rank
        if (kind === 'master-rating') value.entries[0].masterRating += 10
        if (kind === 'player-labels') Object.assign(value.entries[0], { playerName: 'New label', region: '米国', platform: 'PS5' })
      }
      return value
    }
    data.options.onEndpointRecheck = value => { endpoints.push(value) }
    let outputs = 0
    data.options.onVerifiedPlayers = players => {
      outputs++
      assert.deepEqual(players, before.slice(0, 2).map(({ accountKey: _key, isLegend: _legend, ...entry }) => entry))
    }
    const result = await collectLegendAnalysisDataset(data.options)
    assert.equal(result.retryCount, 0); assert.equal(result.requestCount, 4); assert.equal(outputs, 1)
    assert.equal(result.dataset.mr.max, 2400); assert.equal(result.dataset.mr.min, 2399)
    assert.deepEqual(data.requested, [1, 2, 2, 1])
    const changed = endpoints.find(event => event.page === target)!
    assert.equal(changed.status, 'same-members-updated'); assert.deepEqual(changed.changeKinds, [kind])
    assert.equal(endpoints.length, 2)
    assert.doesNotMatch(JSON.stringify(endpoints), /Original|New label|accountKey|playerId|Steam|PS5/)
  }
})

test('valid endpoint ties may reorder the same members while output retains the earlier ordering', async () => {
  const data = fixture(), read = data.options.fetchPage, endpoints: LegendEndpointRecheck[] = []
  data.values[1].rank = 1; data.values[1].masterRating = 2400
  data.values.forEach((entry, index) => Object.assign(entry, { playerName: `Original ${index}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (data.requested.length === 4) value.entries.reverse()
    return value
  }
  data.options.onEndpointRecheck = value => { endpoints.push(value) }
  data.options.onVerifiedPlayers = players => { assert.deepEqual(players.map(row => row.playerId), ['1', '2']) }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.retryCount, 0)
  assert.deepEqual(endpoints[1], { attempt: 1, phase: 'start-recheck', page: 1, status: 'same-members-updated', changeKinds: ['row-order'] })
})

test('endpoint membership, public identity and Legend status changes still reject all output', async () => {
  for (const target of [1, 2]) for (const kind of ['account', 'character', 'player-id', 'legend'] as const) {
    const data = fixture(), read = data.options.fetchPage, endpoints: LegendEndpointRecheck[] = []
    data.values.forEach((entry, index) => Object.assign(entry, { playerName: `Original ${index}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === (target === 1 ? 4 : 3)) {
        const entry = value.entries[kind === 'legend' && target === 1 ? 1 : 0]
        if (kind === 'account') entry.accountKey = 'f'.repeat(64)
        if (kind === 'character') entry.characterId = entry.characterId === 'ryu' ? 'ken' : 'ryu'
        if (kind === 'player-id') entry.playerId = '999'
        if (kind === 'legend') entry.isLegend = !entry.isLegend
      }
      return value
    }
    let outputs = 0
    data.options.onVerifiedPlayers = () => { outputs++ }
    data.options.onEndpointRecheck = value => { endpoints.push(value) }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError
      && error.validationCheck === (target === 1 ? 'start-recheck' : 'end-recheck'))
    assert.equal(outputs, 0); assert.equal(endpoints.at(-1)?.status, 'rejected')
    assert.ok(endpoints.at(-1)?.changeKinds.includes(kind === 'legend' ? 'legend-status' : 'membership'))
  }
})

test('endpoint pages must independently pass order, duplicates, row positions and Legend continuity checks', async () => {
  for (const target of [1, 2]) for (const kind of ['rank-order', 'mr-order', 'duplicate-entry', 'rank-position', 'legend-contiguity', 'entry-values'] as const) {
    const data = fixture(Array.from({ length: 6 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
      characterId: 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: index < 3 })), 3)
    const read = data.options.fetchPage, endpoints: LegendEndpointRecheck[] = []
    let passiveObservations = 0
    data.options.recheckOrderFailure = async () => { passiveObservations++; return { status: 'unavailable', elapsedMs: 1000 } }
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === (target === 1 ? 4 : 3)) {
        if (kind === 'rank-order') value.entries[2].rank = value.entries[0].rank
        if (kind === 'mr-order') value.entries[1].masterRating = value.entries[0].masterRating + 1
        if (kind === 'duplicate-entry') overlapWith(value.entries[1], value.entries[0])
        if (kind === 'rank-position') value.entries[1].rank = value.to + 1
        if (kind === 'legend-contiguity') value.entries[1].isLegend = !value.entries[1].isLegend
        if (kind === 'entry-values') value.entries[0].masterRating = -1
      }
      return value
    }
    data.options.onEndpointRecheck = value => { endpoints.push(value) }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === kind)
    assert.equal(passiveObservations, 0)
    assert.equal(endpoints.length, target === 1 ? 2 : 1)
    assert.equal(endpoints.at(-1)?.status, 'rejected'); assert.ok(endpoints.at(-1)?.changeKinds.includes('invalid-page'))
  }
})

test('single-page captures recheck both endpoints and never waive the first rank or terminal coverage', async () => {
  for (const kind of ['valid-update', 'first-rank', 'new-next-page'] as const) {
    const data = fixture([{ accountKey: '1'.padStart(64, '0'), characterId: 'ryu', rank: 1, masterRating: 2400, isLegend: true }], 1)
    const read = data.options.fetchPage, endpoints: LegendEndpointRecheck[] = []
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length > 1) {
        if (kind === 'valid-update') value.entries[0].masterRating += data.requested.length
        if (kind === 'first-rank') value.entries[0].rank = 2
        if (kind === 'new-next-page') { value.totalCount = 2; value.nextPage = 2 }
      }
      return value
    }
    data.options.onEndpointRecheck = value => { endpoints.push(value) }
    if (kind === 'valid-update') {
      const result = await collectLegendAnalysisDataset(data.options)
      assert.equal(result.dataset.mr.max, 2400); assert.equal(result.requestCount, 3)
      assert.deepEqual(endpoints.map(event => event.status), ['same-members-updated', 'same-members-updated'])
    } else {
      await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError
        && error.validationCheck === (kind === 'first-rank' ? 'first-rank' : 'terminal-coverage'))
      assert.equal(endpoints.length, 1); assert.equal(endpoints[0].status, 'rejected')
      assert.ok(endpoints[0].changeKinds.includes(kind === 'first-rank' ? 'invalid-page' : 'metadata'))
    }
  }
})

test('endpoint diagnostics cannot change acceptance or mask denial and shared request bounds', async () => {
  const data = fixture(), read = data.options.fetchPage
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (data.requested.length === 4) value.entries[0].masterRating++
    return value
  }
  data.options.onEndpointRecheck = value => { value.changeKinds.push('membership'); throw new Error('diagnostic callback failed') }
  assert.equal((await collectLegendAnalysisDataset(data.options)).retryCount, 0)
  for (const kind of ['denied', 'budget'] as const) {
    const next = fixture(), original = next.options.fetchPage, endpoints: LegendEndpointRecheck[] = [], retries: number[] = []
    const denied = new LegendAnalysisDomError('http-denied')
    next.options.fetchPage = async (page, url) => {
      const value = await original(page, url)
      if (kind === 'denied' && next.requested.length === 3) throw denied
      return value
    }
    next.options.onEndpointRecheck = value => { endpoints.push(value) }
    next.options.onRetry = value => { retries.push(value) }
    await assert.rejects(collectLegendAnalysisDataset({ ...next.options, maxRequests: kind === 'budget' ? 3 : 120 }), error =>
      kind === 'denied' ? error === denied : error instanceof LegendAnalysisCollectionError && error.validationCheck === 'request-budget')
    assert.deepEqual(next.requested, [1, 2, 2]); assert.deepEqual(retries, [])
    assert.equal(endpoints.length, kind === 'denied' ? 0 : 1)
  }
})

test('opt-in player projection emits only accepted rows once after the final successful retry', async () => {
  const data = fixture()
  data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
  const read = data.options.fetchPage
  let reads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (++reads === 4) replaceListedMember(value.entries[0])
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
        if (data.requested.length % 4 === 0) replaceListedMember(value.entries[0])
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

test('changed adjacent membership falls back to a complete attempt and never reports a successful local recovery', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage
  let firstReads = 0, secondReads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 2 && ++secondReads === 1) overlapWith(value.entries[1], data.values[1])
    if (page === 1 && ++firstReads === 2) value.entries[0].accountKey = 'f'.repeat(64)
    return value
  }
  const events: string[] = [], failures: LegendAnalysisAttemptFailure[] = []
  data.options.onPageRecovery = state => { events.push(state) }
  data.options.onAttemptFailure = failure => { failures.push(failure) }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.retryCount, 1); assert.equal(result.dataset.totalCount, 4)
  assert.deepEqual(events, ['started'])
  assert.deepEqual(data.requested, [1, 2, 1, 2, 3, 1, 2, 3, 1, 2, 3, 3, 1])
  assert.deepEqual(failures, [{ attempt: 1, phase: 'listing', page: 3, code: 'source-changed',
    validationCheck: 'range-missing-members', recheckChangeKinds: null,
    pageRecoveryDecision: { trigger: 'duplicate-entry', eligible: true, reason: 'eligible', page: 2, previousPage: 1, recoveryUsed: false } }])
})

test('persistent overlap can recheck each complete attempt but never becomes a partial success', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage
  data.options.fetchPage = async (page, url) => { const value = await read(page, url); if (page === 2) overlapWith(value.entries[1], data.values[1]); return value }
  const events: string[] = []
  data.options.onPageRecovery = state => { events.push(state) }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError && error.code === 'duplicate-entry')
  assert.deepEqual(events, ['started', 'started'])
  assert.deepEqual(data.requested, [1, 2, 1, 2, 1, 2, 1, 2])
  assert.equal(data.actChecks(), 0)
})

test('a 488-to-487 boundary inversion recovers a rank-only update without restarting or losing tied Legend entries', async () => {
  const rows = Array.from({ length: 520 }, (_, index) => ({
    accountKey: (index + 1).toString(16).padStart(64, '0'), characterId: 'ryu',
    rank: index >= 486 && index < 504 ? 487 : index + 1,
    masterRating: index < 486 ? 2247 - index : index < 504 ? 1761 : 1760 - (index - 504),
    isLegend: index < 504, playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam',
  }))
  const data = fixture(rows, 20), read = data.options.fetchPage, events: string[] = []
  let previousReads = 0, projections = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 25 && ++previousReads === 1) value.entries[19].rank = 488
    return value
  }
  data.options.onPageRecovery = state => { events.push(state) }
  data.options.onVerifiedPlayers = players => {
    projections++
    assert.deepEqual(players.map(row => [row.playerId, row.rank, row.masterRating]), rows.slice(0, 504).map(row => [row.playerId, row.rank, row.masterRating]))
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.retryCount, 0); assert.equal(result.pagesRead, 26); assert.equal(result.requestCount, 31)
  assert.equal(result.dataset.totalCount, 504); assert.equal(result.dataset.mr.min, 1761)
  assert.equal(projections, 1); assert.deepEqual(events, ['started', 'succeeded'])
  assert.deepEqual(data.requested, [...Array.from({ length: 26 }, (_, index) => index + 1), 25, 26, 24, 26, 1])
})

test('reordered members and updated values replace the old preceding page in both aggregation and player projection', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = []
  data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
  Object.assign(data.values[4], { rank: 3, masterRating: 2398 })
  let previousReads = 0, projections = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 2 && ++previousReads === 2) {
      value.entries.reverse()
      value.entries.forEach(entry => { entry.rank = 3; entry.masterRating = 2398 })
      value.entries[0].playerName = 'Updated name'
    }
    return value
  }
  data.options.onPageRecovery = state => { events.push(state) }
  data.options.onVerifiedPlayers = players => {
    projections++
    assert.deepEqual(players.map(row => row.playerId), ['10000', '10001', '10003', '10002'])
    assert.deepEqual(players.map(row => row.masterRating), [2400, 2399, 2398, 2398])
    assert.equal(players[2].playerName, 'Updated name')
    assert.equal(players[3].rank, 3)
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.retryCount, 0); assert.equal(result.dataset.totalCount, 4); assert.equal(result.dataset.mr.min, 2398)
  assert.equal(projections, 1); assert.deepEqual(events, ['started', 'succeeded'])
  assert.deepEqual(data.requested, [1, 2, 3, 2, 3, 1, 3, 1])
})

test('refreshing page one changes the final start baseline but does not waive the final comparison', async () => {
  for (const staleFinal of [false, true]) {
    const data = adjacentFixture(), read = data.options.fetchPage
    data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
    let firstReads = 0, secondReads = 0, projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 2 && ++secondReads === 1) overlapWith(value.entries[0], data.values[1])
      if (page === 1 && ++firstReads >= 2 && !(staleFinal && firstReads === 3)) {
        value.entries.forEach(entry => { entry.masterRating++ })
        value.entries[0].playerName = 'Updated name'
      }
      if (page === 1 && staleFinal && firstReads === 3) replaceListedMember(value.entries[0])
      return value
    }
    data.options.onVerifiedPlayers = players => {
      projections++
      assert.equal(players[0].masterRating, 2401); assert.equal(players[0].playerName, 'Updated name')
    }
    const collect = collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 })
    if (staleFinal) await assert.rejects(collect, error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'start-recheck')
    else {
      const result = await collect
      assert.equal(result.retryCount, 0); assert.equal(result.dataset.mr.max, 2401)
    }
    assert.equal(projections, staleFinal ? 0 : 1)
    assert.deepEqual(data.requested, [1, 2, 1, 2, 3, 3, 1])
  }
})

test('endpoint value updates after range recovery preserve the recovered snapshot instead of mixing later values', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage, endpoints: LegendEndpointRecheck[] = []
  data.values.forEach((entry, index) => Object.assign(entry, { playerName: `Original ${index}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
  let firstReads = 0, secondReads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 2 && ++secondReads === 1) overlapWith(value.entries[0], data.values[1])
    if (page === 1 && ++firstReads >= 2) {
      value.entries.forEach(entry => { entry.masterRating += firstReads - 1 })
      value.entries[0].playerName = firstReads === 2 ? 'Recovered label' : 'New endpoint label'
    }
    return value
  }
  let outputs = 0
  data.options.onVerifiedPlayers = rows => {
    outputs++; assert.equal(rows[0].masterRating, 2401); assert.equal(rows[0].playerName, 'Recovered label')
  }
  data.options.onEndpointRecheck = value => { endpoints.push(value) }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.mr.max, 2401); assert.equal(result.retryCount, 0); assert.equal(outputs, 1)
  assert.deepEqual(endpoints.at(-1), { attempt: 1, phase: 'start-recheck', page: 1, status: 'same-members-updated', changeKinds: ['master-rating', 'player-labels'] })
  assert.deepEqual(data.requested, [1, 2, 1, 2, 3, 3, 1])
})

test('range replacement rejects missing membership, character changes, Legend changes, duplicate membership and invalid Act', async () => {
  for (const [kind, mutate] of [
    ['missing', (page: LegendAnalysisPage) => { page.entries[0].accountKey = 'f'.repeat(64) }],
    ['missing', (page: LegendAnalysisPage) => { page.entries[0].characterId = 'ken' }],
    ['legend', (page: LegendAnalysisPage) => { page.entries[0].isLegend = false }],
    ['duplicate', (page: LegendAnalysisPage) => { overlapWith(page.entries[1], page.entries[0]) }],
    ['act', (page: LegendAnalysisPage) => { page.actConfirmed = false }],
  ] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = []
    data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
    let firstReads = 0, secondReads = 0, projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 2 && ++secondReads === 1) value.entries[0].rank = 1
      if (page === 1 && ++firstReads === 2) mutate(value)
      return value
    }
    data.options.onPageRecovery = state => { events.push(state) }
    data.options.onVerifiedPlayers = () => { projections++ }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError
      && error.validationCheck === ({ missing: 'range-missing-members', legend: 'range-legend-changed', duplicate: 'duplicate-entry', act: 'source-act' }[kind]))
    assert.equal(projections, 0); assert.deepEqual(events, ['started']); assert.deepEqual(data.requested, kind === 'missing' ? [1, 2, 1, 2, 3, 1, 2, 3] : [1, 2, 1])
  }
})

test('refreshed preceding rows must still obey their earlier prefix and internal order', async () => {
  for (const kind of ['prefix-rank', 'prefix-mr', 'internal-rank', 'internal-mr'] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], events: string[] = []
    let previousReads = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 3) value.entries[0].rank = 3
      if (page === 2 && ++previousReads === 2) {
        if (kind === 'prefix-rank') value.entries[0].rank = 1
        if (kind === 'prefix-mr') value.entries[0].masterRating = 2400
        if (kind === 'internal-rank') value.entries[1].rank = 2
        if (kind === 'internal-mr') value.entries[1].masterRating = 2399
      }
      return value
    }
    data.options.onPageRecovery = state => { events.push(state) }
    data.options.onAttemptFailure = failure => { failures.push(failure) }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError
      && error.validationCheck === (kind.endsWith('rank') ? 'rank-order' : 'mr-order'))
    assert.deepEqual(events, ['started']); assert.deepEqual(data.requested, [1, 2, 3, 2])
    assert.equal(failures[0].orderDiagnostic?.previous.page, 2)
    assert.equal(failures[0].orderDiagnostic?.previous.rank, 4)
    assert.equal(failures[0].orderDiagnostic?.current.page, 3)
    assert.equal(failures[0].orderDiagnostic?.current.rank, 3)
  }
})

test('an updated preceding page is never published when the current replacement is invalid or access is denied', async () => {
  for (const kind of ['duplicate', 'order', 'denied'] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = [], retries: number[] = []
    data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
    const denied = new LegendAnalysisDomError('http-denied')
    let firstReads = 0, secondReads = 0, projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 1 && ++firstReads === 2) value.entries[0].masterRating++
      if (page === 2) {
        if (++secondReads === 1 || kind === 'order') value.entries[0].rank = 1
        else if (kind === 'duplicate') overlapWith(value.entries[0], data.values[1])
        else throw denied
      }
      return value
    }
    data.options.onPageRecovery = state => { events.push(state) }
    data.options.onRetry = count => { retries.push(count) }
    data.options.onVerifiedPlayers = () => { projections++ }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: kind === 'denied' ? 2 : 1 }), error =>
      kind === 'denied' ? error === denied : error instanceof LegendAnalysisCollectionError)
    assert.equal(projections, 0); assert.deepEqual(events, ['started']); assert.deepEqual(retries, [])
    assert.deepEqual(data.requested, [1, 2, 1, 2])
  }
})

test('conflicting Legend evidence across distant pages and within-page duplicate entries are rejected', async () => {
  for (const kind of ['earlier-page', 'within-page'] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = []
    data.options.onPageRecovery = state => { events.push(state) }
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (kind === 'earlier-page' && page === 3) overlapWith(value.entries[0], data.values[0])
      if (kind === 'within-page' && page === 2) for (const entry of value.entries) overlapWith(entry, data.values[1])
      return value
    }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError
      && error.validationCheck === (kind === 'earlier-page' ? 'range-legend-changed' : 'duplicate-entry'))
    assert.deepEqual(events, kind === 'earlier-page' ? ['started'] : [])
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
    assert.deepEqual(events, kind === 'budget' ? [] : ['started'])
    assert.deepEqual(data.requested, kind === 'denied' ? [1, 2, 1] : [1, 2])
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
    validationCheck: 'duplicate-entry', recheckChangeKinds: null,
    pageRecoveryDecision: { trigger: 'duplicate-entry', eligible: false, reason: 'previous-page-missing', page: 1, previousPage: null, recoveryUsed: false } }])
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
    if (++count % 3 === 0) replaceListedMember(value.entries[0])
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
      sameEntry: false, duplicateInAccepted: false, duplicateWithinCurrentPage: false },
    pageRecoveryDecision: { trigger: 'mr-order', eligible: false, reason: 'within-page-order', page: 1, previousPage: null, recoveryUsed: false,
      conflict: { previous: { page: 1, rowIndex: 1, rank: 1, masterRating: 2400 }, current: { page: 1, rowIndex: 2, rank: 2, masterRating: 9999 } } } }])
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
      if (count === 2 && page === (legendChanged ? 1 : 2)) replaceListedMember(value.entries[0])
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
    if (page === 1 && ++firstReads % 2 === 0) replaceListedMember(value.entries[0])
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

test('boundary rank and MR recovery observes the failing document before rereading both pages and publishes only the verified replacement', async () => {
  for (const check of ['rank-order', 'mr-order'] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = [], failures: LegendAnalysisAttemptFailure[] = []
    data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
    let secondReads = 0, outputs = 0
    data.options.fetchPage = async (page, url) => {
      events.push(`read-${page}`)
      const value = await read(page, url)
      if (page === 2 && ++secondReads === 1) {
        if (check === 'rank-order') value.entries[0].rank = 1
        else value.entries[0].masterRating = 2400
      }
      return value
    }
    data.options.recheckOrderFailure = async (page, rowIndex) => {
      events.push('observe-2')
      assert.equal(page.page, 2); assert.equal(rowIndex, 1)
      assert.equal(data.requested.at(-1), 2)
      return { status: 'unavailable', elapsedMs: 1000 }
    }
    data.options.onPageRecovery = state => { events.push(state) }
    data.options.onAttemptFailure = value => { failures.push(value) }
    data.options.onVerifiedPlayers = rows => {
      outputs++
      assert.deepEqual(rows.map(row => [row.playerId, row.rank, row.masterRating]),
        data.values.slice(0, 4).map(row => [row.playerId, row.rank, row.masterRating]))
    }
    const result = await collectLegendAnalysisDataset(data.options)
    assert.deepEqual(events, ['read-1', 'read-2', 'observe-2', 'started', 'read-1', 'read-2', 'succeeded', 'read-3', 'read-3', 'read-1'])
    assert.equal(result.retryCount, 0); assert.equal(result.pagesRead, 3); assert.equal(result.requestCount, 7)
    assert.equal(result.dataset.totalCount, 4); assert.equal(outputs, 1); assert.deepEqual(failures, [])
  }
})

test('persistent boundary inversion rechecks each whole attempt and records the first pair once per attempt', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], events: string[] = []
  let rechecks = 0
  data.options.fetchPage = async (page, url) => { const value = await read(page, url); if (page === 2) value.entries[0].rank = 1; return value }
  data.options.recheckOrderFailure = async page => {
    rechecks++; assert.equal(data.requested.at(-1), page.page)
    return { status: 'unavailable', elapsedMs: 1000 }
  }
  data.options.onPageRecovery = value => { events.push(value) }
  data.options.onAttemptFailure = value => { failures.push(value) }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'rank-order')
  assert.deepEqual(events, ['started', 'started']); assert.deepEqual(data.requested, [1, 2, 1, 2, 1, 2, 1, 2]); assert.equal(rechecks, 2)
  assert.equal(failures.length, 2)
  assert.deepEqual(failures.map(failure => failure.pageRecoveryDecision?.reason), ['eligible', 'eligible'])
  assert.deepEqual(failures.map(failure => failure.pageRecoveryDecision?.recoveryUsed), [false, true])
  for (const failure of failures) {
    assert.equal(failure.orderDiagnostic?.current.rank, 1); assert.equal(failure.orderDiagnostic?.previous.rank, 2)
    assert.deepEqual(failure.orderRecheck, { status: 'unavailable', elapsedMs: 1000 })
  }
})

test('a missing member in the replacement range retains the original order evidence', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], events: string[] = []
  let firstReads = 0, secondReads = 0, rechecks = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 2 && ++secondReads === 1) value.entries[0].rank = 1
    if (page === 1 && ++firstReads === 2) value.entries[0].accountKey = 'f'.repeat(64)
    return value
  }
  data.options.recheckOrderFailure = async () => { rechecks++; return { status: 'unavailable', elapsedMs: 1000 } }
  data.options.onAttemptFailure = value => { failures.push(value) }
  data.options.onPageRecovery = value => { events.push(value) }
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'range-missing-members')
  assert.deepEqual(data.requested, [1, 2, 1, 2, 3, 1, 2, 3]); assert.deepEqual(events, ['started']); assert.equal(rechecks, 1)
  assert.equal(failures[0].page, 3); assert.equal(failures[0].validationCheck, 'range-missing-members')
  assert.equal(failures[0].recheckChangeKinds, null)
  assert.equal(failures[0].orderDiagnostic?.current.page, 2); assert.equal(failures[0].orderDiagnostic?.current.rank, 1)
  assert.deepEqual(failures[0].orderRecheck, { status: 'unavailable', elapsedMs: 1000 })
})

test('page-internal inversions and duplicates remain ineligible even when a boundary also inverts', async () => {
  for (const kind of ['within-only', 'within-rank', 'within-mr', 'within-duplicate'] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = []
    const failures: LegendAnalysisAttemptFailure[] = []
    const failingPage = kind === 'within-rank' ? 3 : 2
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === failingPage) {
        if (kind === 'within-only') value.entries[1].rank = 2
        else {
          value.entries[0].rank = kind === 'within-rank' ? 3 : 1
          if (kind === 'within-rank') value.entries[1].rank = 2
          if (kind === 'within-mr') value.entries[1].masterRating = value.entries[0].masterRating + 1
          if (kind === 'within-duplicate') overlapWith(value.entries[1], value.entries[0])
        }
      }
      return value
    }
    data.options.onPageRecovery = value => { events.push(value) }
    data.options.onAttemptFailure = value => { failures.push(value) }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), LegendAnalysisCollectionError)
    assert.deepEqual(events, [])
    assert.deepEqual(data.requested, failingPage === 3 ? [1, 2, 3] : [1, 2])
    const reason = { 'within-only': 'within-page-order', 'within-rank': 'within-page-rank-order',
      'within-mr': 'within-page-mr-order', 'within-duplicate': 'within-page-duplicate' }[kind]
    assert.equal(failures[0].pageRecoveryDecision?.eligible, false)
    assert.equal(failures[0].pageRecoveryDecision?.reason, reason)
    assert.equal(failures[0].pageRecoveryDecision?.conflict?.current.page, failingPage)
    assert.equal(failures[0].pageRecoveryDecision?.conflict?.current.rowIndex, 2)
    assert.equal(failures[0].pageRecoveryDecision?.conflict?.previous.page, failingPage)
  }
})

test('order and duplicate recoveries both complete within one attempt in either order', async () => {
  for (const firstFailure of ['order', 'duplicate'] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = []
    let secondReads = 0, thirdReads = 0
    data.values.forEach((entry, index) => { entry.isLegend = index < 5 })
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 2 && ++secondReads === 1) {
        if (firstFailure === 'order') value.entries[0].rank = 1
        else overlapWith(value.entries[0], data.values[1])
      }
      if (page === 3 && ++thirdReads === 1) {
        if (firstFailure === 'order') overlapWith(value.entries[0], data.values[3])
        else value.entries[0].rank = 1
      }
      return value
    }
    data.options.onPageRecovery = value => { events.push(value) }
    const result = await collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 })
    assert.equal(result.dataset.totalCount, 5); assert.equal(result.retryCount, 0)
    assert.deepEqual(events, ['started', 'succeeded', 'started', 'succeeded'])
    assert.deepEqual(data.requested, [1, 2, 1, 2, 3, 2, 3, 1, 3, 1])
  }
})

test('boundary recovery preserves original diagnostics on request limits, cancellation and terminal transport errors', async () => {
  for (const kind of ['budget', 'cancelled', 'http-denied', 'authentication-required', 'maintenance', 'other'] as const) {
    const data = adjacentFixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], events: string[] = [], retries: number[] = []
    const controller = new AbortController(), transportError = kind === 'http-denied' || kind === 'authentication-required' || kind === 'maintenance'
      ? new LegendAnalysisDomError(kind) : new Error('private terminal response')
    let firstReads = 0, rechecks = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 2) value.entries[0].rank = 1
      if (page === 1 && ++firstReads === 2 && !['budget', 'cancelled'].includes(kind)) throw transportError
      return value
    }
    data.options.recheckOrderFailure = async () => { rechecks++; return { status: 'unavailable', elapsedMs: 1000 } }
    data.options.onAttemptFailure = value => { failures.push(value) }
    data.options.onRetry = value => { retries.push(value) }
    data.options.onPageRecovery = value => { events.push(value); if (kind === 'cancelled') controller.abort() }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, signal: controller.signal,
      ...(kind === 'budget' ? { maxRequests: 3 } : {}) }), error => kind === 'budget' || kind === 'cancelled'
      ? error instanceof LegendAnalysisCollectionError && error.code === (kind === 'budget' ? 'request-limit' : 'cancelled') : error === transportError)
    assert.deepEqual(events, kind === 'budget' ? [] : ['started']); assert.deepEqual(retries, []); assert.equal(rechecks, kind === 'budget' ? 0 : 1)
    assert.deepEqual(data.requested, ['budget', 'cancelled'].includes(kind) ? [1, 2] : [1, 2, 1])
    assert.equal(failures.length, 1); assert.equal(failures[0].orderDiagnostic?.current.rank, 1)
    assert.deepEqual(failures[0].pageRecoveryDecision, { trigger: 'rank-order', eligible: true, reason: 'eligible',
      page: 2, previousPage: 1, recoveryUsed: false })
    assert.deepEqual(failures[0].orderRecheck, kind === 'budget' ? undefined : { status: 'unavailable', elapsedMs: 1000 })
    assert.doesNotMatch(JSON.stringify(failures), /private terminal/)
  }
})

test('failed recovery never replaces its original pair with a new recovered-page violation or emits players', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = []
  data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${10000 + index}`, region: '日本', platform: 'Steam' }) })
  let secondReads = 0, outputs = 0, rechecks = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 2) {
      if (++secondReads === 1) value.entries[0].rank = 1
      else value.entries[1].masterRating = 9999
    }
    return value
  }
  data.options.onVerifiedPlayers = () => { outputs++ }
  data.options.recheckOrderFailure = async () => { rechecks++; return { status: 'unavailable', elapsedMs: 1000 } }
  data.options.onAttemptFailure = value => { failures.push(value) }
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'mr-order')
  assert.equal(outputs, 0); assert.equal(rechecks, 1); assert.deepEqual(data.requested, [1, 2, 1, 2])
  assert.equal(failures[0].validationCheck, 'mr-order'); assert.equal(failures[0].orderDiagnostic?.current.rank, 1)
  assert.equal(failures[0].orderDiagnostic?.current.rowIndex, 1)
})

test('successful boundary recovery clears its diagnostics before an unrelated endpoint failure', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], events: string[] = []
  let secondReads = 0, thirdReads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 2 && ++secondReads === 1) value.entries[0].rank = 1
    if (page === 3 && ++thirdReads === 2) replaceListedMember(value.entries[0])
    return value
  }
  data.options.onAttemptFailure = value => { failures.push(value) }
  data.options.onPageRecovery = value => { events.push(value) }
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'end-recheck')
  assert.deepEqual(events, ['started', 'succeeded']); assert.equal(failures.length, 1)
  assert.equal('orderDiagnostic' in failures[0], false); assert.equal('orderRecheck' in failures[0], false)
  assert.equal('pageRecoveryDecision' in failures[0], false)
})

test('a persistent 275-to-274 boundary inversion retries its full duplicate range and keeps both attempt decisions', async () => {
  const values = Array.from({ length: 320 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
    characterId: 'ryu', rank: index >= 274 && index < 280 ? 275 : index + 1,
    masterRating: index < 274 ? 3000 - index : index < 280 ? 1811 : 1810 - (index - 280), isLegend: index < 300 }))
  const data = fixture(values, 20), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], events: string[] = []
  let rechecks = 0
  const ranges: LegendPageRecoveryRange[] = []
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 15) {
      value.entries[0].rank = 274; value.entries[0].masterRating = 1811
      overlapWith(value.entries[9], values[259])
      value.entries[9].playerName = 'secret-player'; value.entries[9].playerId = 'secret-id'
    }
    return value
  }
  data.options.onAttemptFailure = value => { failures.push(value) }
  data.options.onPageRecovery = value => { events.push(value) }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  data.options.recheckOrderFailure = async () => { rechecks++; return { status: 'unavailable', elapsedMs: 1000 } }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'duplicate-entry')
  assert.deepEqual(events, ['started', 'started']); assert.equal(rechecks, 2)
  assert.deepEqual(data.requested, Array.from({ length: 2 }, () => [...Array.from({ length: 15 }, (_, index) => index + 1), 13, 14, 15]).flat())
  assert.deepEqual(failures.map(failure => failure.attempt), [1, 2])
  for (const failure of failures) {
    assert.equal(failure.orderDiagnostic?.previous.rank, 275); assert.equal(failure.orderDiagnostic?.current.rank, 274)
    assert.equal(failure.orderDiagnostic?.current.masterRating, 1811)
    assert.deepEqual(failure.pageRecoveryDecision, { trigger: 'rank-order', eligible: true,
      reason: 'eligible', page: 15, previousPage: 14, recoveryUsed: failure.attempt !== 1 })
  }
  assert.deepEqual(ranges.at(-1), { attempt: 2, fromPage: 13, toPage: 15, lastValidatedPage: 14, status: 'failed', issues: [
    { kind: 'recovery-range-duplicate', fromPage: 13, toPage: 15, conflict: {
      previous: { page: 13, rowIndex: 20, rank: 260, masterRating: 2741 },
      current: { page: 15, rowIndex: 10, rank: 290, masterRating: 1801 } } },
  ] })
  assert.doesNotMatch(JSON.stringify(failures), /accountKey|characterId|playerName|playerId|secret|https?:/)
})

test('eligible recovery is recorded before passive observation can deny access without starting recovery reads', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], events: string[] = []
  const denied = new LegendAnalysisDomError('http-denied')
  data.options.fetchPage = async (page, url) => { const value = await read(page, url); if (page === 2) value.entries[0].rank = 1; return value }
  data.options.recheckOrderFailure = async () => { throw denied }
  data.options.onAttemptFailure = value => { failures.push(value) }
  data.options.onPageRecovery = value => { events.push(value) }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error === denied)
  assert.deepEqual(data.requested, [1, 2]); assert.deepEqual(events, [])
  assert.deepEqual(failures[0].pageRecoveryDecision, { trigger: 'rank-order', eligible: true, reason: 'eligible',
    page: 2, previousPage: 1, recoveryUsed: false })
})

test('duplicate recovery decisions survive a transport failure and do not leak into the next attempt', async () => {
  const data = adjacentFixture(), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], events: string[] = []
  const denied = new LegendAnalysisDomError('authentication-required')
  let firstReads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 2) overlapWith(value.entries[1], data.values[1])
    if (page === 1 && ++firstReads === 2) throw denied
    return value
  }
  data.options.onAttemptFailure = value => { failures.push(value) }
  data.options.onPageRecovery = value => { events.push(value) }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error === denied)
  assert.deepEqual(data.requested, [1, 2, 1]); assert.deepEqual(events, ['started']); assert.equal(failures.length, 1)
  assert.equal(failures[0].code, 'read-failed')
  assert.deepEqual(failures[0].pageRecoveryDecision, { trigger: 'duplicate-entry', eligible: true, reason: 'eligible',
    page: 2, previousPage: 1, recoveryUsed: false })

  const retry = fixture(), original = retry.options.fetchPage, retryFailures: LegendAnalysisAttemptFailure[] = []
  let reads = 0
  retry.options.fetchPage = async (page, url) => {
    const value = await original(page, url)
    if (++reads === 1) overlapWith(value.entries[1], value.entries[0])
    else value.conditionsConfirmed = false
    return value
  }
  retry.options.onAttemptFailure = value => { retryFailures.push(value) }
  await assert.rejects(collectLegendAnalysisDataset(retry.options), LegendAnalysisCollectionError)
  assert.equal(retryFailures[0].pageRecoveryDecision?.reason, 'previous-page-missing')
  assert.equal('pageRecoveryDecision' in retryFailures[1], false)
  assert.deepEqual(retry.requested, [1, 1])
})

function movedRangeFixture(continueAfter = false) {
  const values = Array.from({ length: continueAfter ? 10 : 8 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
    characterId: 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: index < (continueAfter ? 9 : 7),
    playerName: `Original ${index + 1}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
  const data = fixture(values), original = data.options.fetchPage, reads = new Map<number, number>()
  // C crossed from page 2 into page 4. Re-observing the range also recovers the initially unseen G.
  const replacements = [values[3], values[4], values[5], values[6], values[2], values[7]].map((entry, index) => ({ ...entry,
    rank: index + 3, masterRating: 2398 - index, playerName: `Updated ${entry.playerId}` }))
  data.options.fetchPage = async (page, url) => {
    const value = await original(page, url), count = (reads.get(page) ?? 0) + 1; reads.set(page, count)
    if (page === 4 && count === 1) value.entries[0] = { ...values[2], rank: 7, masterRating: 2394 }
    if (page >= 2 && page <= 4 && count >= 2) value.entries = structuredClone(replacements.slice((page - 2) * 2, (page - 1) * 2))
    return value
  }
  return { ...data, replacements }
}

test('three-page recovery preserves every known identity, restores the missing row and publishes moved members once', async () => {
  const data = movedRangeFixture(), ranges: LegendPageRecoveryRange[] = [], events: string[] = []
  let projections = 0
  data.options.onPageRecovery = state => { events.push(state) }
  data.options.onPageRecoveryRange = range => { ranges.push(range); throw new Error('diagnostic sink unavailable') }
  data.options.onVerifiedPlayers = rows => {
    projections++
    assert.deepEqual(rows.map(row => [row.playerId, row.playerName, row.rank, row.masterRating]),
      [...data.values.slice(0, 2), ...data.replacements].filter(row => row.isLegend).map(row => [row.playerId, row.playerName, row.rank, row.masterRating]))
    assert.equal(new Set(rows.map(row => row.playerId)).size, 7)
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 7); assert.equal(projections, 1); assert.equal(result.retryCount, 0)
  assert.deepEqual(data.requested, [1, 2, 3, 4, 2, 3, 4, 1, 4, 1]); assert.equal(result.requestCount, 10)
  assert.deepEqual(events, ['started', 'succeeded'])
  assert.deepEqual(ranges, [null, 2, 3, 4].map(lastValidatedPage => ({ attempt: 1, fromPage: 2, toPage: 4, lastValidatedPage, status: 'started' }))
    .concat([{ attempt: 1, fromPage: 2, toPage: 4, lastValidatedPage: 4, status: 'succeeded' }]))
})

test('page 10 row 12 duplicated at page 14 row 4 rebuilds all five pages from the correct deep prefix', async () => {
  const rows = Array.from({ length: 280 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'), characterId: 'ryu',
    rank: index + 1, masterRating: 3000 - index, isLegend: index < 279, playerId: `${index + 1}`,
    playerName: `Original ${index + 1}`, region: '日本', platform: 'Steam' }))
  const data = fixture(rows, 20), read = data.options.fetchPage, counts = new Map<number, number>(), ranges: LegendPageRecoveryRange[] = []
  let projections = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url), count = (counts.get(page) ?? 0) + 1; counts.set(page, count)
    if (page === 14 && count === 1) {
      value.entries[0].rank = 259
      value.entries[3] = { ...rows[191], rank: 264, masterRating: 2737 }
    }
    if (page >= 10 && count >= 2) for (const entry of value.entries) { entry.masterRating--; entry.playerName = `Updated ${entry.playerId}` }
    return value
  }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  data.options.onVerifiedPlayers = players => {
    projections++
    assert.deepEqual(players.map(row => row.playerId), rows.slice(0, 279).map(row => row.playerId))
    assert.equal(new Set(players.map(row => row.playerId)).size, 279)
    for (const [index, entry] of players.entries()) {
      assert.equal(entry.masterRating, rows[index].masterRating - (index >= 180 ? 1 : 0))
      assert.equal(entry.playerName, `${index >= 180 ? 'Updated' : 'Original'} ${index + 1}`)
    }
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 279); assert.equal(projections, 1); assert.equal(result.retryCount, 0)
  assert.deepEqual(data.requested, [...Array.from({ length: 14 }, (_, index) => index + 1), 10, 11, 12, 13, 14, 9, 14, 1])
  assert.deepEqual(ranges.at(-1), { attempt: 1, fromPage: 10, toPage: 14, lastValidatedPage: 14, status: 'succeeded' })
})

test('all duplicate sources choose the oldest page and a six-page range is the maximum recoverable span', async () => {
  for (const fromPage of [2, 1]) {
    const rows = Array.from({ length: 14 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
      characterId: 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: true }))
    const data = fixture(rows), read = data.options.fetchPage, events: string[] = [], ranges: LegendPageRecoveryRange[] = [], failures: LegendAnalysisAttemptFailure[] = []
    let lastReads = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 7 && ++lastReads === 1) {
        // First conflict is recent; the second is older and determines the entire required range.
        overlapWith(value.entries[0], rows[8]); overlapWith(value.entries[1], rows[(fromPage - 1) * 2])
      }
      return value
    }
    data.options.onPageRecovery = state => { events.push(state) }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onAttemptFailure = value => { failures.push(value) }
    if (fromPage === 1) {
      await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.code === 'duplicate-entry')
      assert.deepEqual(events, []); assert.deepEqual(ranges, [])
      assert.equal(failures[0].pageRecoveryDecision?.reason, 'recovery-range-too-wide')
      assert.equal(failures[0].pageRecoveryDecision?.conflict?.previous.page, 1)
      assert.deepEqual(data.requested, [1, 2, 3, 4, 5, 6, 7])
    } else {
      const result = await collectLegendAnalysisDataset(data.options)
      assert.equal(result.dataset.totalCount, 14); assert.equal(result.retryCount, 0)
      assert.deepEqual(data.requested, [1, 2, 3, 4, 5, 6, 7, 2, 3, 4, 5, 6, 7, 1, 7, 1])
      assert.deepEqual(ranges.at(-1), { attempt: 1, fromPage: 2, toPage: 7, lastValidatedPage: 7, status: 'succeeded' })
    }
  }
})

test('the full range and its anchor must fit the remaining request budget before recovery starts', async () => {
  const data = movedRangeFixture(), events: string[] = [], ranges: LegendPageRecoveryRange[] = []
  data.options.onPageRecovery = value => { events.push(value) }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  // Three rereads fit, but the required fourth read of the left anchor does not.
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxRequests: 7 }), error => error instanceof LegendAnalysisCollectionError && error.code === 'request-limit')
  assert.deepEqual(data.requested, [1, 2, 3, 4]); assert.deepEqual(events, []); assert.deepEqual(ranges, [])
})

test('range missing members, changed Legend membership and anchor changes are distinguished without publishing partial rows', async () => {
  for (const kind of ['missing', 'legend', 'anchor'] as const) {
    const data = movedRangeFixture(), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = [], failures: LegendAnalysisAttemptFailure[] = []
    let projections = 0, anchorReads = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 4 && data.requested.length === 7) {
        if (kind === 'missing') value.entries[0] = { ...value.entries[0], accountKey: 'f'.repeat(64), playerId: '999', playerName: 'New unconfirmed member' }
        if (kind === 'legend') value.entries[0].isLegend = false
      }
      if (page === 1 && ++anchorReads === 2 && kind === 'anchor') value.entries[0].masterRating++
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onAttemptFailure = value => { failures.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    const expected = { missing: 'range-missing-members', legend: 'range-legend-changed', anchor: 'range-anchor-recheck' }[kind]
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === expected)
    assert.equal(projections, 0); assert.equal(failures[0].validationCheck, expected)
    if (kind === 'missing') {
      assert.deepEqual(ranges.at(-1), { attempt: 1, fromPage: 1, toPage: 4, lastValidatedPage: 4, status: 'failed', issues: [
        { kind: 'missing-members', fromPage: 2, toPage: 4, missingCount: 1,
          missingPositions: [{ page: 2, rowIndex: 1, rank: 3, masterRating: 2398 }],
          missingDetails: [absentMember({ page: 2, rowIndex: 1, rank: 3, masterRating: 2398 }, 'saved-page', { page: 4, rowIndex: 1, rank: 7, masterRating: 2394 }, 2)],
          expansion: { fromPage: 1, toPage: 4 } },
        { kind: 'missing-members', fromPage: 1, toPage: 4, missingCount: 1,
          missingPositions: [{ page: 4, rowIndex: 1, rank: 7, masterRating: 2394 }],
          missingDetails: [absentMember({ page: 4, rowIndex: 1, rank: 7, masterRating: 2394 }, 'range-reread')] },
      ] })
      assert.deepEqual(data.requested, [1, 2, 3, 4, 2, 3, 4, 1, 2, 3, 4])
    } else {
      assert.deepEqual(ranges.at(-1), { attempt: 1, fromPage: 2, toPage: 4, lastValidatedPage: kind === 'legend' ? 3 : 4, status: 'failed' })
      assert.deepEqual(data.requested, kind === 'anchor' ? [1, 2, 3, 4, 2, 3, 4, 1] : [1, 2, 3, 4, 2, 3, 4])
    }
  }
})

test('range metadata, duplicate, ordering, access denial and cancellation fail atomically', async () => {
  for (const kind of ['metadata', 'duplicate', 'order', 'denied', 'cancelled'] as const) {
    const data = movedRangeFixture(), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = [], controller = new AbortController()
    const denied = new LegendAnalysisDomError('http-denied')
    let projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 3 && data.requested.length === 6) {
        if (kind === 'metadata') { value.pageSize = 1; value.from = 3; value.to = 3; value.entries = value.entries.slice(0, 1) }
        if (kind === 'duplicate') overlapWith(value.entries[1], value.entries[0])
        if (kind === 'order') value.entries[1].rank = 1
        if (kind === 'denied') throw denied
        if (kind === 'cancelled') controller.abort()
      }
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1, signal: controller.signal }), error =>
      kind === 'denied' ? error === denied : error instanceof LegendAnalysisCollectionError)
    assert.equal(projections, 0); assert.deepEqual(data.requested, [1, 2, 3, 4, 2, 3])
    assert.deepEqual(ranges.at(-1), { attempt: 1, fromPage: 2, toPage: 4, lastValidatedPage: 2, status: 'failed',
      ...(kind === 'duplicate' ? { issues: [{ kind: 'within-page-duplicate', fromPage: 2, toPage: 4, conflict: {
        previous: { page: 3, rowIndex: 1, rank: 5, masterRating: 2396 },
        current: { page: 3, rowIndex: 2, rank: 6, masterRating: 2395 } } }] } : {}) })
  }
})

test('a later recovery starts from the new position of a member moved by range replacement', async () => {
  const data = movedRangeFixture(true), read = data.options.fetchPage, failures: LegendAnalysisAttemptFailure[] = [], ranges: LegendPageRecoveryRange[] = []
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 5) overlapWith(value.entries[0], data.values[2])
    return value
  }
  data.options.onAttemptFailure = value => { failures.push(value) }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.code === 'duplicate-entry')
  assert.deepEqual(data.requested, [1, 2, 3, 4, 2, 3, 4, 1, 5, 4, 5])
  assert.deepEqual(ranges.filter(range => range.lastValidatedPage === null).map(range => [range.fromPage, range.toPage]), [[2, 4], [4, 5]])
  assert.deepEqual(ranges.at(-1), { attempt: 1, fromPage: 4, toPage: 5, lastValidatedPage: 4, status: 'failed', issues: [
    { kind: 'recovery-range-duplicate', fromPage: 4, toPage: 5, conflict: {
      previous: { page: 4, rowIndex: 1, rank: 7, masterRating: 2394 },
      current: { page: 5, rowIndex: 1, rank: 9, masterRating: 2392 } } },
  ] })
  assert.equal(failures[0].pageRecoveryDecision?.reason, 'eligible')
  assert.equal(failures[0].pageRecoveryDecision?.recoveryUsed, true)
})

function multipleRecoveryFixture() {
  const values = Array.from({ length: 10 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
    characterId: 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: index < 9,
    playerName: `Original ${index + 1}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
  const data = fixture(values), read = data.options.fetchPage, counts = new Map<number, number>()
  const expected = structuredClone(values)
  expected[0].playerName = 'First refresh'; expected[0].masterRating++
  for (const entry of expected.slice(2, 8)) { entry.playerName = `Second refresh ${entry.playerId}`; entry.masterRating-- }
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url), count = (counts.get(page) ?? 0) + 1; counts.set(page, count)
    if (page === 2 && count === 1) value.entries[0].rank = 1
    if (page === 4 && count === 1) overlapWith(value.entries[0], values[3])
    if (page === 1 && count >= 2) value.entries[0] = { ...expected[0] }
    // The second range revisits page 2 already accepted by the first recovery.
    if (page >= 2 && page <= 4 && count >= (page === 2 ? 3 : 2)) {
      value.entries = structuredClone(expected.slice((page - 1) * 2, page * 2))
    }
    return value
  }
  return { ...data, expected, expectedRequests: [1, 2, 1, 2, 3, 4, 2, 3, 4, 1, 5, 5, 1] }
}

test('multiple overlapping range recoveries publish every updated player exactly once after complete validation', async () => {
  const data = multipleRecoveryFixture(), ranges: LegendPageRecoveryRange[] = [], events: string[] = []
  let projections = 0, rechecks = 0
  data.options.onPageRecovery = value => { events.push(value) }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  data.options.recheckOrderFailure = async () => { rechecks++; return { status: 'unavailable', elapsedMs: 1000 } }
  data.options.onVerifiedPlayers = rows => {
    projections++
    assert.deepEqual(rows.map(row => [row.playerId, row.playerName, row.rank, row.masterRating]),
      data.expected.filter(row => row.isLegend).map(row => [row.playerId, row.playerName, row.rank, row.masterRating]))
    assert.equal(new Set(rows.map(row => row.playerId)).size, 9)
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.retryCount, 0); assert.equal(result.pagesRead, 5); assert.equal(result.requestCount, 13)
  assert.equal(result.dataset.totalCount, 9); assert.equal(result.dataset.mr.max, 2401); assert.equal(result.dataset.mr.min, 2392)
  assert.equal(projections, 1); assert.equal(rechecks, 1)
  assert.deepEqual(data.requested, data.expectedRequests)
  assert.deepEqual(events, ['started', 'succeeded', 'started', 'succeeded'])
  assert.deepEqual(ranges.filter(range => range.status === 'succeeded'), [
    { attempt: 1, fromPage: 1, toPage: 2, lastValidatedPage: 2, status: 'succeeded' },
    { attempt: 1, fromPage: 2, toPage: 4, lastValidatedPage: 4, status: 'succeeded' },
  ])
})

test('a second successful recovery preserves a previously recovered missing member and refreshed moved rows', async () => {
  const data = movedRangeFixture(true), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = []
  const counts = new Map<number, number>()
  const expected = [...data.values.slice(0, 2), ...structuredClone(data.replacements), ...data.values.slice(8)]
  for (const entry of expected.slice(6, 8)) { entry.masterRating--; entry.playerName = `Refreshed again ${entry.playerId}` }
  let projections = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url), count = (counts.get(page) ?? 0) + 1; counts.set(page, count)
    if (page === 5 && count === 1) overlapWith(value.entries[0], data.values[2])
    if (page === 4 && count >= 3) value.entries = structuredClone(expected.slice(6, 8))
    return value
  }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  data.options.onVerifiedPlayers = rows => {
    projections++
    assert.deepEqual(rows.map(row => [row.playerId, row.playerName, row.rank, row.masterRating]),
      expected.filter(row => row.isLegend).map(row => [row.playerId, row.playerName, row.rank, row.masterRating]))
    assert.equal(new Set(rows.map(row => row.playerId)).size, 9)
    // Player 7 was absent until the first range recovery and remains in the prefix for the second.
    assert.equal(rows.find(row => row.playerId === '7')?.playerName, 'Updated 7')
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.requestCount, 14); assert.equal(result.retryCount, 0); assert.equal(result.dataset.totalCount, 9)
  assert.equal(projections, 1)
  assert.deepEqual(data.requested, [1, 2, 3, 4, 2, 3, 4, 1, 5, 4, 5, 3, 5, 1])
  assert.deepEqual(ranges.filter(range => range.status === 'succeeded').map(range => [range.fromPage, range.toPage]), [[2, 4], [4, 5]])
})

test('second recovery reserves its whole range plus anchor and never exceeds a tight shared request budget', async () => {
  for (const budget of [13, 12, 10, 9, 6]) {
    const data = multipleRecoveryFixture(), events: string[] = [], ranges: LegendPageRecoveryRange[] = [], failures: LegendAnalysisAttemptFailure[] = []
    let projections = 0
    data.options.onPageRecovery = value => { events.push(value) }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onAttemptFailure = value => { failures.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    const collect = collectLegendAnalysisDataset({ ...data.options, maxRequests: budget })
    if (budget === 13) assert.equal((await collect).requestCount, 13)
    else await assert.rejects(collect, error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'request-budget')
    // With only three requests remaining, not even the first read of the four-read range may start.
    const performed = budget < 10 ? 6 : budget
    assert.deepEqual(data.requested, data.expectedRequests.slice(0, performed))
    assert.equal(projections, budget === 13 ? 1 : 0)
    assert.deepEqual(events, budget < 10 ? ['started', 'succeeded'] : ['started', 'succeeded', 'started', 'succeeded'])
    assert.equal(ranges.filter(range => range.lastValidatedPage === null).length, budget < 10 ? 1 : 2)
    if (budget < 10) {
      assert.equal(failures[0].pageRecoveryDecision?.eligible, true)
      assert.equal(failures[0].pageRecoveryDecision?.recoveryUsed, true)
    }
  }
})

test('the same range may recover in both whole attempts without resetting the shared request budget', async () => {
  const expectedRequests = [1, 2, 1, 2, 3, 3, 1, 2, 1, 2, 3, 3, 1]
  for (const budget of [13, 12, 10, 9, 8]) {
    const data = adjacentFixture(), read = data.options.fetchPage, events: string[] = [], ranges: LegendPageRecoveryRange[] = []
    const failures: LegendAnalysisAttemptFailure[] = [], retries: number[] = []
    let secondReads = 0, thirdReads = 0, projections = 0
    data.values.forEach((entry, index) => { Object.assign(entry, { playerName: `Synthetic ${index}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }) })
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (page === 2 && [1, 3].includes(++secondReads)) value.entries[0].rank = 1
      if (page === 3 && ++thirdReads === 2) replaceListedMember(value.entries[0])
      return value
    }
    data.options.onPageRecovery = value => { events.push(value) }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onAttemptFailure = value => { failures.push(value) }
    data.options.onRetry = value => { retries.push(value) }
    data.options.onVerifiedPlayers = rows => { projections++; assert.deepEqual(rows.map(row => row.playerId), ['1', '2', '3', '4']) }
    const collect = collectLegendAnalysisDataset({ ...data.options, maxRequests: budget })
    if (budget === 13) {
      const result = await collect
      assert.equal(result.requestCount, 13); assert.equal(result.retryCount, 1)
    } else await assert.rejects(collect, error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'request-budget')
    assert.deepEqual(retries, [1]); assert.equal(projections, budget === 13 ? 1 : 0)
    assert.deepEqual(data.requested, expectedRequests.slice(0, budget < 10 ? 8 : budget))
    assert.deepEqual(events, budget < 10 ? ['started', 'succeeded'] : ['started', 'succeeded', 'started', 'succeeded'])
    assert.deepEqual(ranges.filter(range => range.lastValidatedPage === null).map(range => [range.attempt, range.fromPage, range.toPage]),
      budget < 10 ? [[1, 1, 2]] : [[1, 1, 2], [2, 1, 2]])
    assert.equal(failures[0].validationCheck, 'end-recheck')
    assert.equal('pageRecoveryDecision' in failures[0], false)
    if (budget < 10) assert.equal(failures[1].pageRecoveryDecision?.recoveryUsed, true)
  }
})

test('second recovery immediately stops on CAPTCHA denial, authentication, cancellation or terminal reader errors', async () => {
  for (const kind of ['http-denied', 'authentication-required', 'maintenance', 'cancelled', 'other'] as const) {
    const data = multipleRecoveryFixture(), read = data.options.fetchPage, events: string[] = [], retries: number[] = []
    const ranges: LegendPageRecoveryRange[] = [], controller = new AbortController()
    const terminal = kind === 'other' || kind === 'cancelled' ? new Error('private response') : new LegendAnalysisDomError(kind)
    let projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === 8) {
        if (kind === 'cancelled') controller.abort()
        else throw terminal
      }
      return value
    }
    data.options.onPageRecovery = value => { events.push(value) }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onRetry = value => { retries.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, signal: controller.signal }), error => kind === 'cancelled'
      ? error instanceof LegendAnalysisCollectionError && error.code === 'cancelled' : error === terminal)
    assert.equal(projections, 0); assert.deepEqual(retries, [])
    assert.deepEqual(events, ['started', 'succeeded', 'started'])
    assert.deepEqual(data.requested, data.expectedRequests.slice(0, 8))
    assert.deepEqual(ranges.at(-1), { attempt: 1, fromPage: 2, toPage: 4, lastValidatedPage: 2, status: 'failed' })
  }
})

test('prior successful recoveries never waive internal corruption or the final endpoint checks', async () => {
  for (const kind of ['internal-rank', 'internal-mr', 'internal-duplicate', 'end', 'start'] as const) {
    const data = multipleRecoveryFixture(), read = data.options.fetchPage, events: string[] = [], failures: LegendAnalysisAttemptFailure[] = []
    let projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url), count = data.requested.length
      if (count === 6) {
        if (kind === 'internal-rank') value.entries[1].rank = 1
        if (kind === 'internal-mr') value.entries[1].masterRating = 9999
        if (kind === 'internal-duplicate') overlapWith(value.entries[1], value.entries[0])
      }
      if (kind === 'end' && count === 12 || kind === 'start' && count === 13) replaceListedMember(value.entries[0])
      return value
    }
    data.options.onPageRecovery = value => { events.push(value) }
    data.options.onAttemptFailure = value => { failures.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError
      && error.validationCheck === ({ 'internal-rank': 'rank-order', 'internal-mr': 'mr-order', 'internal-duplicate': 'duplicate-entry', end: 'end-recheck', start: 'start-recheck' }[kind]))
    assert.equal(projections, 0)
    if (kind.startsWith('internal')) {
      assert.deepEqual(events, ['started', 'succeeded']); assert.deepEqual(data.requested, data.expectedRequests.slice(0, 6))
      assert.equal(failures[0].pageRecoveryDecision?.eligible, false)
      assert.equal(failures[0].pageRecoveryDecision?.recoveryUsed, true)
    } else {
      assert.deepEqual(events, ['started', 'succeeded', 'started', 'succeeded'])
      assert.deepEqual(data.requested, data.expectedRequests.slice(0, kind === 'end' ? 12 : 13))
      assert.equal('pageRecoveryDecision' in failures[0], false); assert.equal('orderDiagnostic' in failures[0], false)
    }
  }
})

function boundaryExpansionFixture(direction: 'left' | 'right') {
  const values = Array.from({ length: 12 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
    characterId: 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: index < 11,
    playerName: `Original ${index + 1}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
  const order = direction === 'left' ? [0, 1, 2, 7, 3, 4, 5, 6, 8, 9, 10, 11] : [0, 1, 2, 3, 4, 5, 6, 8, 7, 9, 10, 11]
  const fresh = order.map((source, index) => ({ ...values[source], rank: index + 1, masterRating: 2400 - index,
    playerName: source === index ? values[source].playerName : `Moved ${source + 1}` }))
  const data = fixture(values), read = data.options.fetchPage, counts = new Map<number, number>()
  let changed = false
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url), count = (counts.get(page) ?? 0) + 1; counts.set(page, count)
    if (page === 3 && count === 2) changed = true
    if (changed) value.entries = structuredClone(fresh.slice((page - 1) * 2, page * 2))
    if (page === 4 && count === 1) value.entries[0].rank = 5
    return value
  }
  return { ...data, fresh, expectedRequests: direction === 'left'
    ? [1, 2, 3, 4, 3, 2, 3, 4, 1, 5, 6, 6, 1]
    : [1, 2, 3, 4, 3, 4, 5, 2, 3, 4, 5, 1, 6, 6, 1] }
}

test('a fixed-prefix duplicate expands left even with a boundary inversion and atomically preserves every member', async () => {
  for (const multipleSources of [false, true]) {
    const data = boundaryExpansionFixture('left'), read = data.options.fetchPage, events: string[] = [], ranges: LegendPageRecoveryRange[] = []
    let projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === 5) {
        value.entries[0].rank = 3 // The same explicit fixed-prefix duplicate also inverts against the old left boundary.
        if (multipleSources) overlapWith(value.entries[1], data.values[1])
      }
      return value
    }
    data.options.onPageRecovery = value => { events.push(value) }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onVerifiedPlayers = rows => {
      projections++
      assert.deepEqual(rows.map(row => [row.playerId, row.rank, row.masterRating, row.playerName]),
        data.fresh.filter(row => row.isLegend).map(row => [row.playerId, row.rank, row.masterRating, row.playerName]))
      assert.equal(new Set(rows.map(row => row.playerId)).size, 11)
    }
    const result = await collectLegendAnalysisDataset(data.options)
    assert.equal(projections, 1); assert.equal(result.pagesRead, 6); assert.equal(result.retryCount, 0)
    assert.deepEqual(events, ['started', 'succeeded'])
    assert.deepEqual(data.requested, multipleSources ? [1, 2, 3, 4, 3, 1, 2, 3, 4, 5, 6, 6, 1] : data.expectedRequests)
    assert.deepEqual(ranges.at(-1)?.issues, [{ kind: 'fixed-prefix-duplicate', fromPage: 3, toPage: 4,
      conflict: multipleSources ? { previous: { page: 1, rowIndex: 2, rank: 2, masterRating: 2399 },
        current: { page: 3, rowIndex: 2, rank: 6, masterRating: 2395 } }
        : { previous: { page: 2, rowIndex: 2, rank: 4, masterRating: 2397 }, current: { page: 3, rowIndex: 1, rank: 3, masterRating: 2396 } },
      expansion: { fromPage: multipleSources ? 1 : 2, toPage: 4 } }])
  }
})

test('missing members trigger both halo pages and future pages join the final endpoint and pagesRead', async () => {
  const data = boundaryExpansionFixture('right'), events: string[] = [], ranges: LegendPageRecoveryRange[] = []
  let projections = 0
  data.options.onPageRecovery = value => { events.push(value) }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  data.options.onVerifiedPlayers = rows => {
    projections++
    assert.deepEqual(rows.map(row => row.playerId), data.fresh.filter(row => row.isLegend).map(row => row.playerId))
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.pagesRead, 6); assert.equal(result.requestCount, 15); assert.equal(projections, 1)
  assert.deepEqual(data.requested, data.expectedRequests); assert.deepEqual(events, ['started', 'succeeded'])
  assert.deepEqual(ranges.at(-1), { attempt: 1, fromPage: 2, toPage: 5, lastValidatedPage: 5, status: 'succeeded', issues: [
    { kind: 'missing-members', fromPage: 3, toPage: 4, missingCount: 1,
      missingPositions: [{ page: 4, rowIndex: 2, rank: 8, masterRating: 2393 }],
      missingDetails: [absentMember({ page: 4, rowIndex: 2, rank: 8, masterRating: 2393 }, 'trigger-page')], expansion: { fromPage: 2, toPage: 5 } },
  ] })
  // Previously emitted records are snapshots, not objects later altered by the expansion.
  assert.deepEqual(ranges[0], { attempt: 1, fromPage: 3, toPage: 4, lastValidatedPage: null, status: 'started' })
})

test('the observed 381-to-380 inversion shape can retain a member moving from page 21 into page 22', async () => {
  const rows = Array.from({ length: 440 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'), characterId: 'ryu',
    rank: index >= 380 && index < 400 ? 381 : index + 1,
    masterRating: index < 380 ? 2600 - index : index < 400 ? 1805 : 1804 - (index - 400), isLegend: index < 439,
    playerName: `Synthetic ${index}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
  const fresh = structuredClone(rows)
  for (const [target, source] of [[419, 420], [420, 419]]) Object.assign(fresh[target], { accountKey: rows[source].accountKey, playerId: rows[source].playerId, playerName: rows[source].playerName })
  const data = fixture(rows, 20), read = data.options.fetchPage, counts = new Map<number, number>(), ranges: LegendPageRecoveryRange[] = []
  let changed = false, projections = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url), count = (counts.get(page) ?? 0) + 1; counts.set(page, count)
    if (page === 20 && count === 2) changed = true
    if (changed) value.entries = structuredClone(fresh.slice((page - 1) * 20, page * 20))
    if (page === 21 && count === 1) Object.assign(value.entries[0], { rank: 380, masterRating: 1805 })
    return value
  }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  data.options.onVerifiedPlayers = players => { projections++; assert.deepEqual(players.map(row => row.playerId), fresh.slice(0, 439).map(row => row.playerId)) }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.pagesRead, 22); assert.equal(result.dataset.totalCount, 439); assert.equal(projections, 1)
  assert.deepEqual(data.requested, [...Array.from({ length: 21 }, (_, index) => index + 1), 20, 21, 22, 19, 20, 21, 22, 18, 22, 1])
  assert.deepEqual(ranges.at(-1)?.issues?.[0], { kind: 'missing-members', fromPage: 20, toPage: 21, missingCount: 1,
    missingPositions: [{ page: 21, rowIndex: 20, rank: 420, masterRating: 1785 }],
    missingDetails: [absentMember({ page: 21, rowIndex: 20, rank: 420, masterRating: 1785 }, 'trigger-page')], expansion: { fromPage: 19, toPage: 22 } })
})

test('members first seen in a failed candidate or right baseline cannot disappear in expanded passes', async () => {
  for (const observedAt of ['candidate', 'right-baseline'] as const) {
    const data = boundaryExpansionFixture('right'), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = [], events: string[] = []
    let projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      const observedRead = observedAt === 'candidate' ? 6 : 7
      if (data.requested.length === observedRead) {
        const entry = value.entries[1]
        Object.assign(entry, { accountKey: 'f'.repeat(64), playerId: '999', playerName: 'Observed new member' })
      }
      return value
    }
    data.options.onPageRecovery = value => { events.push(value) }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'range-missing-members')
    assert.equal(projections, 0); assert.deepEqual(events, ['started'])
    assert.deepEqual(data.requested, [1, 2, 3, 4, 3, 4, 5, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6])
    assert.equal(ranges.at(-1)?.fromPage, 1); assert.equal(ranges.at(-1)?.toPage, 6)
    const issues = ranges.at(-1)!.issues!
    assert.equal(issues.length, 3); assert.equal(issues[2].missingCount, 1)
    assert.deepEqual(issues[2].missingPositions, [{ page: observedAt === 'candidate' ? 4 : 5, rowIndex: 2,
      rank: observedAt === 'candidate' ? 8 : 10, masterRating: observedAt === 'candidate' ? 2393 : 2391 }])
    assert.equal('expansion' in issues[2], false)
    assert.doesNotMatch(JSON.stringify(ranges), /Observed new member|accountKey|playerId|999/)
  }
})

test('fixed-prefix expansion cannot conceal a within-page error or a duplicate already inside the rebuilding range', async () => {
  for (const kind of ['within-duplicate', 'within-order', 'range-duplicate'] as const) {
    const data = boundaryExpansionFixture('right'), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = []
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === (kind === 'range-duplicate' ? 6 : 5)) {
        overlapWith(value.entries[0], data.values[kind === 'range-duplicate' ? 4 : 3])
        if (kind === 'within-duplicate') overlapWith(value.entries[1], value.entries[0])
        if (kind === 'within-order') value.entries[1].rank = 1
        if (kind === 'range-duplicate') overlapWith(value.entries[1], data.values[3])
      }
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError
      && error.validationCheck === (kind === 'within-order' ? 'rank-order' : 'duplicate-entry'))
    assert.deepEqual(data.requested, [1, 2, 3, 4, 3, ...(kind === 'range-duplicate' ? [4] : [])])
    assert.equal(ranges.at(-1)?.issues?.some(issue => issue.expansion) ?? false, false)
    if (kind !== 'within-order') assert.equal(ranges.at(-1)?.issues?.[0].kind, kind === 'within-duplicate' ? 'within-page-duplicate' : 'recovery-range-duplicate')
  }
})

test('left expansion accepts a six-page span and refuses a seven-page span before any additional read', async () => {
  for (const lastPage of [6, 7]) {
    const rows = Array.from({ length: lastPage * 2 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
      characterId: 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: true }))
    const data = fixture(rows), read = data.options.fetchPage, counts = new Map<number, number>(), ranges: LegendPageRecoveryRange[] = []
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url), count = (counts.get(page) ?? 0) + 1; counts.set(page, count)
      if (page === lastPage && count === 1) value.entries[0].rank = (lastPage - 1) * 2 - 1
      if (page === lastPage - 1 && count === 2) overlapWith(value.entries[0], rows[0])
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    const collect = collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 })
    const listing = Array.from({ length: lastPage }, (_, index) => index + 1)
    if (lastPage === 6) {
      const result = await collect
      assert.equal(result.dataset.totalCount, 12); assert.equal(result.pagesRead, 6)
      assert.deepEqual(data.requested, [...listing, 5, ...listing, 6, 1])
      assert.deepEqual(ranges.at(-1)?.issues?.[0].expansion, { fromPage: 1, toPage: 6 })
    } else {
      await assert.rejects(collect, error => error instanceof LegendAnalysisCollectionError && error.code === 'duplicate-entry')
      assert.deepEqual(data.requested, [...listing, 6]); assert.equal(ranges.at(-1)?.issues?.[0].expansion, undefined)
    }
  }
})

test('halo expansion reserves baseline, complete recapture and anchor reads against the original request budget', async () => {
  for (const budget of [15, 12, 11]) {
    const data = boundaryExpansionFixture('right'), ranges: LegendPageRecoveryRange[] = []
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    const collect = collectLegendAnalysisDataset({ ...data.options, maxRequests: budget })
    if (budget === 15) assert.equal((await collect).requestCount, 15)
    else await assert.rejects(collect, error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'request-budget')
    assert.deepEqual(data.requested, data.expectedRequests.slice(0, budget === 11 ? 6 : budget))
    if (budget === 11) {
      assert.equal(ranges.at(-1)?.fromPage, 3); assert.equal(ranges.at(-1)?.toPage, 4)
      assert.equal(ranges.at(-1)?.issues?.[0].expansion, undefined)
    }
  }
})

test('invalid or denied new right baselines stop before recapturing the expanded range', async () => {
  for (const kind of ['rank', 'mr', 'duplicate', 'page-size', 'denied', 'cancelled'] as const) {
    const data = boundaryExpansionFixture('right'), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = [], retries: number[] = []
    const denied = new LegendAnalysisDomError('http-denied'), controller = new AbortController()
    let projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === 7) {
        if (kind === 'rank') value.entries[1].rank = 1
        if (kind === 'mr') value.entries[1].masterRating = 9999
        if (kind === 'duplicate') overlapWith(value.entries[1], value.entries[0])
        if (kind === 'page-size') { value.pageSize = 1; value.from = 5; value.to = 5; value.entries = value.entries.slice(0, 1) }
        if (kind === 'denied') throw denied
        if (kind === 'cancelled') controller.abort()
      }
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onRetry = value => { retries.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: ['denied', 'cancelled'].includes(kind) ? 2 : 1, signal: controller.signal }), error => kind === 'denied'
      ? error === denied : error instanceof LegendAnalysisCollectionError && error.validationCheck === ({ rank: 'rank-order', mr: 'mr-order', duplicate: 'duplicate-entry', 'page-size': 'page-size', cancelled: 'cancellation' }[kind]))
    assert.equal(projections, 0); assert.deepEqual(retries, []); assert.deepEqual(data.requested, data.expectedRequests.slice(0, 7))
    assert.equal(ranges.at(-1)?.status, 'failed'); assert.equal(ranges.at(-1)?.lastValidatedPage, null)
    if (kind === 'duplicate') assert.equal(ranges.at(-1)?.issues?.at(-1)?.kind, 'within-page-duplicate')
  }
})

test('a five-page range stays failed when neither checked edge contains its missing member', async () => {
  const rows = Array.from({ length: 18 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
    characterId: 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: true }))
  const data = fixture(rows), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = []
  let seventhReads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 7) {
      if (++seventhReads === 1) overlapWith(value.entries[0], rows[4])
      else value.entries[1].accountKey = 'f'.repeat(64)
    }
    return value
  }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'range-missing-members')
  assert.deepEqual(data.requested, [1, 2, 3, 4, 5, 6, 7, 3, 4, 5, 6, 7, 2, 8])
  assert.deepEqual(ranges.at(-1)?.issues, [{ kind: 'missing-members', fromPage: 3, toPage: 7, missingCount: 1,
    missingPositions: [{ page: 7, rowIndex: 2, rank: 14, masterRating: 2387 }],
    missingDetails: [absentMember({ page: 7, rowIndex: 2, rank: 14, masterRating: 2387 }, 'trigger-page')], edgeProbes: [
      { side: 'left', page: 2, unchanged: true, missingFoundCount: 0, found: [] },
      { side: 'right', page: 8, unchanged: null, missingFoundCount: 0, found: [] },
    ] }])
})

test('the new left anchor and both final endpoints remain mandatory after expansion', async () => {
  for (const failureRead of [12, 14, 15]) {
    const data = boundaryExpansionFixture('right'), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = []
    let projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === failureRead) {
        if (failureRead === 12) value.entries[0].masterRating++
        else replaceListedMember(value.entries[0])
      }
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError
      && error.validationCheck === (failureRead === 12 ? 'range-anchor-recheck' : failureRead === 14 ? 'end-recheck' : 'start-recheck'))
    assert.equal(projections, 0); assert.deepEqual(data.requested, data.expectedRequests.slice(0, failureRead))
    assert.equal(ranges.at(-1)?.status, failureRead === 12 ? 'failed' : 'succeeded')
  }
})

test('right halo availability follows the newly observed endpoint rather than its stale next-page value', async () => {
  for (const transition of ['grew', 'shrunk'] as const) {
    const data = boundaryExpansionFixture('right'), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = []
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (transition === 'grew' ? data.requested.length <= 4 : data.requested.length > 4) {
        value.totalCount = 8; value.nextPage = page < 4 ? page + 1 : null
      }
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    const collect = collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 })
    if (transition === 'grew') {
      assert.equal((await collect).dataset.totalCount, 11)
      assert.deepEqual(data.requested, data.expectedRequests)
      assert.deepEqual(ranges.at(-1)?.issues?.[0].expansion, { fromPage: 2, toPage: 5 })
    } else {
      await assert.rejects(collect, error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'range-missing-members')
      assert.deepEqual(data.requested, [1, 2, 3, 4, 3, 4, 2, 3, 4, 1, 2, 3, 4])
      assert.deepEqual(ranges.at(-1)?.issues?.map(issue => issue.expansion), [{ fromPage: 2, toPage: 4 }, { fromPage: 1, toPage: 4 }, undefined])
    }
  }
})

function fivePageMissingFixture() {
  const values = Array.from({ length: 16 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
    characterId: 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: index < 15,
    playerName: `Original ${index + 1}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
  const fresh = structuredClone(values)
  for (const [target, source] of [[8, 14], [14, 8]]) Object.assign(fresh[target], {
    accountKey: values[source].accountKey, playerId: values[source].playerId, playerName: `Moved ${values[source].playerId}` })
  const data = fixture(values), read = data.options.fetchPage, counts = new Map<number, number>()
  let changed = false
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url), count = (counts.get(page) ?? 0) + 1; counts.set(page, count)
    if (page === 3 && count === 2) changed = true
    if (changed) value.entries = structuredClone(fresh.slice((page - 1) * 2, page * 2))
    if (page === 7 && count === 1) overlapWith(value.entries[0], values[4])
    return value
  }
  return { ...data, fresh, expectedRequests: [1, 2, 3, 4, 5, 6, 7, 3, 4, 5, 6, 7, 2, 8, 3, 4, 5, 6, 7, 8, 2, 8, 1] }
}

test('a missing member found on the right after an unchanged left probe enables one six-page recapture', async () => {
  const data = fivePageMissingFixture(), ranges: LegendPageRecoveryRange[] = [], events: string[] = []
  let projections = 0
  data.options.onPageRecovery = state => { events.push(state) }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  data.options.onVerifiedPlayers = rows => {
    projections++
    assert.deepEqual(rows.map(row => [row.playerId, row.rank, row.masterRating]), data.fresh.filter(row => row.isLegend).map(row => [row.playerId, row.rank, row.masterRating]))
    assert.equal(new Set(rows.map(row => row.playerId)).size, 15)
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.pagesRead, 8); assert.equal(result.requestCount, 23); assert.equal(projections, 1)
  assert.deepEqual(data.requested, data.expectedRequests); assert.deepEqual(events, ['started', 'succeeded'])
  assert.deepEqual(ranges.at(-1)?.issues, [{ kind: 'missing-members', fromPage: 3, toPage: 7, missingCount: 1,
    missingPositions: [{ page: 5, rowIndex: 1, rank: 9, masterRating: 2392 }],
    missingDetails: [absentMember({ page: 5, rowIndex: 1, rank: 9, masterRating: 2392 }, 'saved-page')],
    edgeProbes: [
      { side: 'left', page: 2, unchanged: true, missingFoundCount: 0, found: [] },
      { side: 'right', page: 8, unchanged: null, missingFoundCount: 1, found: [
        { previous: { page: 5, rowIndex: 1, rank: 9, masterRating: 2392 }, current: { page: 8, rowIndex: 1, rank: 15, masterRating: 2386 } },
      ] },
    ], expansion: { fromPage: 3, toPage: 8 },
  }])
  const beforeProbe = ranges.find(range => range.issues?.[0].edgeProbes?.length === 1)!
  assert.equal(beforeProbe.issues![0].edgeProbes!.length, 1); assert.equal(beforeProbe.issues![0].expansion, undefined)
})

test('an old page 16 row 2 member can be located on page 19 without widening beyond six pages', async () => {
  const rows = Array.from({ length: 400 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'), characterId: 'ryu',
    rank: index >= 297 && index <= 302 ? 298 : index + 1,
    masterRating: index < 297 ? 2111 - index : index <= 302 ? 1814 : 1813 - (index - 303), isLegend: index < 399,
    playerName: `Synthetic ${index}`, playerId: `${index + 1}`, region: '日本', platform: 'Steam' }))
  const fresh = structuredClone(rows)
  for (const [target, source] of [[301, 360], [360, 301]]) Object.assign(fresh[target], { accountKey: rows[source].accountKey, playerName: rows[source].playerName, playerId: rows[source].playerId })
  const data = fixture(rows, 20), read = data.options.fetchPage, counts = new Map<number, number>(), ranges: LegendPageRecoveryRange[] = []
  let changed = false, projections = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url), count = (counts.get(page) ?? 0) + 1; counts.set(page, count)
    if (page === 14 && count === 2) changed = true
    if (changed) value.entries = structuredClone(fresh.slice((page - 1) * 20, page * 20))
    if (page === 18 && count === 1) overlapWith(value.entries[19], rows[279])
    return value
  }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  data.options.onVerifiedPlayers = rows => { projections++; assert.deepEqual(rows.map(row => row.playerId), fresh.slice(0, 399).map(row => row.playerId)) }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(projections, 1); assert.equal(result.pagesRead, 20); assert.equal(result.dataset.totalCount, 399)
  assert.deepEqual(data.requested, [...Array.from({ length: 18 }, (_, index) => index + 1), 14, 15, 16, 17, 18, 13, 19, 14, 15, 16, 17, 18, 19, 13, 20, 20, 1])
  const issue = ranges.at(-1)!.issues![0]
  assert.deepEqual(issue.missingPositions, [{ page: 16, rowIndex: 2, rank: 298, masterRating: 1814 }])
  assert.deepEqual(issue.expansion, { fromPage: 14, toPage: 19 })
  assert.deepEqual(issue.edgeProbes?.[1].found, [{ previous: { page: 16, rowIndex: 2, rank: 298, masterRating: 1814 },
    current: { page: 19, rowIndex: 1, rank: 361, masterRating: 1756 } }])
})

test('a left probe finding the member cannot drop displaced members or begin a recapture that exceeds row capacity', async () => {
  const data = fivePageMissingFixture(), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = []
  let projections = 0
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (page === 2 && data.requested.length >= 13) {
      const target = value.entries[1]
      Object.assign(target, { accountKey: data.values[8].accountKey, playerName: data.values[8].playerName, playerId: data.values[8].playerId })
    }
    return value
  }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  data.options.onVerifiedPlayers = () => { projections++ }
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'range-missing-members')
  assert.equal(projections, 0)
  assert.deepEqual(data.requested, [1, 2, 3, 4, 5, 6, 7, 3, 4, 5, 6, 7, 2])
  assert.equal(ranges.at(-1)?.issues?.[0].expansion, undefined)
  assert.equal(ranges.at(-1)?.issues?.[0].edgeProbes?.length, 1)
  assert.equal(ranges.at(-1)?.issues?.[0].edgeProbes?.[0].missingFoundCount, 1)
  assert.equal(ranges.at(-1)?.issues?.length, 1)
})

test('the full nine-read probe reserve is required before either edge is read', async () => {
  for (const budget of [23, 21, 20]) {
    const data = fivePageMissingFixture(), ranges: LegendPageRecoveryRange[] = []
    let projections = 0
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    const collect = collectLegendAnalysisDataset({ ...data.options, maxRequests: budget })
    if (budget === 23) assert.equal((await collect).requestCount, 23)
    else await assert.rejects(collect, error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'request-budget')
    assert.equal(projections, budget === 23 ? 1 : 0)
    assert.deepEqual(data.requested, data.expectedRequests.slice(0, budget === 20 ? 12 : budget))
    const issue = ranges.at(-1)?.issues?.[0]
    assert.equal(issue?.edgeProbes?.length, budget === 20 ? undefined : 2)
    assert.equal(issue?.expansion?.toPage, budget === 20 ? undefined : 8)
  }
})

test('changed left probes and partially matching edge probes never authorize a recapture', async () => {
  for (const kind of ['changed', 'partial', 'right-partial'] as const) {
    const data = fivePageMissingFixture(), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = []
    if (kind !== 'changed') Object.assign(data.fresh[9], { accountKey: 'f'.repeat(64), playerId: '999', playerName: 'Other' })
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === 13) {
        if (kind === 'changed') value.entries[0].playerName = 'Changed left anchor'
        else if (kind === 'partial') overlapWith(value.entries[1], data.values[8])
      }
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'range-missing-members')
    assert.deepEqual(data.requested, data.expectedRequests.slice(0, kind === 'right-partial' ? 14 : 13))
    const issue = ranges.at(-1)!.issues![0]
    assert.equal(issue.expansion, undefined); assert.equal(issue.edgeProbes?.length, kind === 'right-partial' ? 2 : 1)
    assert.equal(issue.edgeProbes?.[0].unchanged, kind === 'right-partial')
    assert.equal(issue.edgeProbes?.at(-1)?.missingFoundCount, kind === 'changed' ? 0 : 1)
    assert.equal(issue.missingCount, kind === 'changed' ? 1 : 2)
  }
})

test('every observed right-baseline member stays mandatory and baseline reuse is counted only once', async () => {
  const data = fivePageMissingFixture(), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = []
  data.values.forEach(entry => { entry.isLegend = true }); data.fresh.forEach(entry => { entry.isLegend = true })
  data.options.fetchPage = async (page, url) => {
    const value = await read(page, url)
    if (data.requested.length === 14) Object.assign(value.entries[1], { accountKey: 'f'.repeat(64), playerId: '999', playerName: 'Baseline member' })
    return value
  }
  data.options.onPageRecoveryRange = value => { ranges.push(value) }
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'range-missing-members')
  assert.deepEqual(data.requested, data.expectedRequests.slice(0, 20))
  assert.deepEqual(ranges.at(-1)?.issues?.[1].missingDetails, [absentMember({ page: 8, rowIndex: 2, rank: 16, masterRating: 2385 }, 'right-baseline')])
  assert.equal(ranges.at(-1)?.issues?.[1].edgeProbes, undefined)
})

test('terminal access denial and malformed edge probes stop immediately with no recapture or retry', async () => {
  for (const kind of ['left-denied', 'right-denied', 'right-cancelled', 'left-metadata', 'right-duplicate', 'left-order'] as const) {
    const data = fivePageMissingFixture(), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = [], retries: number[] = []
    const denied = new LegendAnalysisDomError('http-denied'), controller = new AbortController()
    const failureRead = kind.startsWith('left') ? 13 : 14
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === failureRead) {
        if (kind.endsWith('denied')) throw denied
        if (kind.endsWith('cancelled')) controller.abort()
        if (kind === 'left-metadata') { value.pageSize = 1; value.from = 2; value.to = 2; value.entries = value.entries.slice(0, 1) }
        if (kind === 'right-duplicate') overlapWith(value.entries[1], value.entries[0])
        if (kind === 'left-order') value.entries[1].rank = 1
      }
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onRetry = value => { retries.push(value) }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: kind.endsWith('denied') || kind.endsWith('cancelled') ? 2 : 1, signal: controller.signal }), error => kind.endsWith('denied')
      ? error === denied : error instanceof LegendAnalysisCollectionError)
    assert.deepEqual(retries, []); assert.deepEqual(data.requested, data.expectedRequests.slice(0, failureRead))
    assert.equal(ranges.at(-1)?.issues?.[0].expansion, undefined)
    assert.equal(ranges.at(-1)?.issues?.[0].edgeProbes?.length, failureRead === 13 ? undefined : 1)
  }
})

test('missing diagnostics distinguish another character of the same account without accepting it as the missing entry', async () => {
  for (const sameAccount of [false, true]) {
    const data = fivePageMissingFixture(), ranges: LegendPageRecoveryRange[] = []
    if (sameAccount) Object.assign(data.fresh[8], { accountKey: data.values[8].accountKey, characterId: 'ken' })
    // Keep the original identity absent even from the right edge, so the diagnostic remains a failure.
    Object.assign(data.fresh[14], { accountKey: 'e'.repeat(64), playerId: '998', playerName: 'Unrelated' })
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'range-missing-members')
    const detail = ranges.at(-1)!.issues![0].missingDetails![0]
    assert.deepEqual(detail.firstSeen, { page: 5, rowIndex: 1, rank: 9, masterRating: 2392 })
    assert.deepEqual(detail.lastSeen, detail.firstSeen); assert.equal(detail.firstSeenSource, 'saved-page'); assert.equal(detail.observations, 1)
    assert.equal(detail.accountPresence, sameAccount ? 'other-character-in-range' : 'absent-from-range')
    assert.equal(detail.sameAccountRowsCount, sameAccount ? 1 : 0)
    assert.deepEqual(detail.sameAccountPositions, sameAccount ? [{ page: 5, rowIndex: 1, rank: 9, masterRating: 2392 }] : [])
    assert.doesNotMatch(JSON.stringify(ranges), /accountKey|characterId|playerId|playerName|Unrelated|Original|Moved/)
  }
})

test('a missing member observed as non-Legend in either edge is recorded and rejected before expansion selection', async () => {
  for (const side of ['left', 'right'] as const) {
    const data = fivePageMissingFixture(), read = data.options.fetchPage, ranges: LegendPageRecoveryRange[] = [], failures: LegendAnalysisAttemptFailure[] = []
    const failureRead = side === 'left' ? 13 : 14
    let projections = 0
    data.options.fetchPage = async (page, url) => {
      const value = await read(page, url)
      if (data.requested.length === failureRead) {
        const entry = value.entries[side === 'left' ? 1 : 0]
        if (side === 'left') overlapWith(entry, data.values[8])
        entry.isLegend = false // Both probes remain internally contiguous: Legend/non-Legend or non-Legend/non-Legend.
      }
      return value
    }
    data.options.onPageRecoveryRange = value => { ranges.push(value) }
    data.options.onAttemptFailure = value => { failures.push(value) }
    data.options.onVerifiedPlayers = () => { projections++ }
    await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxAttempts: 1 }), error => error instanceof LegendAnalysisCollectionError && error.validationCheck === 'range-legend-changed')
    assert.equal(projections, 0); assert.deepEqual(data.requested, data.expectedRequests.slice(0, failureRead))
    assert.equal(failures[0].validationCheck, 'range-legend-changed')
    const issue = ranges.at(-1)!.issues![0], probe = issue.edgeProbes!.at(-1)!
    assert.equal(issue.expansion, undefined); assert.equal(probe.side, side); assert.equal(probe.missingFoundCount, 1)
    assert.deepEqual(probe.found[0].previous, { page: 5, rowIndex: 1, rank: 9, masterRating: 2392 })
    assert.equal(probe.found[0].current.page, side === 'left' ? 2 : 8)
  }
})
