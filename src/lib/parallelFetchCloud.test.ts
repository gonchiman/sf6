import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudConfig, cloudRunUrl, parseCloudRun, parseCloudServiceStatus, parseParallelFetchResult } from './parallelFetchCloud.ts'
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
