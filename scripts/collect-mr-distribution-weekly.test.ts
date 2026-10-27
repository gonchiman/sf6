import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parseMrDistributionDataset, parseMrDistributionManifest } from '../src/lib/mrDistribution.ts'
import type { MrDistributionCaptureReport } from './collect-mr-distribution.ts'
import { isAllowedMrWeeklyExecution, MrWeeklyError, parseMrWeeklyRunReport, runMrWeekly, writeMrWeeklyOutput } from './collect-mr-distribution-weekly.ts'
import type { MrWeeklyDependencies, MrWeeklyRunReport } from './collect-mr-distribution-weekly.ts'
import { validateMrDistributionDirectory } from './validate-mr-distribution-data.ts'

const PRIVATE = 'synthetic-mr-weekly-private-session'
const dataset = parseMrDistributionDataset(JSON.parse(await readFile(new URL('../public/data/mr-distribution/max-mr-estimate-2026-10-16T14-06-58-255Z.json', import.meta.url), 'utf8')))
const session = JSON.stringify({ schemaVersion: 1, capturedAt: '2026-10-15T01:00:00.000Z', uploadedAt: '2026-10-15T01:01:00.000Z',
  storageState: { cookies: [{ name: 'session', value: PRIVATE, domain: '.streetfighter.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] } })
function environment(): Record<string, string | undefined> {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'gonchiman/sf6',
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/mr-distribution-weekly.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', BUCKLER_WEEKLY_SESSION: session,
    GH_TOKEN: 'not-for-browser', PATH: 'synthetic-path' }
}
function capture(succeeded = true): MrDistributionCaptureReport {
  return { schemaVersion: 1, status: succeeded ? 'succeeded' : 'failed', startedAt: dataset.captureStartedAt, endedAt: dataset.captureEndedAt,
    stage: succeeded ? 'complete' : 'collection', reason: succeeded ? null : 'collection-failed', readFailureCode: succeeded ? null : 'human-verification',
    requestCount: 106, successfulReadCount: succeeded ? 106 : 105, retryCount: 0, confirmedBoundaryCount: succeeded ? 25 : 9,
    datasetSaved: succeeded, imported: false, browserClosed: true, initialSignInConfirmed: true, readableWithoutSignInReadCount: 0 }
}
function report(succeeded = true): MrWeeklyRunReport {
  return { schemaVersion: 1, id: 'run-123-1', startedAt: new Date(Date.parse(dataset.captureStartedAt) - 1000).toISOString(),
    endedAt: new Date(Date.parse(dataset.generatedAt) + 1000).toISOString(), event: 'manual', status: succeeded ? 'succeeded' : 'failed',
    failureReason: succeeded ? null : 'collection-failed', datasetId: succeeded ? dataset.id : null, capture: capture(succeeded) }
}
function setup(succeeded = true) {
  const env = environment(), calls: string[] = [], written: Array<{ run: MrWeeklyRunReport; dataset?: typeof dataset }> = []
  let tick = 0
  const deps: MrWeeklyDependencies = { env, now: () => new Date(tick++ === 0 ? report().startedAt : report().endedAt),
    collect: async (options, inputs) => {
      calls.push('collect')
      assert.equal(env.BUCKLER_WEEKLY_SESSION, undefined)
      assert.deepEqual(options, { mode: 'collect', maxRequests: 600, import: false })
      assert.equal((await inputs.loadSession()).cookies[0].value, PRIVATE)
      assert.equal(inputs.importDataset, undefined)
      if (succeeded) await inputs.saveDataset(structuredClone(dataset))
      return capture(succeeded)
    },
    writeOutput: async value => { calls.push('output'); written.push(value) },
    artifactReady: async () => { calls.push('artifact') },
  }
  return { env, calls, written, deps }
}

test('MR cloud policy accepts only fixed main hosted Windows executions and consumes the Secret before every guard', async () => {
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_OS: 'Linux' },
    { GITHUB_REPOSITORY: 'someone/else' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/legend-analysis-daily.yml@refs/heads/main' }, { GITHUB_RUN_ID: '../secret' }, { GITHUB_RUN_ATTEMPT: '0' }]) {
    const fixture = setup(); Object.assign(fixture.env, patch)
    assert.equal(isAllowedMrWeeklyExecution(fixture.env), false)
    await assert.rejects(runMrWeekly(['--collect'], fixture.deps), (error: unknown) => error instanceof MrWeeklyError && error.code === 'runner')
    assert.equal(fixture.env.BUCKLER_WEEKLY_SESSION, undefined)
    assert.deepEqual(fixture.calls, [])
  }
  assert.equal(isAllowedMrWeeklyExecution(environment()), true)
  assert.equal(isAllowedMrWeeklyExecution({ ...environment(), GITHUB_EVENT_NAME: 'schedule' }), true)
})

test('MR cloud arguments remain bounded and never permit arbitrary import/output or saved-session paths', async () => {
  for (const args of [[], ['--help'], ['--collect', '--import'], ['--collect', '--max-requests', '601'], ['--collect', '--max-requests', '0'], ['--collect', '--output', PRIVATE]]) {
    const fixture = setup()
    await assert.rejects(runMrWeekly(args, fixture.deps), (error: unknown) => error instanceof MrWeeklyError && error.code === 'arguments' && !error.message.includes(PRIVATE))
    assert.equal(fixture.env.BUCKLER_WEEKLY_SESSION, undefined)
    assert.deepEqual(fixture.calls, [])
  }
  const fixture = setup(false)
  fixture.deps.collect = async options => { assert.equal(options.maxRequests, 200); return capture(false) }
  assert.equal((await runMrWeekly(['--collect', '--max-requests', '200'], fixture.deps)).succeeded, false)
})

test('complete cloud collection stages one validated aggregate and marks artifacts only after output succeeds', async () => {
  const fixture = setup()
  const result = await runMrWeekly(['--collect'], fixture.deps)
  assert.equal(result.succeeded, true)
  assert.equal(result.artifactReady, true)
  assert.deepEqual(result.run, report())
  assert.deepEqual(fixture.calls, ['collect', 'output', 'artifact'])
  assert.equal(fixture.written[0].dataset?.id, dataset.id)
  assert.doesNotMatch(JSON.stringify([result, fixture.written]), /synthetic-mr-weekly-private-session|cookies|storageState|not-for-browser/)
})

test('CAPTCHA or failed capture never stages a partial aggregate and yields a safe failure artifact', async () => {
  const fixture = setup(false)
  const result = await runMrWeekly(['--collect'], fixture.deps)
  assert.equal(result.succeeded, false)
  assert.equal(result.artifactReady, true)
  assert.equal(result.run.capture?.readFailureCode, 'human-verification')
  assert.equal(fixture.written[0].dataset, undefined)
  assert.deepEqual(fixture.calls, ['collect', 'output', 'artifact'])
})

test('unavailable authentication saves a classified failure without launching any browser', async () => {
  for (const raw of [undefined, PRIVATE, '{}']) {
    const fixture = setup(); fixture.env.BUCKLER_WEEKLY_SESSION = raw
    const result = await runMrWeekly(['--collect'], fixture.deps)
    assert.equal(result.run.failureReason, 'authentication-unavailable')
    assert.equal(result.run.capture, null)
    assert.equal(result.run.datasetId, null)
    assert.deepEqual(fixture.calls, ['output', 'artifact'])
    assert.equal(fixture.env.BUCKLER_WEEKLY_SESSION, undefined)
    assert.equal(JSON.stringify(result).includes(PRIVATE), false)
  }
})

test('untrusted capture errors and unknown report fields cannot leak to output or authorize a dataset', async () => {
  for (const malicious of [false, true]) {
    const fixture = setup()
    fixture.deps.collect = async (_options, inputs) => {
      await inputs.saveDataset(dataset)
      if (!malicious) throw new Error(PRIVATE)
      return { ...capture(), cookies: PRIVATE } as MrDistributionCaptureReport
    }
    const result = await runMrWeekly(['--collect'], fixture.deps)
    assert.equal(result.run.status, 'failed')
    assert.equal(result.run.failureReason, 'collection-failed')
    assert.equal(result.run.capture, null)
    assert.equal(fixture.written[0].dataset, undefined)
    assert.doesNotMatch(JSON.stringify([result, fixture.written]), /cookies|synthetic-mr-weekly-private-session/)
  }
})

test('missing aggregate or a browser that did not close cannot be published as success', async () => {
  for (const closed of [true, false]) {
    const fixture = setup()
    fixture.deps.collect = async (_options, inputs) => {
      if (!closed) await inputs.saveDataset(dataset)
      return { ...capture(), browserClosed: closed }
    }
    const result = await runMrWeekly(['--collect'], fixture.deps)
    assert.equal(result.succeeded, false)
    assert.equal(result.run.failureReason, 'collection-failed')
    assert.equal(result.run.datasetId, null)
    assert.equal(fixture.written[0].dataset, undefined)
  }
})

test('output failures do not mark an artifact and never expose filesystem or error text', async () => {
  for (const artifactFailed of [false, true]) {
    const fixture = setup()
    if (artifactFailed) fixture.deps.artifactReady = async () => { throw new Error(PRIVATE) }
    else fixture.deps.writeOutput = async () => { throw new Error(PRIVATE) }
    const result = await runMrWeekly(['--collect'], fixture.deps)
    assert.equal(result.succeeded, false)
    assert.equal(result.artifactReady, false)
    assert.equal(result.run.failureReason, 'output-unavailable')
    assert.equal(result.run.datasetId, null)
    assert.equal(JSON.stringify(result).includes(PRIVATE), false)
    assert.equal(fixture.calls.includes('artifact'), false)
  }
})

test('run parser rejects private fields, invalid times, unsupported classifications and inconsistent completion', () => {
  assert.deepEqual(parseMrWeeklyRunReport(report()), report())
  const invalid = [
    { ...report(), cookie: PRIVATE }, { ...report(), id: '../escape' }, { ...report(), status: PRIVATE }, { ...report(), event: 'pull_request' },
    { ...report(), startedAt: '2026-02-30T00:00:00.000Z' }, { ...report(), endedAt: '2026-10-15T00:00:00.000Z' },
    { ...report(), datasetId: '../../private' }, { ...report(), failureReason: 'collection-failed' }, { ...report(false), datasetId: dataset.id },
    { ...report(), capture: { ...capture(), rawCookie: PRIVATE } }, { ...report(), capture: { ...capture(), requestCount: 601 } },
    { ...report(), capture: { ...capture(), successfulReadCount: 107 } }, { ...report(), capture: { ...capture(), confirmedBoundaryCount: 24 } },
    { ...report(), capture: { ...capture(), readFailureCode: PRIVATE } }, { ...report(), capture: { ...capture(), imported: true } },
    { ...report(), capture: { ...capture(), browserClosed: false } }, { ...report(), capture: { ...capture(), startedAt: '2026-10-15T00:00:00.000Z' } },
  ]
  for (const input of invalid) assert.throws(() => parseMrWeeklyRunReport(input), (error: unknown) => error instanceof MrWeeklyError && !error.message.includes(PRIVATE))
})

test('output writer validates complete or failed snapshots before promotion and refuses overwrite', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'mr-weekly-output-test-'))
  try {
    const complete = resolve(directory, 'complete'), failed = resolve(directory, 'failed')
    await writeMrWeeklyOutput({ run: report(), dataset }, complete)
    assert.deepEqual(await validateMrDistributionDirectory(resolve(complete, 'public')), { datasets: 1, entries: 26 })
    assert.deepEqual(await readdir(resolve(complete, 'runs')), ['run-123-1.json'])
    assert.deepEqual(parseMrWeeklyRunReport(JSON.parse(await readFile(resolve(complete, 'runs/run-123-1.json'), 'utf8'))), report())
    const original = await readFile(resolve(complete, 'public/index.json'), 'utf8')
    await assert.rejects(writeMrWeeklyOutput({ run: report(false) }, complete))
    assert.equal(await readFile(resolve(complete, 'public/index.json'), 'utf8'), original)
    await writeMrWeeklyOutput({ run: report(false) }, failed)
    const manifest = parseMrDistributionManifest(JSON.parse(await readFile(resolve(failed, 'public/index.json'), 'utf8')))
    assert.equal(manifest.datasets.length, 0)
    assert.equal(manifest.availability?.status, 'collection-failed')
    assert.equal(manifest.availability?.checkedAt, report(false).endedAt)
    assert.deepEqual(await validateMrDistributionDirectory(resolve(failed, 'public')), { datasets: 0, entries: 0 })
    await assert.rejects(writeMrWeeklyOutput({ run: report(), dataset: undefined }, resolve(directory, 'missing')))
    await assert.rejects(writeMrWeeklyOutput({ run: report(false), dataset }, resolve(directory, 'partial')))
    await assert.rejects(writeMrWeeklyOutput({ run: report(), dataset: { ...dataset, totalCount: dataset.totalCount + 1 } }, resolve(directory, 'invalid')))
    assert.deepEqual((await readdir(directory)).sort(), ['complete', 'failed'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
