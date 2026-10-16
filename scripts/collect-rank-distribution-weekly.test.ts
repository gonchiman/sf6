import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseRankDistributionDataset, parseRankDistributionManifest, RANK_DISTRIBUTION_CONDITIONS,
  RANK_DISTRIBUTION_ESTIMATE_CHECKS, RANK_DISTRIBUTION_SOURCE,
} from '../src/lib/rankDistribution.ts'
import type { RankDistributionDataset } from '../src/types/rankDistribution.ts'
import {
  BUCKLER_CLOUD_RANK_CHECKPOINT_ENV, summarizeRankDistributionCloudCapture,
} from './collect-rank-distribution-cloud.ts'
import type { RankDistributionCloudCaptureSummary, RankDistributionCloudReport } from './collect-rank-distribution-cloud.ts'
import {
  parseRankDistributionWeeklyArguments, RankDistributionWeeklyError, runRankDistributionWeeklyCollection,
} from './collect-rank-distribution-weekly.ts'
import type { RankDistributionWeeklyDependencies } from './collect-rank-distribution-weekly.ts'
import { BUCKLER_CLOUD_SESSION_ENV } from './probe-buckler-cloud.ts'
import { BUCKLER_WEEKLY_SESSION_SECRET, createBucklerWeeklySession } from './lib/buckler-weekly-session.ts'
import { RANK_BOUNDARY_SOURCE_URL } from './lib/rank-distribution-boundaries.ts'
import { mergeRankDistributionCheckpoints, parseRankDistributionCheckpoint } from './lib/rank-distribution-checkpoint.ts'
import type { RankDistributionCheckpoint } from './lib/rank-distribution-checkpoint.ts'
import type { RankDistributionWeeklyHistory, WriteWeeklyHistoryOutputOptions } from './lib/rank-distribution-weekly-history.ts'

const SECRET = 'synthetic-weekly-private-cookie'
const START = '2026-10-22T12:00:00.000Z'
const PRIOR = '2026-10-15T12:00:00.000Z'
const later = (value: string, milliseconds: number) => new Date(Date.parse(value) + milliseconds).toISOString()
const hosted = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  GITHUB_REPOSITORY: 'gonchiman/sf6', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/rank-distribution-weekly.yml@refs/heads/main',
  GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '1' })
