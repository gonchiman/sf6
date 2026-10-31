import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_FETCH_INTERVAL_INPUT, fetchIntervalDraft, fetchIntervalRows, isFetchIntervalConfig, isFetchIntervalRun } from './fetchIntervalTest.ts'
import { cloudConfig } from './parallelFetchCloud.ts'
import { minimumPlannedWaitMs, plannedParallelFetchAttempts } from './parallelFetch.ts'
import type { ParallelFetchAttempt, ParallelFetchConfig, ParallelFetchReport, ParallelFetchTrial } from '../types/parallelFetch.ts'
import type { CloudRun } from '../types/parallelFetchCloud.ts'

const config = fetchIntervalDraft(DEFAULT_FETCH_INTERVAL_INPUT).config!
const startedAt = '2026-10-31T00:00:00.000Z'
function attempt(page: number, overrides: Partial<ParallelFetchAttempt> = {}): ParallelFetchAttempt {
  return { worker: 1, page, phase: 'measure', startedAt, durationMs: 4000, httpStatus: 200,
    errorCode: null, totalCount: 1000, totalPages: 50, ...overrides }
}
function trial(intervalMs = 10000, overrides: Partial<ParallelFetchTrial> = {}): ParallelFetchTrial {
  return { intervalMs, concurrency: 1, repetition: 1, state: 'complete', startedAt,
    finishedAt: '2026-10-31T00:03:20.000Z', preparationMs: 1000, measurementMs: 194000, totalMs: 195000,
    completedPages: Array.from({ length: 20 }, (_, index) => index + 1),
    attempts: [attempt(1, { phase: 'prepare', durationMs: 1000 }), ...Array.from({ length: 20 }, (_, index) => attempt(index + 1))],
    workers: [{ id: 1, page: null, state: 'complete', completedPages: 20 }], errorCode: null, ...overrides }
}
function report(trials: ParallelFetchTrial[], overrides: Partial<ParallelFetchReport> = {}): ParallelFetchReport {
  return { schemaVersion: 3, runId: 'interval-test', config, state: 'stopped', startedAt,
    finishedAt: '2026-10-31T00:04:00.000Z', trials, errorCode: null, ...overrides }
}
function run(overrides: Partial<CloudRun> = {}): CloudRun {
  return { requestId: '7739a1ba-5c55-4660-926c-061f8c88b097', mode: 'interval-compare',
    options: fetchIntervalDraft(DEFAULT_FETCH_INTERVAL_INPUT).options!, createdAt: startedAt, updatedAt: startedAt,
    dispatchState: 'sent', runId: '123', runAttempt: 1, state: 'queued', startedAt: null,
    finishedAt: null, headSha: null, conclusion: null, report: null, error: null, ...overrides }
}

test('interval-only draft fixes all comparison variables and reuses the shared execution budget', () => {
  assert.deepEqual(config, { target: 'lp', startPage: 1, pageCount: 20, concurrencies: [1], repetitions: 1,
    intervalMs: 10000, intervalMsList: [10000, 5000], intervalScope: 'global' })
  assert.equal(plannedParallelFetchAttempts(config), 42)
  assert.equal(minimumPlannedWaitMs(config), 305000)
  assert.deepEqual(fetchIntervalDraft('5, 10').config, config)
  assert.deepEqual(fetchIntervalDraft('2.5, 0').config?.intervalMsList, [2500, 0])
  for (const input of ['', '5,', '5,5', '-1', '61', '0.05', '1,2,3,4']) {
    const value = fetchIntervalDraft(input)
    assert.equal(value.config, null, input)
    assert.equal(value.options, null, input)
    assert.ok(value.error, input)
  }
  assert.match(fetchIntervalDraft('60, 10').error!, /10分/)
})

test('compatible history keeps historical budgets and global legacy scope, but excludes different acquisition conditions', () => {
  assert.ok(isFetchIntervalConfig(config))
  const legacy = { ...config }; delete legacy.intervalScope
  assert.ok(isFetchIntervalConfig(legacy))
  assert.ok(isFetchIntervalConfig({ ...config, intervalMs: 60000, intervalMsList: [60000] }))
  const variations: Partial<ParallelFetchConfig>[] = [
    { target: 'mr' }, { startPage: 2 }, { pageCount: 50 }, { concurrencies: [1, 2] },
    { concurrencies: [2] }, { repetitions: 3 }, { intervalScope: 'per-tab' }, { intervalMsList: [] },
  ]
  for (const variation of variations) assert.equal(isFetchIntervalConfig({ ...config, ...variation }), false)
  assert.ok(isFetchIntervalRun(run()))
  assert.ok(isFetchIntervalRun(run({ report: report([trial()]) })))
  assert.equal(isFetchIntervalRun(run({ mode: 'serial', options: undefined })), false)
  assert.equal(isFetchIntervalRun(run({ report: report([], { config: { ...config, target: 'mr' } }) })), false)
  assert.equal(isFetchIntervalRun(run({ report: report([], { config: cloudConfig('interval-compare', { ...run().options!, intervalMsList: [5000] }) }) })), false)
})

