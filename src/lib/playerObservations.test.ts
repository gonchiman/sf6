import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlayerObservationDataset, PlayerObservationRun } from '../types/playerObservations.ts'
import {
  PLAYER_OBSERVATION_CONDITIONS, PLAYER_OBSERVATION_SOURCE, clearPlayerObservationRequests,
  filterPlayerObservationRuns, initialPlayerObservationSelection, loadPlayerObservations,
  parsePlayerObservationDataset, playerObservationDateRange, playerObservationRunCountLabel,
  playerObservationRunDate, playerObservationRunStatusLabel,
} from './playerObservations.ts'

function baselineProbe(overrides: Partial<PlayerObservationRun> = {}): PlayerObservationRun {
  return {
    id: 'baseline-probe', phase: 'baseline', status: 'partial', scope: 'probe',
    scheduledAt: '2026-10-13T01:04:47.614Z', startedAt: '2026-10-13T01:04:47.614Z',
    endedAt: '2026-10-13T01:09:12.740Z', observedIdCount: 60,
    newObservedCount: null, newObservedLowerBound: null,
    pages: { expectedAtStart: 152759, expectedAtEnd: 152759, succeeded: 3, failed: 0, sampledPages: [1, 2, 3] },
    coverage: 'sample', reportedTotalAtStart: 3055169, reportedTotalAtEnd: 3055172,
    warnings: ['部分取得。基準走査は未完了。'], failureReason: null, ...overrides,
  }
}

function dataset(runs = [baselineProbe()]): PlayerObservationDataset {
  return {
    schemaVersion: 1, definitionVersion: 1, seriesId: 'buckler-max-lp-v1', generatedAt: '2026-10-16T09:00:00Z',
    source: { ...PLAYER_OBSERVATION_SOURCE, notes: [...PLAYER_OBSERVATION_SOURCE.notes] },
    conditions: { ...PLAYER_OBSERVATION_CONDITIONS }, baseline: { status: 'preparing', completedAt: null }, runs,
  }
}

function baselineComplete(): PlayerObservationRun {
  return baselineProbe({
    id: 'baseline-complete', status: 'complete', scope: 'population',
    scheduledAt: '2026-10-13T01:00:00Z', startedAt: '2026-10-13T01:00:00Z', endedAt: '2026-10-13T14:30:00Z',
    observedIdCount: 35, pages: { expectedAtStart: 2, expectedAtEnd: 2, succeeded: 2, failed: 0, sampledPages: [] },
    coverage: 'all-pages', reportedTotalAtStart: 35, reportedTotalAtEnd: 35, warnings: [],
  })
}

function observation(overrides: Partial<PlayerObservationRun> = {}): PlayerObservationRun {
  return {
    ...baselineComplete(), id: 'observation-complete', phase: 'observation', scheduledAt: '2026-10-13T14:45:00Z',
    startedAt: '2026-10-13T14:50:00Z', endedAt: '2026-10-14T00:30:00Z',
    observedIdCount: 36, newObservedCount: 1, reportedTotalAtEnd: 36, ...overrides,
  }
}

function readyDataset(runs = [baselineComplete(), observation()]): PlayerObservationDataset {
  return { ...dataset(runs), baseline: { status: 'ready', completedAt: baselineComplete().endedAt } }
}

function missing(overrides: Partial<PlayerObservationRun> = {}): PlayerObservationRun {
  return observation({
    id: 'missing', status: 'missing', scheduledAt: '2026-10-15T00:00:00Z', startedAt: null, endedAt: null,
    observedIdCount: null, newObservedCount: null,
    pages: { expectedAtStart: null, expectedAtEnd: null, succeeded: 0, failed: 0, sampledPages: [] },
    coverage: 'none', reportedTotalAtStart: null, reportedTotalAtEnd: null, ...overrides,
  })
}

test('baseline probe counts stay unknown and preserve actual sampled ID counts', () => {
  const input = dataset()
  assert.deepEqual(parsePlayerObservationDataset(input), input)
  assert.equal(playerObservationRunCountLabel(input.runs[0]), '—')
  assert.equal(playerObservationRunStatusLabel(input.runs[0]), '基準準備（部分取得）')
  for (const field of ['newObservedCount', 'newObservedLowerBound'] as const) {
    assert.throws(() => parsePlayerObservationDataset(dataset([baselineProbe({ [field]: 0 })])), /unavailable/)
  }
})

