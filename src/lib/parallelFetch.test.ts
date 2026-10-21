import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PARALLEL_FETCH_CONFIG, parseParallelFetchConfig, parseParallelFetchReadDiagnostics, parseParallelFetchReport,
  plannedParallelFetchAttempts, summarizeParallelFetch } from './parallelFetch.ts'
import type { ParallelFetchReport, ParallelFetchTrial } from '../types/parallelFetch.ts'

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