function dataset(start = later(START, 100)): RankDistributionDataset {
  return parseRankDistributionDataset({ schemaVersion: 1, id: `max-lp-estimate-${start.replace(/[:.]/g, '-')}`,
    captureStartedAt: start, captureEndedAt: later(start, 60000), generatedAt: later(start, 120000),
    source: { ...RANK_DISTRIBUTION_SOURCE, population: 'synthetic listed accounts', metric: 'synthetic ranks', unit: 'fighter-account',
      notes: ['synthetic aggregate fixture'] }, conditions: RANK_DISTRIBUTION_CONDITIONS, method: 'boundary-search-estimate', totalCount: 36,
    entries: Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, count: 1 })),
    validation: { status: 'estimated', coverage: 'all-rank-boundaries', checks: [...RANK_DISTRIBUTION_ESTIMATE_CHECKS], notes: ['synthetic boundary proof'] },
    observation: { totalAtStart: 36, totalAtEnd: 36, minTotal: 36, maxTotal: 36,
      boundaries: Array.from({ length: 35 }, (_, index) => ({ rankId: index + 2, countAtOrAbove: 35 - index,
        totalCount: 36, observedAt: later(start, 30000) })) } })
}
function checkpoint(start = PRIOR): RankDistributionCheckpoint {
  const observedAt = later(start, 30000)
  return { schemaVersion: 1, method: 'boundary-search-estimate', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
    pageSize: 20, savedAt: observedAt, hints: Array.from({ length: 35 }, (_, index) => ({
      rankId: index + 2, countAtOrAbove: 35 - index, totalCount: 36, observedAt,
    })) }
}
function fixture(ageSeconds = 3600) {
  const capturedAt = later(START, -ageSeconds * 1000)
  const storageState = { cookies: [{ name: 'synthetic', value: SECRET, domain: '.streetfighter.com', path: '/',
    expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }
  const envelope = createBucklerWeeklySession({ capturedAt, uploadedAt: capturedAt, storageState }, new Date(START))
  const env: Record<string, string | undefined> = { ...hosted(), [BUCKLER_WEEKLY_SESSION_SECRET]: JSON.stringify(envelope),
    [BUCKLER_CLOUD_SESSION_ENV]: SECRET, [BUCKLER_CLOUD_RANK_CHECKPOINT_ENV]: SECRET,
    DEBUG: 'pw:*', NODE_OPTIONS: '--inspect', PWDEBUG: '1', PW_TRACE_DIR: SECRET, PLAYWRIGHT_LOG_PATH: SECRET }
  const oldDataset = dataset(PRIOR)
  const previous: RankDistributionWeeklyHistory = { datasets: [oldDataset], checkpoint: checkpoint(), runs: [],
    manifest: parseRankDistributionManifest({ schemaVersion: 1, generatedAt: oldDataset.generatedAt,
      source: RANK_DISTRIBUTION_SOURCE, datasets: [{ id: oldDataset.id, path: `${oldDataset.id}.json`,
        captureStartedAt: oldDataset.captureStartedAt, captureEndedAt: oldDataset.captureEndedAt, totalCount: oldDataset.totalCount }] }) }
  const saved: WriteWeeklyHistoryOutputOptions[] = []
  const cloudCalls: Array<{ args: string[]; deps: Parameters<NonNullable<RankDistributionWeeklyDependencies['runCloud']>>[1] }> = []
  let stored: RankDistributionCheckpoint | null = null
  let artifactCalls = 0
  let timeCalls = 0
  const capture = summarizeRankDistributionCloudCapture({ status: 'succeeded', stage: 'complete', reason: null,
    startedAt: later(START, 100), endedAt: later(START, 60100), requestCount: 100, successfulReadCount: 100,
    confirmedBoundaryCount: 35, checkpointLoaded: true, checkpointSaved: true, checkpointHintCount: 35,
    datasetSaved: true, published: true, browserClosed: true, totalMin: 36, totalMax: 36, totalAtEnd: 36,
    lastHttpStatus: 200, lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
  let summary: RankDistributionCloudCaptureSummary = capture
  let complete = true
  const deps: RankDistributionWeeklyDependencies = {
    env, now: () => new Date(timeCalls++ === 0 ? START : later(START, 180000)),
    loadPrevious: async () => previous,
    checkpointStore: {
      load: async () => stored && structuredClone(stored),
      save: async value => {
        stored = mergeRankDistributionCheckpoints(stored, parseRankDistributionCheckpoint(value))
        return structuredClone(stored)
      },
    },
    runCloud: async (args, cloudDeps) => {
      assert.equal(BUCKLER_WEEKLY_SESSION_SECRET in env, false)
      assert.equal(BUCKLER_CLOUD_SESSION_ENV in env, false)
      assert.equal(BUCKLER_CLOUD_RANK_CHECKPOINT_ENV in env, false)
      for (const key of ['DEBUG', 'NODE_OPTIONS', 'PWDEBUG', 'PW_TRACE_DIR', 'PLAYWRIGHT_LOG_PATH']) assert.equal(key in env, false)
      assert.equal(cloudDeps?.executionPolicy, 'weekly')
      assert.equal(cloudDeps?.memorySessionState?.cookies[0].value, SECRET)
      assert.equal(cloudDeps?.artifactReady, undefined)
      cloudCalls.push({ args, deps: cloudDeps })
      stored = checkpoint(START)
      const report: RankDistributionCloudReport = { schemaVersion: 1, cloudExecution: true, publicationTarget: 'artifact-staging',
        appImported: false, deployed: false, artifactUploaded: false, artifactReady: true, manualLoginPerformed: false,
        sessionLifetime: 'not-tested', weeklyExecution: 'not-tested', datasetStaged: complete, checkpointStaged: true,
        checkpointSeeded: false, checkpointExport: 'saved', capture: summary }
      return { succeeded: complete, artifactReady: true, report }
    },
    loadDataset: async () => dataset(),
    writeHistory: async options => { saved.push(structuredClone({ ...options, now: undefined })); return previous },
    artifactReady: async () => { assert.equal(saved.length, 1); artifactCalls++ },
  }
  return { deps, env, previous, saved, cloudCalls, artifactCalls: () => artifactCalls, stored: () => stored,
    failure: (successfulReadCount = 0) => {
      complete = false
      summary = summarizeRankDistributionCloudCapture({ ...capture, status: 'failed', stage: 'preflight',
        reason: 'authentication-unconfirmed', confirmedBoundaryCount: 0, successfulReadCount,
        datasetSaved: false, published: false, lastAuthenticationEvidence: 'login-control',
        lastRankingReadable: false, readFailureCode: 'authentication-unconfirmed' })
    },
    replaceSummary: (value: RankDistributionCloudCaptureSummary) => { summary = value }, capture,
  }
}

test('weekly CLI permits a bounded collection only and never accepts arbitrary paths or auth modes', () => {
  assert.deepEqual(parseRankDistributionWeeklyArguments(['--collect']), { mode: 'collect', maxRequests: 600 })
  assert.deepEqual(parseRankDistributionWeeklyArguments(['--collect', '--max-requests', '2']), { mode: 'collect', maxRequests: 2 })
  assert.deepEqual(parseRankDistributionWeeklyArguments(['--help']), { mode: 'help' })
  for (const args of [[], ['--resume'], ['--collect', '--strict'], ['--collect', '--path', SECRET],
    ['--collect', '--max-requests', '02'], ['--collect', '--max-requests', '1001'], ['--collect', '--max-requests', '1']]) {
    assert.throws(() => parseRankDistributionWeeklyArguments(args), error => error instanceof RankDistributionWeeklyError
      && error.code === 'arguments' && !error.message.includes(SECRET))
  }
})

test('secrets are consumed before arguments or the exact pinned main workflow identity is rejected', async () => {
  for (const patch of [{ GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/other.yml@refs/heads/main' },
    { GITHUB_REPOSITORY: 'someone/else' }, { RUNNER_OS: 'Linux' }, { GITHUB_REF: 'refs/heads/codex/buckler-cloud-collection' },
    { GITHUB_EVENT_NAME: 'push' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_RUN_ID: '01' }, { GITHUB_RUN_ATTEMPT: '0' }]) {
    const setup = fixture()
    Object.assign(setup.env, patch)
    await assert.rejects(runRankDistributionWeeklyCollection(['--collect'], setup.deps), error =>
      error instanceof RankDistributionWeeklyError && error.code === 'runner')
    assert.equal(BUCKLER_WEEKLY_SESSION_SECRET in setup.env, false)
    assert.equal(BUCKLER_CLOUD_SESSION_ENV in setup.env, false)
    assert.equal(BUCKLER_CLOUD_RANK_CHECKPOINT_ENV in setup.env, false)
    assert.equal(setup.cloudCalls.length, 0)
    assert.equal(setup.saved.length, 0)
    assert.equal(setup.artifactCalls(), 0)
  }
  const setup = fixture()
  await assert.rejects(runRankDistributionWeeklyCollection(['--bad', SECRET], setup.deps), error =>
    error instanceof RankDistributionWeeklyError && error.code === 'arguments' && !error.message.includes(SECRET))
  assert.equal(BUCKLER_WEEKLY_SESSION_SECRET in setup.env, false)
})

test('manual collection checks all boundaries, reuses hints in memory and stages a safe run only after history completes', async () => {
  const setup = fixture()
  const result = await runRankDistributionWeeklyCollection(['--collect', '--max-requests', '450'], setup.deps)
  assert.equal(result.succeeded, true)
  assert.equal(result.artifactReady, true)
  assert.equal(result.run.event, 'manual')
  assert.equal(result.run.initialSignInConfirmed, true)
  assert.equal(result.run.sessionAgeSeconds, 3600)
  assert.equal(result.run.reuseAfterSevenDays, 'pending')
  assert.equal(result.run.capture?.confirmedBoundaryCount, 35)
  assert.deepEqual(setup.cloudCalls[0].args, ['--saved-session', '--max-requests', '450', '--resume'])
  assert.equal(setup.cloudCalls[0].deps?.checkpointStore, setup.deps.checkpointStore)
  assert.equal(setup.saved.length, 1)
  assert.deepEqual(setup.saved[0].previous, setup.previous)
  assert.deepEqual(setup.saved[0].checkpoint, checkpoint(START))
  assert.equal(setup.saved[0].dataset?.id, result.run.datasetId)
  assert.equal(setup.artifactCalls(), 1)
  const text = JSON.stringify([result, setup.saved])
  for (const value of [SECRET, 'storageState', 'cookies', 'origins', 'sessionLifetime', 'weeklyExecution', 'accountKey']) assert.equal(text.includes(value), false)
})

test('seven-day authentication evidence is independent of later collection completion', async () => {
  for (const age of [604799, 604800, 604801]) {
    const setup = fixture(age)
    setup.env.GITHUB_EVENT_NAME = 'schedule'
    if (age === 604801) setup.failure(1)
    const result = await runRankDistributionWeeklyCollection(['--collect'], setup.deps)
    assert.equal(result.run.event, 'schedule')
    assert.equal(result.run.initialSignInConfirmed, true)
    assert.equal(result.run.reuseAfterSevenDays, age < 604800 ? 'pending' : 'confirmed')
    assert.equal(result.succeeded, age !== 604801)
  }
})

test('no successful initial authenticated page means unconfirmed even before seven days, while old data survives', async () => {
  for (const age of [1, 604800]) {
    const setup = fixture(age)
    setup.failure()
    const result = await runRankDistributionWeeklyCollection(['--collect'], setup.deps)
    assert.equal(result.succeeded, false)
    assert.equal(result.artifactReady, true)
    assert.equal(result.run.initialSignInConfirmed, false)
    assert.equal(result.run.reuseAfterSevenDays, 'unconfirmed')
    assert.equal(result.run.failureReason, 'collection-failed')
    assert.equal(result.run.datasetId, null)
    assert.equal(setup.saved[0].dataset, undefined)
    assert.deepEqual(setup.saved[0].previous.datasets, setup.previous.datasets)
    assert.equal(setup.artifactCalls(), 1)
    assert.equal(JSON.stringify(result).includes('expired'), false)
  }
})

test('missing, oversized, future or invalid envelopes are sanitized and preserve the existing normal history', async () => {
  for (const value of [undefined, SECRET, 'x'.repeat(48 * 1024),
    JSON.stringify({ schemaVersion: 1, capturedAt: later(START, 1), uploadedAt: later(START, 1), storageState: { cookies: [], origins: [] } })]) {
    const setup = fixture()
    setup.env[BUCKLER_WEEKLY_SESSION_SECRET] = value
    const result = await runRankDistributionWeeklyCollection(['--collect'], setup.deps)
    assert.equal(result.run.failureReason, 'authentication-unavailable')
    assert.equal(result.run.initialSignInConfirmed, false)
    assert.equal(result.run.reuseAfterSevenDays, 'unconfirmed')
    assert.equal(result.run.sessionCapturedAt, null)
    assert.equal(result.run.capture, null)
    assert.equal(result.artifactReady, true)
    assert.equal(setup.cloudCalls.length, 0)
    assert.deepEqual(setup.saved[0].previous, setup.previous)
    assert.equal(JSON.stringify(result).includes(SECRET), false)
  }
})

test('an empty first history omits resume while the collector still must prove the complete new capture', async () => {
  const setup = fixture()
  setup.previous.checkpoint = null
  setup.previous.datasets = []
  setup.previous.manifest.datasets = []
  const result = await runRankDistributionWeeklyCollection(['--collect'], setup.deps)
  assert.equal(result.succeeded, true)
  assert.deepEqual(setup.cloudCalls[0].args, ['--saved-session', '--max-requests', '600'])
  assert.equal(result.run.capture?.confirmedBoundaryCount, 35)
})

test('history refusal prevents collection and upload; output failure never authorizes an existing or partial staging tree', async () => {
  const setup = fixture()
  setup.deps.loadPrevious = async () => { throw new Error(SECRET) }
  const refused = await runRankDistributionWeeklyCollection(['--collect'], setup.deps)
  assert.equal(refused.run.failureReason, 'history-unavailable')
  assert.equal(refused.artifactReady, false)
  assert.equal(setup.cloudCalls.length, 0)
  assert.equal(setup.saved.length, 0)
  assert.equal(setup.artifactCalls(), 0)
  for (const markerFailure of [false, true]) {
    const failing = fixture()
    let writes = 0
    if (markerFailure) failing.deps.artifactReady = async () => { throw new Error(SECRET) }
    else failing.deps.writeHistory = async () => { writes++; throw new Error(SECRET) }
    const result = await runRankDistributionWeeklyCollection(['--collect'], failing.deps)
    assert.equal(result.succeeded, false)
    assert.equal(result.artifactReady, false)
    assert.equal(result.run.failureReason, 'output-unavailable')
    assert.equal(result.run.datasetId, null)
    assert.equal(writes, markerFailure ? 0 : 1)
    assert.equal(failing.artifactCalls(), 0)
    assert.equal(JSON.stringify(result).includes(SECRET), false)
  }
})

test('an incomplete or mismatched dataset is never promoted and no private cloud exception appears in the run', async () => {
  for (const kind of ['dataset', 'checkpoint', 'cloud'] as const) {
    const setup = fixture()
    if (kind === 'dataset') setup.deps.loadDataset = async () => ({ ...dataset(), cookie: SECRET } as RankDistributionDataset)
    if (kind === 'checkpoint') setup.deps.checkpointStore!.load = async () => ({ ...checkpoint(START), cookie: SECRET } as RankDistributionCheckpoint)
    if (kind === 'cloud') setup.deps.runCloud = async () => { throw new Error(SECRET) }
    const result = await runRankDistributionWeeklyCollection(['--collect'], setup.deps)
    assert.equal(result.succeeded, false)
    assert.equal(result.run.failureReason, kind === 'cloud' ? 'collection-failed' : 'output-unavailable')
    assert.equal(setup.saved[0].dataset, undefined)
    assert.equal(result.run.datasetId, null)
    assert.equal(JSON.stringify([result, setup.saved]).includes(SECRET), false)
  }
})

test('unknown fields in a cloud capture are scrubbed instead of reaching a weekly report or history writer', async () => {
  const setup = fixture()
  setup.replaceSummary({ ...setup.capture, rawProfile: SECRET, storageState: SECRET } as RankDistributionCloudCaptureSummary)
  const result = await runRankDistributionWeeklyCollection(['--collect'], setup.deps)
  assert.equal(result.succeeded, true)
  assert.equal(JSON.stringify([result, setup.saved]).includes(SECRET), false)
  assert.equal('rawProfile' in result.run.capture!, false)
})