test('zero, unknown and provisional observations remain distinct', () => {
  const zero = observation({ newObservedCount: 0 })
  const partial = observation({
    id: 'observation-partial', status: 'partial', coverage: 'incomplete', newObservedCount: null, newObservedLowerBound: 1,
  })
  const input = readyDataset([baselineComplete(), zero, partial, missing()])
  assert.deepEqual(parsePlayerObservationDataset(input), input)
  assert.equal(playerObservationRunCountLabel(zero), '0')
  assert.equal(playerObservationRunCountLabel(partial), '少なくとも 1 件（暫定）')
  assert.equal(playerObservationRunCountLabel(missing()), '—')
  assert.equal(playerObservationRunStatusLabel(zero), '走査完了')
  assert.equal(playerObservationRunStatusLabel(missing()), '欠測')
})

test('a probe after baseline may retain provisional first observations without claiming completeness', () => {
  const probe = observation({
    id: 'post-baseline-probe', status: 'partial', scope: 'probe', coverage: 'sample',
    observedIdCount: 20, newObservedCount: null, newObservedLowerBound: 3,
    pages: { expectedAtStart: 2, expectedAtEnd: 2, succeeded: 1, failed: 0, sampledPages: [1] },
  })
  assert.equal(parsePlayerObservationDataset(readyDataset([baselineComplete(), probe])).runs[1].newObservedLowerBound, 3)
  assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), { ...probe, newObservedCount: 3 }])), /incomplete scan/)
})

test('public schema excludes unknown private fields at every object boundary', () => {
  for (const path of ['dataset', 'source', 'conditions', 'baseline', 'run', 'pages']) {
    const input = structuredClone(dataset()) as unknown as Record<string, unknown>
    const target = path === 'dataset' ? input
      : path === 'run' ? (input.runs as Record<string, unknown>[])[0]
        : path === 'pages' ? (input.runs as Record<string, unknown>[])[0].pages as Record<string, unknown>
          : input[path] as Record<string, unknown>
    target.cfnIds = ['1234567890']
    assert.throws(() => parsePlayerObservationDataset(input), /unknown field/)
  }
  for (const field of ['cookies', 'authorization', 'apiToken']) {
    assert.throws(() => parsePlayerObservationDataset({ ...dataset(), [field]: 'private' }), /unknown field/)
  }
  const missingRequired = structuredClone(dataset()) as unknown as Record<string, unknown>
  delete missingRequired.definitionVersion
  assert.throws(() => parsePlayerObservationDataset(missingRequired), /required/)
})

test('series, definition and fixed population filters cannot silently change', () => {
  for (const changed of [{ schemaVersion: 2 }, { definitionVersion: 2 }, { seriesId: 'rookie' }]) {
    assert.throws(() => parsePlayerObservationDataset({ ...dataset(), ...changed }))
  }
  for (const key of Object.keys(PLAYER_OBSERVATION_CONDITIONS)) {
    const input = dataset()
    ;(input.conditions as unknown as Record<string, unknown>)[key] = 'other'
    assert.throws(() => parsePlayerObservationDataset(input), /conditions/)
  }
  for (const url of [`${PLAYER_OBSERVATION_SOURCE.url}?token=secret`, 'http://www.streetfighter.com/6/buckler/ja-jp/ranking/league', 'https://example.com/data']) {
    const input = dataset(); input.source.url = url
    assert.throws(() => parsePlayerObservationDataset(input), /source.url/)
  }
})

test('unsafe, negative, fractional and inconsistent counts are rejected', () => {
  for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parsePlayerObservationDataset(dataset([baselineProbe({ observedIdCount: count })])), /observedIdCount/)
  }
  assert.throws(() => parsePlayerObservationDataset(dataset([baselineProbe({ observedIdCount: 61 })])), /exceeds captured rows/)
  assert.throws(() => parsePlayerObservationDataset(dataset([baselineProbe({ observedIdCount: null })])), /required for successful pages/)
  assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), observation({ newObservedCount: 37 })])), /exceeds observed IDs/)
  assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), observation({ status: 'partial', coverage: 'incomplete', newObservedCount: null, newObservedLowerBound: 37 })])), /exceeds observed IDs/)
})

test('completed scans require all-page metadata rather than a nonempty sample', () => {
  const invalidRuns: PlayerObservationRun[] = [
    observation({ coverage: 'incomplete' }),
    observation({ scope: 'probe', pages: { ...observation().pages, sampledPages: [1, 2] } }),
    observation({ pages: { ...observation().pages, expectedAtEnd: null } }),
    observation({ pages: { ...observation().pages, expectedAtEnd: 0 } }),
    observation({ pages: { ...observation().pages, expectedAtEnd: 3 } }),
    observation({ pages: { ...observation().pages, failed: 1 } }),
    observation({ reportedTotalAtEnd: null }),
    observation({ newObservedCount: null }),
    observation({ newObservedLowerBound: 1 }),
  ]
  for (const run of invalidRuns) assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), run])))
  assert.equal(parsePlayerObservationDataset(readyDataset()).runs[0].newObservedCount, null)
})

