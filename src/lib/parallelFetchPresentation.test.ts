import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_PARALLEL_FETCH_CONFIG } from './parallelFetch.ts'
import { parallelFetchConditionStatus, parallelFetchConfigError, parallelFetchPlanRows } from './parallelFetchPresentation.ts'
import type { ParallelFetchConfig, ParallelFetchReport, ParallelFetchTrial } from '../types/parallelFetch.ts'

const config: ParallelFetchConfig = { ...DEFAULT_PARALLEL_FETCH_CONFIG, intervalMs: 5000, intervalMsList: [5000, 3000], concurrencies: [1, 2], repetitions: 1 }
const trial = (intervalMs: 5000 | 3000, state: ParallelFetchTrial['state'] = 'complete'): ParallelFetchTrial => ({ intervalMs, concurrency: 1, repetition: 1, state,
  startedAt: '2026-10-23T00:00:00.000Z', finishedAt: '2026-10-23T00:01:00.000Z', preparationMs: 1, measurementMs: 60000, totalMs: 60001,
  completedPages: [1], attempts: [], workers: [], errorCode: state === 'stopped' ? 'authentication-unconfirmed' : null })
const report = (trials: ParallelFetchTrial[]): ParallelFetchReport => ({ schemaVersion: 2, runId: 'test', config, state: 'stopped',
  startedAt: '2026-10-23T00:00:00.000Z', finishedAt: '2026-10-23T00:01:00.000Z', trials, errorCode: 'authentication-unconfirmed' })

test('plan uses long intervals first and repeats each concurrency before advancing', () => {
  assert.deepEqual(parallelFetchPlanRows(config), [
    { intervalMs: 5000, concurrency: 1, repetition: 1 }, { intervalMs: 5000, concurrency: 2, repetition: 1 },
    { intervalMs: 3000, concurrency: 1, repetition: 1 }, { intervalMs: 3000, concurrency: 2, repetition: 1 },
  ])
  assert.deepEqual(parallelFetchPlanRows({ ...config, repetitions: 3 }).slice(0, 4).map(row => [row.concurrency, row.repetition]), [[1, 1], [1, 2], [1, 3], [2, 1]])
})
test('form explains empty selection, whole-run attempt cap and guaranteed timeout', () => {
  assert.equal(parallelFetchConfigError(config), null)
  assert.match(parallelFetchConfigError({ ...config, intervalMsList: [] })!, /1つ以上/)
  assert.match(parallelFetchConfigError({ ...config, repetitions: 3 })!, /200/)
  assert.match(parallelFetchConfigError({ ...config, intervalMs: 10000, intervalMsList: [10000, 5000, 3000] })!, /10分/)
})
test('not-started interval cannot inherit completed state or zero observations from another interval', () => {
  const result = report([trial(5000)])
  assert.equal(parallelFetchConditionStatus(result, 5000, 1).state, 'complete')
  assert.deepEqual(parallelFetchConditionStatus(result, 3000, 1), { state: 'not-run', errorCode: null, started: false, attempted: false })
})
test('stopped and partially repeated conditions remain distinguishable from completed conditions', () => {
  assert.equal(parallelFetchConditionStatus(report([trial(3000, 'stopped')]), 3000, 1).errorCode, 'authentication-unconfirmed')
  assert.equal(parallelFetchConditionStatus({ ...report([trial(5000)]), config: { ...config, repetitions: 3 } }, 5000, 1).state, 'pending')
  const legacy = trial(5000); delete legacy.intervalMs
  assert.equal(parallelFetchConditionStatus({ ...report([legacy]), schemaVersion: 1, config: DEFAULT_PARALLEL_FETCH_CONFIG }, 5000, 1).state, 'complete')
})
