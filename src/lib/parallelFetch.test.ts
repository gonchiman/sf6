import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PARALLEL_FETCH_CONFIG, parseParallelFetchConcurrencyInput, parseParallelFetchConfig, parseParallelFetchReadDiagnostics, parseParallelFetchReport,
  PARALLEL_FETCH_MAX_CONCURRENCY, PARALLEL_FETCH_MAX_POST_STOP_MS, PARALLEL_FETCH_MAX_TRACE_NETWORK_EVENTS, PARALLEL_FETCH_MAX_TRACE_OBSERVATIONS,
  minimumPlannedWaitMs, parallelFetchIntervals, plannedParallelFetchAttempts, summarizeParallelFetch } from './parallelFetch.ts'
import type { ParallelFetchReadDiagnostics, ParallelFetchReport, ParallelFetchTrial } from '../types/parallelFetch.ts'

const startedAt = '2026-10-20T00:00:00.000Z', finishedAt = '2026-10-20T00:10:00.000Z'
function fixture(concurrencies = DEFAULT_PARALLEL_FETCH_CONFIG.concurrencies): ParallelFetchReport {
  const config = structuredClone(DEFAULT_PARALLEL_FETCH_CONFIG)
  config.concurrencies = [...concurrencies]
  const trials: ParallelFetchTrial[] = config.concurrencies.map(concurrency => ({
    concurrency, repetition: 1, state: 'complete', startedAt, finishedAt, preparationMs: 10000,
    measurementMs: concurrency === 1 ? 200000 : 100000, totalMs: concurrency === 1 ? 210000 : 110000,
    completedPages: Array.from({ length: 20 }, (_, index) => index + 1),
    attempts: [
      ...Array.from({ length: concurrency }, (_, index) => ({ worker: index + 1, page: 1, phase: 'prepare' as const,
        startedAt, durationMs: 1000, httpStatus: 200, errorCode: null, totalCount: 2000, totalPages: 100 })),
      ...Array.from({ length: 20 }, (_, index) => ({ worker: index % concurrency + 1, page: index + 1, phase: 'measure' as const,
        startedAt, durationMs: 1000, httpStatus: 200, errorCode: null, totalCount: 2000, totalPages: 100 })),
    ], workers: Array.from({ length: concurrency }, (_, index) => ({ id: index + 1, page: null, state: 'complete' as const,
      completedPages: Math.ceil((20 - index) / concurrency) })), errorCode: null,
  }))
  return { schemaVersion: 1, runId: 'test-run', config, state: 'complete', startedAt, finishedAt, trials, errorCode: null }
}
function traceFixture(): ParallelFetchReadDiagnostics {
  return { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: true, trace: {
    observations: [
      { elapsedMs: 0, phase: 'read', authenticationEvidence: null, loginRequiredHeading: null, rankingReadable: null, humanVerification: false },
      { elapsedMs: 12000, phase: 'after-stop', authenticationEvidence: 'logout-control', loginRequiredHeading: false,
        rankingReadable: true, humanVerification: false },
    ],
    network: [
      { elapsedMs: 100, phase: 'read', kind: 'http-error', resource: 'xhr', site: 'buckler', status: 429 },
      { elapsedMs: 12001, phase: 'after-stop', kind: 'request-failed', resource: 'document', site: 'capcom-auth', status: null },
    ],
    droppedObservations: 2, droppedNetworkEvents: 3, postStop: { durationMs: 30000, outcome: 'observed' },
  } }
}
test('bounded defaults include each worker preparation in the planned count', () => {
  assert.equal(plannedParallelFetchAttempts(parseParallelFetchConfig(DEFAULT_PARALLEL_FETCH_CONFIG)), 43)
  assert.equal(plannedParallelFetchAttempts(parseParallelFetchConfig({ ...DEFAULT_PARALLEL_FETCH_CONFIG, repetitions: 3 })), 129)
  assert.throws(() => parseParallelFetchConfig({ ...DEFAULT_PARALLEL_FETCH_CONFIG, repetitions: 3, concurrencies: [1, 2, 4] }))
  for (const patch of [{ intervalMs: 0 }, { startPage: -1 }, { pageCount: 1000 }, { concurrencies: [] }, { concurrencies: [2] },
    { concurrencies: [1, 1] }, { concurrencies: [2, 1] }, { concurrencies: [1, 4, 2] }, { target: 'https://other.test' }]) {
    assert.throws(() => parseParallelFetchConfig({ ...DEFAULT_PARALLEL_FETCH_CONFIG, ...patch }))
  }
})