test('cloud wait and missing artifacts never imply zero successful pages', () => {
  for (const state of ['queued', 'awaiting-result', 'unavailable', 'not-run'] as const) {
    const rows = fetchIntervalRows(config, null, state)
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.state === state && row.completedPages === null && row.measurementMs === null && row.medianReadMs === null))
  }
  const waiting = fetchIntervalRows(config, report([trial()], { state: 'running', finishedAt: null }))
  assert.equal(waiting[0].state, 'complete')
  assert.equal(waiting[1].state, 'queued')
  const stopped = fetchIntervalRows(config, report([trial()], { errorCode: 'limit-reached' }))
  assert.equal(stopped[1].state, 'not-run')
  assert.equal(stopped[1].completedPages, null)
  assert.equal(stopped[1].errorCode, null)
})

test('completed trials preserve timing independently of a later stop; partial time is not a completion time', () => {
  const stopped = trial(5000, { state: 'stopped', completedPages: [1, 2], measurementMs: 15000,
    attempts: [attempt(1, { phase: 'prepare', durationMs: 9000 }), attempt(1, { durationMs: 3000 }), attempt(2, { durationMs: 5000 }),
      attempt(3, { errorCode: 'authentication-unconfirmed', durationMs: 60000 })], errorCode: 'authentication-unconfirmed' })
  const rows = fetchIntervalRows(config, report([trial(), stopped], { errorCode: 'authentication-unconfirmed' }))
  assert.equal(rows[0].state, 'complete')
  assert.equal(rows[0].measurementMs, 194000)
  assert.equal(rows[0].medianReadMs, 4000)
  assert.equal(rows[1].state, 'stopped')
  assert.equal(rows[1].measurementMs, null)
  assert.equal(rows[1].completedPages, 2)
  assert.equal(rows[1].medianReadMs, 4000)
  assert.equal(rows[1].locationLabel, '測定 · 3ページ目で停止')
})

test('preparation failures remain separate from measured page 1 and successful-page median', () => {
  const failed = trial(10000, { state: 'error', completedPages: [], measurementMs: null,
    attempts: [attempt(1, { phase: 'prepare', errorCode: 'http-denied', httpStatus: 403 })], errorCode: 'http-denied' })
  const row = fetchIntervalRows(config, report([failed]))[0]
  assert.equal(row.state, 'error')
  assert.equal(row.completedPages, 0)
  assert.equal(row.medianReadMs, null)
  assert.equal(row.locationLabel, '準備 · 1ページ目で停止')
  assert.deepEqual(row.diagnosticLabels, ['HTTP 403'])
  assert.equal(fetchIntervalRows(config, report([trial(10000, { state: 'preparing', completedPages: [], attempts: [] })]))[0].locationLabel, '準備中')
})

test('HTTP 200 and readable ranking remain observations, not proof of authentication or CAPTCHA', () => {
  const failed = trial(10000, { state: 'stopped', completedPages: [], attempts: [attempt(1, {
    errorCode: 'authentication-unconfirmed', diagnostics: { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: true },
  })], errorCode: 'authentication-unconfirmed' })
  const row = fetchIntervalRows(config, report([failed]))[0]
  assert.deepEqual(row.diagnosticLabels, ['HTTP 200', 'ログイン表示あり', 'ログイン要求見出しなし', 'ランキング読取可'])
  assert.equal(row.errorCode, 'authentication-unconfirmed')
  assert.equal(row.medianReadMs, null)
})

test('incomplete success claims do not produce completion time; a changed draft cannot relabel an older report', () => {
  for (const partial of [
    trial(10000, { completedPages: [1], attempts: [attempt(1)] }),
    trial(10000, { attempts: [attempt(1, { phase: 'prepare' })] }),
    trial(10000, { measurementMs: null }),
    trial(10000, { errorCode: 'read-failed' }),
  ]) {
    const row = fetchIntervalRows(config, report([partial]))[0]
    assert.equal(row.state, 'incomplete')
    assert.equal(row.measurementMs, null)
  }
  assert.deepEqual(fetchIntervalRows(fetchIntervalDraft('8, 5').config!, report([trial()])), [])
  assert.deepEqual(fetchIntervalRows({ ...config, target: 'mr' }, null), [])
})