test('sample page identities and aggregate population coverage cannot be confused', () => {
  for (const sampledPages of [[1, 1, 2], [0, 1, 2], [1, 2], [1, 2, 3.5]]) {
    assert.throws(() => parsePlayerObservationDataset(dataset([baselineProbe({ pages: { ...baselineProbe().pages, sampledPages } })])), /sampledPages/)
  }
  assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), observation({ pages: { ...observation().pages, sampledPages: [1, 2] } })])), /aggregate coverage/)
  assert.throws(() => parsePlayerObservationDataset(dataset([baselineProbe({ coverage: 'none' })])), /successful pages/)
  assert.throws(() => parsePlayerObservationDataset(dataset([baselineProbe({ pages: { ...baselineProbe().pages, expectedAtEnd: 2 } })])), /source total mismatch/)
  assert.throws(() => parsePlayerObservationDataset(dataset([baselineProbe({ reportedTotalAtEnd: 0 })])), /empty source/)
})

test('ready baseline must refer to its completed scan and precede observations', () => {
  assert.throws(() => parsePlayerObservationDataset({ ...dataset(), baseline: { status: 'ready', completedAt: '2026-10-13T14:30:00Z' } }), /completed scan mismatch/)
  assert.throws(() => parsePlayerObservationDataset({ ...readyDataset(), baseline: { status: 'ready', completedAt: '2026-10-13T14:31:00Z' } }), /completed scan mismatch/)
  assert.throws(() => parsePlayerObservationDataset(dataset([baselineComplete()])), /completed scan mismatch/)
  assert.throws(() => parsePlayerObservationDataset(dataset([observation()])), /baseline not ready/)
  assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), observation({ scheduledAt: '2026-10-13T13:00:00Z', startedAt: '2026-10-13T13:00:00Z' })])), /baseline not ready/)
  const duplicate = observation({ id: baselineComplete().id })
  assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), duplicate])), /duplicate/)
})

test('missing observations from baseline preparation remain valid after the baseline becomes ready', () => {
  const beforeBaseline = missing({
    id: 'baseline-missing', phase: 'baseline', scheduledAt: '2026-10-13T00:00:00Z',
  })
  const input = readyDataset([beforeBaseline, baselineComplete(), observation()])
  assert.deepEqual(parsePlayerObservationDataset(input), input)
  assert.equal(playerObservationRunStatusLabel(beforeBaseline), '基準準備（欠測）')
  assert.equal(playerObservationRunCountLabel(beforeBaseline), '—')
  assert.throws(() => parsePlayerObservationDataset(readyDataset([
    { ...beforeBaseline, scheduledAt: '2026-10-14T00:00:00Z' }, baselineComplete(), observation(),
  ])), /baseline phase after completion/)
})

test('timestamps require real calendar dates, capture intervals and consistent order', () => {
  for (const generatedAt of ['2026-02-29T12:00:00Z', '2026-13-01T12:00:00Z', '2026-10-16', 'invalid']) {
    assert.throws(() => parsePlayerObservationDataset({ ...dataset(), generatedAt }), /generatedAt/)
  }
  for (const run of [
    baselineProbe({ startedAt: '2026-10-13T01:00:00Z' }),
    baselineProbe({ endedAt: '2026-10-13T01:00:00Z' }),
    baselineProbe({ endedAt: '2026-10-17T00:00:00Z' }),
    baselineProbe({ startedAt: null }), baselineProbe({ endedAt: null }),
  ]) assert.throws(() => parsePlayerObservationDataset(dataset([run])), /timestamps/)
  const running = observation({ status: 'running', endedAt: null, coverage: 'incomplete', newObservedCount: null, newObservedLowerBound: 1 })
  assert.equal(parsePlayerObservationDataset(readyDataset([baselineComplete(), running])).runs[1].endedAt, null)
  assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), { ...running, endedAt: observation().endedAt }])), /running/)
})

test('missing and failed attempts cannot become zero observations', () => {
  const failed = missing({ status: 'failed', endedAt: '2026-10-15T00:00:10Z', failureReason: '取得条件を確認できませんでした。' })
  const input = readyDataset([baselineComplete(), missing(), { ...failed, id: 'failed' }])
  assert.deepEqual(parsePlayerObservationDataset(input), input)
  for (const status of ['missing', 'failed'] as const) {
    const unavailable = status === 'missing' ? missing() : failed
    assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), { ...unavailable, newObservedCount: 0 }])), /unavailable/)
    assert.throws(() => parsePlayerObservationDataset(readyDataset([baselineComplete(), { ...unavailable, observedIdCount: 0 }])))
  }
})