test('comma-separated concurrency input normalizes whitespace and order within the worker limit', () => {
  assert.equal(PARALLEL_FETCH_MAX_CONCURRENCY, 8)
  assert.deepEqual(parseParallelFetchConcurrencyInput(' 8, 3 , 1 '), [1, 3, 8])
  assert.deepEqual(parseParallelFetchConcurrencyInput('1'), [1])
  assert.deepEqual(parseParallelFetchConcurrencyInput('8,7,6,5,4,3,2,1'), [1, 2, 3, 4, 5, 6, 7, 8])
})

test('concurrency input rejects missing values, duplicates, missing baseline and nondecimal integers', () => {
  for (const input of ['', ' ', ',1', '1,', '1,,3', '1, ,3', '1,1', '1,3, 3', '3,8',
    '0,1', '1,9', '1,-2', '1,+2', '1,2.0', '1,2.5', '1,2e0', '1,0x2', '1,02', '1,NaN',
    '1,Infinity', '1 3', '1;3', '1,三', '1,9007199254740992', '1,2,3,4,5,6,7,8,1']) {
    assert.throws(() => parseParallelFetchConcurrencyInput(input), Error, input)
  }
  assert.throws(() => parseParallelFetchConcurrencyInput('2'), /並列数1/)
  assert.throws(() => parseParallelFetchConcurrencyInput('1,1'), /重複/)
  assert.throws(() => parseParallelFetchConcurrencyInput('1,9'), /1〜8/)
})

test('concurrency input rejects text beyond the 128-character UI limit before parsing', () => {
  assert.deepEqual(parseParallelFetchConcurrencyInput('1,8'.padEnd(128)), [1, 8])
  assert.throws(() => parseParallelFetchConcurrencyInput('1,8'.padEnd(129)), /128文字/)
  assert.throws(() => parseParallelFetchConcurrencyInput('1,'.repeat(10000)), /128文字/)
})

test('numeric configs accept all eight workers while preserving canonical order and global limits', () => {
  const all = { ...DEFAULT_PARALLEL_FETCH_CONFIG, concurrencies: [1, 2, 3, 4, 5, 6, 7, 8],
    intervalMs: 3000, intervalMsList: [3000] }
  const parsed = parseParallelFetchConfig(all)
  assert.deepEqual(parsed, all)
  assert.equal(plannedParallelFetchAttempts(parsed), 196)
  assert.equal(minimumPlannedWaitMs(parsed), 585000)
  assert.equal(plannedParallelFetchAttempts(parseParallelFetchConfig({ ...all, concurrencies: [1, 2, 3], repetitions: 3 })), 198)
  for (const concurrencies of [[1, 0], [1, 9], [1, 3.5], [1, Infinity], [1, NaN], [1, '3'],
    [1, 8, 3], [1, 3, 3], [1, 2, 3, 4, 5, 6, 7, 8, 8]]) {
    assert.throws(() => parseParallelFetchConfig({ ...all, concurrencies }))
  }
  const sparse = [1, 2, 3]
  delete sparse[1]
  assert.throws(() => parseParallelFetchConfig({ ...all, concurrencies: sparse }))
  assert.throws(() => parseParallelFetchConfig({ ...all, pageCount: 50 }))
  assert.throws(() => parseParallelFetchConfig({ ...all, repetitions: 3 }))
  assert.throws(() => parseParallelFetchConfig({ ...all, intervalMs: 5000, intervalMsList: [5000] }))
})

