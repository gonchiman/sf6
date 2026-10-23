import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PARALLEL_FETCH_CONFIG, parseParallelFetchConfig, parseParallelFetchReadDiagnostics, parseParallelFetchReport,
  PARALLEL_FETCH_MAX_POST_STOP_MS, PARALLEL_FETCH_MAX_TRACE_NETWORK_EVENTS, PARALLEL_FETCH_MAX_TRACE_OBSERVATIONS,
  plannedParallelFetchAttempts, summarizeParallelFetch } from './parallelFetch.ts'
import type { ParallelFetchReadDiagnostics, ParallelFetchReport, ParallelFetchTrial } from '../types/parallelFetch.ts'

const startedAt = '2026-10-20T00:00:00.000Z', finishedAt = '2026-10-20T00:10:00.000Z'
function fixture(): ParallelFetchReport {
  const config = structuredClone(DEFAULT_PARALLEL_FETCH_CONFIG)
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
      completedPages: 20 / concurrency })), errorCode: null,
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