test('JST date filtering overlaps multi-day intervals and preserves original provisional runs', () => {
  const partial = observation({ id: 'partial', status: 'partial', coverage: 'incomplete', newObservedCount: null, newObservedLowerBound: 1 })
  const later = observation({ id: 'later', scheduledAt: '2026-10-15T00:00:00Z', startedAt: '2026-10-15T00:00:00Z', endedAt: '2026-10-15T01:00:00Z', newObservedCount: 0 })
  const input = parsePlayerObservationDataset(readyDataset([later, baselineComplete(), partial, missing()]))
  const selection = { fromDate: '2026-10-14', toDate: '2026-10-14', status: 'all' as const }
  assert.deepEqual(filterPlayerObservationRuns(input, selection).map(item => item.id), ['partial'])
  assert.equal(playerObservationRunDate(partial), '2026-10-13')
  assert.equal(filterPlayerObservationRuns(input, { ...selection, fromDate: '2026-10-13', status: 'partial' })[0].newObservedLowerBound, 1)
  assert.deepEqual(filterPlayerObservationRuns(input, { ...selection, fromDate: '2026-10-13', status: 'baseline' }).map(item => item.id), ['baseline-complete'])
  assert.deepEqual(playerObservationDateRange(input), { fromDate: '2026-10-13', toDate: '2026-10-15' })
  assert.deepEqual(initialPlayerObservationSelection(input), { fromDate: '2026-10-13', toDate: '2026-10-15', status: 'all' })
  assert.throws(() => filterPlayerObservationRuns(input, { ...selection, fromDate: '2026-02-29' }), /fromDate/)
  assert.throws(() => filterPlayerObservationRuns(input, { ...selection, fromDate: '2026-10-15' }), /開始日/)
})

test('running intervals extend to publication time and an empty series has a defined date range', () => {
  const running = observation({ status: 'running', endedAt: null, newObservedCount: null, coverage: 'incomplete' })
  const input = parsePlayerObservationDataset(readyDataset([baselineComplete(), running]))
  assert.equal(filterPlayerObservationRuns(input, { fromDate: '2026-10-16', toDate: '2026-10-16', status: 'running' }).length, 1)
  assert.deepEqual(playerObservationDateRange(dataset([])), { fromDate: '2026-10-16', toDate: '2026-10-16' })
})

test('loader shares successful requests and retries HTTP and parser failures', async () => {
  const original = globalThis.fetch
  let calls = 0
  const urls: string[] = []
  try {
    clearPlayerObservationRequests()
    globalThis.fetch = async input => { calls++; urls.push(String(input)); return new Response(JSON.stringify(dataset())) }
    const first = loadPlayerObservations()
    const second = loadPlayerObservations()
    assert.equal(first, second)
    await Promise.all([first, second])
    assert.equal(calls, 1)
    assert.equal(urls[0], '/data/player-observations/index.json')
    clearPlayerObservationRequests()
    globalThis.fetch = async () => { calls++; return calls === 2 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ ...dataset(), cfnIds: [] })) }
    await assert.rejects(loadPlayerObservations(), /読み込めません/)
    await assert.rejects(loadPlayerObservations(), /unknown field/)
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(dataset())) }
    assert.equal((await loadPlayerObservations()).runs[0].observedIdCount, 60)
    assert.equal(calls, 4)
  } finally { globalThis.fetch = original; clearPlayerObservationRequests() }
})

test('a cleared older failure cannot remove the replacement request cache', async () => {
  const original = globalThis.fetch
  let rejectOld!: (reason: Error) => void
  let calls = 0
  try {
    clearPlayerObservationRequests()
    globalThis.fetch = async () => {
      calls++
      if (calls === 1) return new Promise<Response>((_, reject) => { rejectOld = reject })
      return new Response(JSON.stringify(dataset()))
    }
    const old = loadPlayerObservations()
    const rejected = assert.rejects(old, /old failure/)
    await Promise.resolve()
    clearPlayerObservationRequests()
    const replacement = loadPlayerObservations()
    await replacement
    rejectOld(new Error('old failure'))
    await rejected
    assert.equal(loadPlayerObservations(), replacement)
    assert.equal(calls, 2)
  } finally { globalThis.fetch = original; clearPlayerObservationRequests() }
})