test('both report versions accept eight conditions and keep trials, workers and attempts bounded', () => {
  for (const schemaVersion of [1, 2] as const) {
    const report = fixture([1, 2, 3, 4, 5, 6, 7, 8])
    if (schemaVersion === 2) {
      report.schemaVersion = 2
      report.config.intervalMs = 3000
      report.config.intervalMsList = [3000]
      report.trials.forEach(trial => { trial.intervalMs = 3000 })
    }
    assert.deepEqual(parseParallelFetchReport(JSON.parse(JSON.stringify(report))), report)
    assert.equal(report.trials.at(-1)!.workers.length, 8)
    assert.deepEqual(summarizeParallelFetch(report).map(summary => summary.concurrency), report.config.concurrencies)
    const tooManyTrials = structuredClone(report)
    tooManyTrials.trials.push(structuredClone(report.trials.at(-1)!))
    assert.throws(() => parseParallelFetchReport(tooManyTrials))
    const tooManyWorkers = structuredClone(report)
    tooManyWorkers.trials.at(-1)!.workers.push({ id: 9, page: null, state: 'complete', completedPages: 0 })
    assert.throws(() => parseParallelFetchReport(tooManyWorkers))
    const retry = { ...report.trials[0].attempts[0], errorCode: 'server-error' as const, httpStatus: 503, totalCount: null, totalPages: null }
    report.trials[0].attempts.push(...Array.from({ length: 4 }, () => ({ ...retry })))
    assert.deepEqual(parseParallelFetchReport(report), report)
    report.trials[0].attempts.push({ ...retry })
    assert.throws(() => parseParallelFetchReport(report))
  }
})

test('a serial-only configuration includes preparation in all three repetitions', () => {
  const input = { ...DEFAULT_PARALLEL_FETCH_CONFIG, concurrencies: [1], repetitions: 3 }
  const serial = parseParallelFetchConfig(input)
  assert.deepEqual(serial, input)
  assert.equal(plannedParallelFetchAttempts(serial), 63)
  assert.equal(plannedParallelFetchAttempts(parseParallelFetchConfig({ ...input, pageCount: 50 })), 153)
})
test('report parser reconstructs allowlisted aggregates only', () => {
  const report = fixture()
  const input = { ...report, cookies: ['secret'], config: { ...report.config, token: 'secret' },
    trials: report.trials.map(trial => ({ ...trial, rawRows: ['secret'], attempts: trial.attempts.map(attempt => ({ ...attempt, url: 'secret' })) })) }
  assert.deepEqual(parseParallelFetchReport(input), report)
  assert.equal(JSON.stringify(parseParallelFetchReport(input)).includes('secret'), false)
})

test('diagnostics remain optional for legacy reports and preserve only fixed observations', () => {
  const legacy = fixture()
  assert.deepEqual(parseParallelFetchReport(legacy), legacy)
  assert.equal('diagnostics' in parseParallelFetchReport(legacy).trials[0].attempts[0], false)
  const diagnostics = { authenticationEvidence: 'login-control' as const, loginRequiredHeading: false, rankingReadable: true }
  const report = fixture()
  report.trials[0].attempts[0].diagnostics = { ...diagnostics, cookie: 'secret', rawRows: ['secret'] } as typeof diagnostics
  const parsed = parseParallelFetchReport(report)
  assert.deepEqual(parsed.trials[0].attempts[0].diagnostics, diagnostics)
  assert.equal(JSON.stringify(parsed).includes('secret'), false)
  assert.deepEqual(parseParallelFetchReadDiagnostics({ authenticationEvidence: null, loginRequiredHeading: null, rankingReadable: null }),
    { authenticationEvidence: null, loginRequiredHeading: null, rankingReadable: null })
})

