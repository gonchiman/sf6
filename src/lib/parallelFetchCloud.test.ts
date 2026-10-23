import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudConfig, cloudRunUrl, DEFAULT_CLOUD_INTERVAL_OPTIONS, parseCloudIntervalOptions, parseCloudRun, parseCloudServiceStatus, parseParallelFetchResult } from './parallelFetchCloud.ts'
import { plannedParallelFetchAttempts } from './parallelFetch.ts'
import type { CloudRun } from '../types/parallelFetchCloud.ts'

function run(): CloudRun {
  return { requestId: 'bb7d4cd9-0ba6-4630-941a-4b1ac5f17dcb', mode: 'serial',
    createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:05:00.000Z', dispatchState: 'sent',
    runId: '123', runAttempt: 1, state: 'failed', startedAt: '2026-10-21T00:01:00.000Z', finishedAt: '2026-10-21T00:05:00.000Z',
    headSha: 'a'.repeat(40), conclusion: 'failure', error: null,
    report: { schemaVersion: 1, runId: 'cloud-123-1-serial', config: cloudConfig('serial'),
      startedAt: '2026-10-21T00:02:00.000Z', finishedAt: '2026-10-21T00:04:00.000Z',
      state: 'error', errorCode: 'human-verification', trials: [] } }
}
test('cloud presets preserve bounded counts and produce independent configurations', () => {
  assert.equal(plannedParallelFetchAttempts(cloudConfig('serial')), 63)
  assert.equal(plannedParallelFetchAttempts(cloudConfig('compare')), 43)
  const config = cloudConfig('serial'); config.concurrencies.push(4)
  assert.deepEqual(cloudConfig('serial').concurrencies, [1])
})
test('cloud report is bound to the exact run, attempt, mode and fixed conditions', () => {
  const value = run()
  assert.deepEqual(parseCloudRun(value), value)
  for (const change of [{ runId: '456' }, { runAttempt: 2 }, { mode: 'compare' }, { runId: null },
    { headSha: '../unsafe' }, { state: 'complete' }, { requestId: '../file' }, { runAttempt: 1.5 }]) {
    assert.throws(() => parseCloudRun({ ...value, ...change }))
  }
  assert.throws(() => parseCloudRun({ ...value, report: { ...value.report, config: { ...value.report!.config, intervalMs: 10000 } } }))
  const safe = parseCloudRun({ ...value, private: 'secret', report: { ...value.report, rawRows: ['player'] } })
  assert.equal(JSON.stringify(safe).includes('secret'), false)
  assert.equal(JSON.stringify(safe).includes('player'), false)
})
test('status cannot point to another run, duplicate a request, or provide arbitrary metadata', () => {
  const value = { available: true, token: 'a'.repeat(64), readiness: 'ready', activeRequestId: null, runs: [run()], error: null }
  assert.equal(parseCloudServiceStatus(value).runs.length, 1)
  assert.throws(() => parseCloudServiceStatus({ ...value, activeRequestId: run().requestId }))
  assert.throws(() => parseCloudServiceStatus({ ...value, runs: [run(), run()] }))
  assert.throws(() => parseCloudServiceStatus({ ...value, readiness: 'auth token' }))
})
test('import/export retains environment; legacy reports stay unknown; mismatched cloud report is rejected', () => {
  const cloud = run(), report = cloud.report!
  const envelope = { schemaVersion: 1, kind: 'parallel-fetch-result', environment: 'github-actions', cloud, report }
  assert.deepEqual(parseParallelFetchResult(JSON.parse(JSON.stringify(envelope))), envelope)
  assert.equal(parseParallelFetchResult(report).environment, 'unknown')
  assert.throws(() => parseParallelFetchResult({ ...envelope, environment: 'local' }))
  assert.throws(() => parseParallelFetchResult({ ...envelope, cloud: null }))
  assert.throws(() => parseParallelFetchResult({ ...envelope, report: { ...report, errorCode: 'timeout' } }))
  assert.equal(parseParallelFetchResult({ ...envelope, environment: 'local', cloud: null }).environment, 'local')
})
test('run links can only target a numeric run in the fixed repository', () => {
  assert.equal(cloudRunUrl('123'), 'https://github.com/gonchiman/sf6/actions/runs/123')
  for (const value of ['../evil', 'https://evil.test', '0', '1?token=x']) assert.throws(() => cloudRunUrl(value))
})