test('diagnostics reject arbitrary evidence and nonboolean states instead of coercing them', () => {
  const diagnostics = { authenticationEvidence: 'no-control', loginRequiredHeading: false, rankingReadable: null }
  for (const bad of [null, [], {},
    { ...diagnostics, authenticationEvidence: 'private-account-name' },
    { ...diagnostics, loginRequiredHeading: 'false' },
    { ...diagnostics, rankingReadable: 1 }]) {
    assert.throws(() => parseParallelFetchReadDiagnostics(bad))
    const report = fixture()
    report.trials[0].attempts[0].diagnostics = bad as never
    assert.throws(() => parseParallelFetchReport(report))
  }
})
test('legacy and detailed diagnostics round-trip within schema version 1', () => {
  for (const diagnostics of [undefined,
    { authenticationEvidence: null, loginRequiredHeading: null, rankingReadable: null }, traceFixture()]) {
    const report = fixture()
    if (diagnostics) report.trials[0].attempts[0].diagnostics = diagnostics
    const parsed = parseParallelFetchReport(JSON.parse(JSON.stringify(report)))
    assert.deepEqual(parsed, report)
    assert.deepEqual(parseParallelFetchReport(JSON.parse(JSON.stringify(parsed))), report)
    assert.equal(parsed.schemaVersion, 1)
  }
  const diagnostics = traceFixture()
  delete diagnostics.trace!.postStop
  assert.deepEqual(parseParallelFetchReadDiagnostics(diagnostics), diagnostics)
  assert.equal('postStop' in parseParallelFetchReadDiagnostics(diagnostics).trace!, false)
})
test('detailed diagnostics strip secrets and arbitrary strings at every nesting level', () => {
  const diagnostics = traceFixture(), trace = diagnostics.trace!
  const secrets = { url: 'secret-url', text: 'secret-text', headers: { Authorization: 'secret-token' }, cookies: ['secret-cookie'],
    body: 'secret-body', error: 'secret-error', request: { url: 'secret-request-url' } }
  const contaminated = { ...diagnostics, ...secrets, trace: { ...trace, ...secrets,
    observations: trace.observations.map(item => ({ ...item, ...secrets })),
    network: trace.network.map(item => ({ ...item, ...secrets })), postStop: { ...trace.postStop, ...secrets },
  } }
  const report = fixture()
  report.trials[0].attempts[0].diagnostics = contaminated
  const parsed = parseParallelFetchReport(JSON.parse(JSON.stringify(report)))
  assert.deepEqual(parsed.trials[0].attempts[0].diagnostics, diagnostics)
  assert.equal(JSON.stringify(parsed).includes('secret'), false)
})
test('detailed diagnostics bound list lengths, durations, and dropped counts', () => {
  const diagnostics = traceFixture(), trace = diagnostics.trace!
  trace.observations = Array.from({ length: PARALLEL_FETCH_MAX_TRACE_OBSERVATIONS }, () => ({ ...trace.observations[0], elapsedMs: 7 * 86400000 }))
  trace.network = Array.from({ length: PARALLEL_FETCH_MAX_TRACE_NETWORK_EVENTS }, () => ({ ...trace.network[0], elapsedMs: 7 * 86400000, status: 599 }))
  trace.postStop = { durationMs: PARALLEL_FETCH_MAX_POST_STOP_MS, outcome: 'observed' }
  trace.droppedObservations = Number.MAX_SAFE_INTEGER
  trace.droppedNetworkEvents = 0
  assert.deepEqual(parseParallelFetchReadDiagnostics(diagnostics), diagnostics)
  for (const patch of [
    { observations: [...trace.observations, trace.observations[0]] },
    { network: [...trace.network, trace.network[0]] },
    { observations: {} }, { network: null },
    { droppedObservations: -1 }, { droppedObservations: 0.5 }, { droppedObservations: Number.MAX_SAFE_INTEGER + 1 },
    { droppedNetworkEvents: NaN }, { droppedNetworkEvents: '0' }, { droppedNetworkEvents: Infinity },
    { postStop: { durationMs: PARALLEL_FETCH_MAX_POST_STOP_MS + 1, outcome: 'observed' } },
  ]) assert.throws(() => parseParallelFetchReadDiagnostics({ ...diagnostics, trace: { ...trace, ...patch } }))
  for (const elapsedMs of [-1, 7 * 86400000 + 1, Infinity, NaN, '1']) {
    for (const key of ['observations', 'network'] as const) {
      assert.throws(() => parseParallelFetchReadDiagnostics({ ...diagnostics,
        trace: { ...trace, [key]: [{ ...trace[key][0], elapsedMs }] } }))
    }
  }
})
test('detailed diagnostics reject unknown enums, incomplete states, and invalid HTTP status-kind pairs', () => {
  const diagnostics = traceFixture(), trace = diagnostics.trace!
  const invalidTraces = [null, [], {},
    ...[null, {}, { ...trace.observations[0], phase: 'private-url' },
      { ...trace.observations[0], authenticationEvidence: 'private-user' }, { ...trace.observations[0], loginRequiredHeading: 0 },
      { ...trace.observations[0], rankingReadable: 'true' }, { ...trace.observations[0], humanVerification: 'false' }]
      .map(item => ({ ...trace, observations: [item] })),
    ...[null, {}, { ...trace.network[0], phase: 'navigate' }, { ...trace.network[0], kind: 'response' },
      { ...trace.network[0], resource: 'private-request-name' }, { ...trace.network[0], site: 'private-hostname' },
      ...[null, 399, 600, 429.5, '429'].map(status => ({ ...trace.network[0], status })),
      { ...trace.network[1], status: 503 }].map(item => ({ ...trace, network: [item] })),
    ...[null, {}, { durationMs: 0, outcome: 'private-error-message' },
      ...[-1, Infinity, NaN, '0'].map(durationMs => ({ durationMs, outcome: 'observed' }))]
      .map(postStop => ({ ...trace, postStop })),
  ]
  for (const invalidTrace of invalidTraces) {
    const report = fixture()
    report.trials[0].attempts[0].diagnostics = { ...diagnostics, trace: invalidTrace } as never
    assert.throws(() => parseParallelFetchReport(report))
  }
})
test('rejects fabricated complete counts, mismatched ranges, duplicated trials and nonnumeric values', () => {
  const changes: ((report: ParallelFetchReport) => void)[] = [
    report => { report.trials[0].completedPages.pop() },
    report => { report.trials[0].completedPages[0] = 21 },
    report => { report.trials[0].attempts[1].worker = 4 },
    report => { report.trials[0].attempts[2].page = 1 },
    report => { report.trials[0].workers = [] },
    report => { report.trials[0].workers[0].completedPages = 0 },
    report => { report.trials[0].attempts.shift() },
    report => { report.trials[0].attempts[1].httpStatus = 429 },
    report => { report.trials[0].measurementMs = Infinity },
    report => { report.trials[0].attempts[1].errorCode = 'secret' as never },
    report => { report.trials[1] = structuredClone(report.trials[0]) },
    report => { report.finishedAt = null },
  ]
  for (const change of changes) { const report = fixture(); change(report); assert.throws(() => parseParallelFetchReport(report)) }
})
test('same completed page set yields measured throughput, speedup and reference scan estimate', () => {
  const summaries = summarizeParallelFetch(parseParallelFetchReport(fixture()))
  assert.equal(summaries[0].pagesPerMinute, 6)
  assert.equal(summaries[1].speedup, 2)
  assert.ok(Math.abs(summaries[1].estimatedFullScanMs! - 500000) < 0.001)
  assert.equal(summaries[0].retries, 0)
})
test('partial trials remain visible but do not produce speedup or extrapolation', () => {
  const report = fixture(), trial = report.trials[1]
  report.state = trial.state = 'stopped'
  report.errorCode = trial.errorCode = 'cancelled'
  trial.completedPages = [1]
  trial.attempts = trial.attempts.slice(0, 3)
  trial.workers.forEach(worker => { worker.completedPages = worker.id === 1 ? 1 : 0; worker.state = 'stopped' })
  const summary = summarizeParallelFetch(parseParallelFetchReport(report))[1]
  assert.equal(summary.successfulPages, 1)
  assert.equal(summary.completedTrials, 0)
  assert.equal(summary.speedup, null)
  assert.equal(summary.estimatedFullScanMs, null)
})
test('retry failures remain in counts without double counting successful pages', () => {
  const report = fixture(), trial = report.trials[0]
  trial.attempts.splice(1, 0, { ...trial.attempts[1], errorCode: 'server-error', httpStatus: 503, totalCount: null, totalPages: null })
  const summary = summarizeParallelFetch(parseParallelFetchReport(report))[0]
  assert.equal(summary.retries, 1)
  assert.equal(summary.failedAttempts, 1)
  assert.equal(summary.failedAttemptRate, 1 / 22)
  assert.equal(summary.successfulPages, 20)
})

function intervalFixture(): ParallelFetchReport {
  const legacy = fixture()
  return { ...legacy, schemaVersion: 2, config: { ...legacy.config, intervalMsList: [5000, 3000] },
    trials: [5000, 3000].flatMap(intervalMs => legacy.trials.map(trial => ({ ...structuredClone(trial),
      intervalMs: intervalMs as 5000 | 3000, measurementMs: trial.measurementMs! * (intervalMs === 3000 ? 0.5 : 1) }))) }
}
test('interval selections preserve legacy shape and include preparation and boundary waits across conditions', () => {
  const legacy = parseParallelFetchConfig(DEFAULT_PARALLEL_FETCH_CONFIG)
  assert.equal('intervalMsList' in legacy, false)
  assert.deepEqual(parallelFetchIntervals(legacy), [5000])
  const config = parseParallelFetchConfig({ ...legacy, intervalMsList: [5000, 3000] })
  assert.equal(plannedParallelFetchAttempts(config), 86)
  assert.equal(minimumPlannedWaitMs(config), 42 * 5000 + 43 * 3000)
  const copied = parallelFetchIntervals(config)
  copied.pop()
  assert.deepEqual(config.intervalMsList, [5000, 3000])
  assert.equal(parseParallelFetchConfig({ ...legacy, intervalMs: 3000, intervalMsList: [3000] }).intervalMs, 3000)
  for (const patch of [{ intervalMsList: [] }, { intervalMsList: [3000, 5000] }, { intervalMsList: [5000, 5000] },
    { intervalMsList: [10000, 5000] }, { intervalMsList: [5000, 2000] }, { intervalMsList: null },
    { intervalMsList: [5000, 3000], repetitions: 3 }, { intervalMs: 3000 }]) {
    assert.throws(() => parseParallelFetchConfig({ ...legacy, ...patch }))
  }
  const legacyLong = { ...legacy, intervalMs: 10000, concurrencies: [1], repetitions: 3 }
  assert.equal(parseParallelFetchConfig(legacyLong).intervalMs, 10000, 'historical over-time configs remain importable')
  assert.throws(() => parseParallelFetchConfig({ ...legacyLong, intervalMsList: [10000] }), 'new guaranteed over-time configs fail before execution')
})
test('version 2 round-trips strict interval membership and ordered trial prefixes without changing version 1 reports', () => {
  const report = intervalFixture()
  assert.deepEqual(parseParallelFetchReport(report), report)
  assert.deepEqual(parseParallelFetchReport(fixture()), fixture())
  const mutations: ((value: ParallelFetchReport) => void)[] = [
    value => { value.schemaVersion = 1 }, value => { delete value.config.intervalMsList },
    value => { delete value.trials[0].intervalMs }, value => { value.trials[0].intervalMs = 10000 },
    value => { value.trials[1] = structuredClone(value.trials[0]) },
    value => { [value.trials[0], value.trials[1]] = [value.trials[1], value.trials[0]] },
    value => { value.trials.pop() },
  ]
  for (const mutate of mutations) { const value = structuredClone(report); mutate(value); assert.throws(() => parseParallelFetchReport(value)) }
  const partial = { ...report, state: 'stopped' as const, errorCode: 'cancelled' as const, trials: report.trials.slice(0, 1) }
  assert.deepEqual(parseParallelFetchReport(partial), partial)
})
test('summaries expose unstarted interval conditions and use a serial baseline from the same interval only', () => {
  const report = intervalFixture()
  assert.deepEqual(summarizeParallelFetch(report).map(item => [item.intervalMs, item.concurrency, item.speedup]),
    [[5000, 1, 1], [5000, 2, 2], [3000, 1, 1], [3000, 2, 2]])
  report.trials = report.trials.slice(0, 2)
  const summaries = summarizeParallelFetch(report)
  assert.deepEqual(summaries.slice(2).map(item => [item.intervalMs, item.completedTrials, item.medianMs, item.speedup, item.failedAttemptRate]),
    [[3000, 0, null, null, null], [3000, 0, null, null, null]])
  report.config.repetitions = 3
  assert.ok(summarizeParallelFetch(report).every(item => item.speedup === null))
})