test('interval selections are canonical, independent and bounded across all conditions', () => {
  const options = parseCloudIntervalOptions({ intervalMsList: [3000, 5000], concurrencies: [2, 1], repetitions: 1 })
  assert.deepEqual(options, DEFAULT_CLOUD_INTERVAL_OPTIONS)
  assert.equal(plannedParallelFetchAttempts(cloudConfig('interval-compare', options)), 86)
  options.intervalMsList.push(10000)
  assert.deepEqual(DEFAULT_CLOUD_INTERVAL_OPTIONS.intervalMsList, [5000, 3000])
  for (const change of [{ intervalMsList: [] }, { intervalMsList: [5000, 5000] }, { intervalMsList: [0] },
    { intervalMsList: ['3000'] }, { concurrencies: [] }, { concurrencies: [4] }, { concurrencies: [2] },
    { concurrencies: [1, 1] }, { concurrencies: [1, 0] }, { concurrencies: [1, 9] }, { concurrencies: [1, 2.5] },
    { concurrencies: [1, '3'] }, { concurrencies: [1, null] }, { repetitions: '1' },
    { repetitions: 3 }, { intervalMsList: [10000], concurrencies: [1], repetitions: 3 }, { url: 'https://other.example' }]) {
    assert.throws(() => parseCloudIntervalOptions({ ...DEFAULT_CLOUD_INTERVAL_OPTIONS, ...change }))
  }
  assert.throws(() => cloudConfig('serial', DEFAULT_CLOUD_INTERVAL_OPTIONS))
})

test('cloud options accept every integer through eight and keep the request and duration caps', () => {
  const options = parseCloudIntervalOptions({ intervalMsList: [3000], concurrencies: [8, 7, 6, 5, 4, 3, 2, 1], repetitions: 1 })
  assert.deepEqual(options.concurrencies, [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(plannedParallelFetchAttempts(cloudConfig('interval-compare', options)), 196)
  const sparse = parseCloudIntervalOptions({ intervalMsList: [5000, 3000], concurrencies: [8, 1, 3], repetitions: 1 })
  assert.deepEqual(sparse.concurrencies, [1, 3, 8])
  assert.equal(plannedParallelFetchAttempts(cloudConfig('interval-compare', sparse)), 144)
  assert.throws(() => parseCloudIntervalOptions({ ...options, intervalMsList: [5000] }))
  assert.throws(() => parseCloudIntervalOptions({ ...options, repetitions: 3 }))
  assert.throws(() => parseCloudIntervalOptions({ ...options, intervalMsList: [5000, 3000] }))
})

test('interval reports are bound to persisted selections and legacy records remain unchanged', () => {
  const options = parseCloudIntervalOptions({ ...DEFAULT_CLOUD_INTERVAL_OPTIONS, concurrencies: [1, 3, 8] })
  const value = { ...run(), mode: 'interval-compare', options, report: { ...run().report,
    schemaVersion: 2, runId: 'cloud-123-1-interval-compare', config: cloudConfig('interval-compare', options) } }
  assert.deepEqual(parseCloudRun(value), value)
  assert.throws(() => parseCloudRun({ ...value, options: undefined }))
  assert.throws(() => parseCloudRun({ ...value, options: { ...options, intervalMsList: [5000] } }))
  assert.throws(() => parseCloudRun({ ...value, options: { ...options, concurrencies: [1, 3, 7] } }))
  assert.throws(() => parseCloudRun({ ...value, report: { ...value.report,
    config: { ...value.report.config, concurrencies: [1, 3, 7] } } }))
  assert.throws(() => parseCloudRun({ ...run(), options }))
  assert.deepEqual(parseCloudRun(run()), run())
})
