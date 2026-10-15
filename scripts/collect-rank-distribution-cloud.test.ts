import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  parseRankDistributionCloudArguments, rankDistributionCloudBrowserEnvironment,
  RANK_DISTRIBUTION_CLOUD_CHECKPOINT_PATH, RANK_DISTRIBUTION_CLOUD_DATA_DIRECTORY,
  RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY, RANK_DISTRIBUTION_CLOUD_REPORT_PATH,
  BUCKLER_CLOUD_RANK_CHECKPOINT_ENV,
  RankDistributionCloudError, runRankDistributionCloudCollection, summarizeRankDistributionCloudCapture,
} from './collect-rank-distribution-cloud.ts'
import type {
  RankDistributionCloudDependencies, RankDistributionCloudLaunchOptions, RankDistributionCloudOutputIo,
} from './collect-rank-distribution-cloud.ts'
import { RANK_DISTRIBUTION_CAPTURE_DIRECTORY, runRankDistributionCollection } from './collect-rank-distribution.ts'
import { BUCKLER_CLOUD_SESSION_ENV, BUCKLER_CLOUD_SESSION_SIZE_LIMIT } from './probe-buckler-cloud.ts'
import { RANK_BOUNDARY_SOURCE_URL } from './lib/rank-distribution-boundaries.ts'
import type { RankBoundaryPage } from './lib/rank-distribution-boundaries.ts'
import {
  mergeRankDistributionCheckpoints, parseRankDistributionCheckpoint, RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT,
} from './lib/rank-distribution-checkpoint.ts'
import type { RankDistributionCheckpoint } from './lib/rank-distribution-checkpoint.ts'
import { RankDistributionDomError } from './lib/rank-distribution-dom.ts'
import type { RankDistributionPageReaderDiagnostics } from './lib/rank-distribution-dom.ts'

const SECRET = 'synthetic-private-cookie-value'
const startedAt = '2026-10-15T10:00:00.000Z'
const stateJson = () => JSON.stringify({ cookies: [{ name: 'synthetic', value: SECRET, domain: '.streetfighter.com',
  path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] })
const hosted = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  GITHUB_REPOSITORY: 'gonchiman/sf6', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/codex/buckler-cloud-collection-test' })

function historicalSeed(): RankDistributionCheckpoint {
  const observedAt = '2026-10-15T09:59:00.000Z'
  return { schemaVersion: 1, method: 'boundary-search-estimate', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
    pageSize: 5, savedAt: observedAt, hints: Array.from({ length: 35 }, (_, index) => ({
      rankId: index + 2, countAtOrAbove: (35 - index) * 2, totalCount: 72, observedAt,
    })) }
}

function fixture() {
  const infos = new Map<string, { directory: boolean; file: boolean; symbolicLink: boolean }>()
  for (let current = dirname(RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY); ; current = dirname(current)) {
    infos.set(current, { directory: true, file: false, symbolicLink: false })
    if (current === dirname(current)) break
  }
  const outputs = new Map<string, string>()
  const privateWrites = new Map<string, unknown>()
  const io: RankDistributionCloudOutputIo = {
    inspect: async path => infos.get(path) ?? null,
    mkdir: async path => { infos.set(path, { directory: true, file: false, symbolicLink: false }) },
    write: async (path, text) => {
      assert.equal(outputs.has(path), false)
      outputs.set(path, text)
      infos.set(path, { directory: false, file: true, symbolicLink: false })
    },
  }
  let checkpoint: RankDistributionCheckpoint | null = null
  let stopAfterHints: number | undefined
  let stop = false
  const values = Array.from({ length: 36 }, (_, index) => 36 - index).flatMap(rankId => [1, 0].map(offset => ({
    rankId, leaguePoint: rankId * 100 + offset,
  }))).map((row, index) => ({ ...row, accountKey: index.toString(16).padStart(64, '0') }))
  const diagnostics: RankDistributionPageReaderDiagnostics = {
    requestCount: 0, successfulReadCount: 0, pageSize: null, totalCount: null, lastPage: null,
    observedRankIds: [], tailRankIds: [], rankMappingConfirmed: false, leagueLabelsConfirmed: false,
    displayedConditionsConfirmed: false, userStatusEvidence: 'fixed-url-only',
  }
  const launches: RankDistributionCloudLaunchOptions[] = []
  const imports: Array<{ input: string; output: string }> = []
  let closes = 0
  let artifactReadyCalls = 0
  let clock = 0
  const env: Record<string, string | undefined> = { ...hosted(), [BUCKLER_CLOUD_SESSION_ENV]: stateJson(),
    DEBUG: 'pw:*', NODE_OPTIONS: '--inspect', PWDEBUG: '1', PW_TRACE_DIR: SECRET,
    PLAYWRIGHT_LOG_PATH: SECRET, GITHUB_TOKEN: 'synthetic-github-token', PATH: 'synthetic-platform-path',
    GITHUB_OUTPUT: 'synthetic-github-output-file' }
  const dependencies: RankDistributionCloudDependencies = {
    env, outputIo: io,
    artifactReady: async () => {
      assert.equal(outputs.has(RANK_DISTRIBUTION_CLOUD_REPORT_PATH), true)
      artifactReadyCalls++
    },
    now: () => new Date(Date.parse(startedAt) + clock++),
    wait: async (_ms, signal) => { signal.throwIfAborted() },
    checkpointStore: {
      load: async () => checkpoint && structuredClone(checkpoint),
      save: async incoming => {
        checkpoint = mergeRankDistributionCheckpoints(checkpoint, parseRankDistributionCheckpoint(incoming))
        if (stopAfterHints !== undefined && checkpoint.hints.length >= stopAfterHints) stop = true
        return structuredClone(checkpoint)
      },
    },
    writePrivate: async (name, value) => {
      const path = resolve(RANK_DISTRIBUTION_CAPTURE_DIRECTORY, name)
      privateWrites.set(path, structuredClone(value))
      return path
    },
    importDataset: async (input, output) => {
      imports.push({ input, output })
      return { datasets: 1, entries: 36 }
    },
    launch: async options => {
      launches.push(options)
      return {
        fetchPage: async (page, sourceUrl): Promise<RankBoundaryPage> => {
          if (stop) throw new RankDistributionDomError('http-denied')
          const result = { sourceUrl, page, pageSize: 5, totalCount: values.length, totalPages: Math.ceil(values.length / 5),
            entries: structuredClone(values.slice((page - 1) * 5, page * 5)) }
          diagnostics.requestCount++
          diagnostics.successfulReadCount++
          diagnostics.pageSize = result.pageSize
          diagnostics.totalCount = result.totalCount
          diagnostics.lastPage = page
          diagnostics.lastAttemptedPage = page
          diagnostics.lastObservedTotal = result.totalCount
          diagnostics.lastHttpStatus = 200
          diagnostics.rankMappingConfirmed = true
          diagnostics.leagueLabelsConfirmed = true
          diagnostics.displayedConditionsConfirmed = true
          diagnostics.observedRankIds = [...new Set([...diagnostics.observedRankIds, ...result.entries.map(row => row.rankId)])]
          if (page === result.totalPages) diagnostics.tailRankIds = [...new Set(result.entries.map(row => row.rankId))]
          return result
        },
        getDiagnostics: () => ({ ...diagnostics, privateDOM: SECRET }),
        close: async () => { closes++ },
      }
    },
  }
  return { dependencies, env, infos, outputs, privateWrites, launches, imports,
    closes: () => closes, checkpoint: () => checkpoint,
    artifactReadyCalls: () => artifactReadyCalls,
    stopAfter: (count: number) => { stopAfterHints = count },
  }
}

test('cloud CLI accepts saved session and bounded resume controls, with no arbitrary locations or browser modes', () => {
  assert.deepEqual(parseRankDistributionCloudArguments(['--saved-session']), { mode: 'collect', maxRequests: 600, accuracy: 'estimate' })
  assert.deepEqual(parseRankDistributionCloudArguments(['--saved-session', '--resume', '--max-requests', '20']),
    { mode: 'collect', maxRequests: 20, accuracy: 'estimate', resume: true })
  assert.deepEqual(parseRankDistributionCloudArguments(['--help']), { mode: 'help' })
  for (const args of [[], ['--anonymous'], ['--saved-session', '--strict'], ['--saved-session', '--headless'],
    ['--saved-session', '--resume', '--resume'], ['--saved-session', '--path', SECRET],
    ['--saved-session', '--max-requests', '1001'], ['--saved-session', '--max-requests', '02']]) {
    assert.throws(() => parseRankDistributionCloudArguments(args), error =>
      error instanceof RankDistributionCloudError && error.code === 'arguments' && !error.message.includes(SECRET))
  }
})

test('synthetic complete collection consumes the secret, isolates browser env and stages only validated aggregate/report/checkpoint', async () => {
  const setup = fixture()
  setup.dependencies.collect = async (options, deps) => ({ ...await runRankDistributionCollection(options, deps), privateCookie: SECRET })
  const result = await runRankDistributionCloudCollection(['--saved-session'], setup.dependencies)
  assert.equal(result.succeeded, true)
  assert.equal(result.artifactReady, true)
  assert.equal(setup.artifactReadyCalls(), 1)
  assert.equal(result.report.publicationTarget, 'artifact-staging')
  assert.equal(result.report.datasetStaged, true)
  assert.equal(result.report.checkpointStaged, true)
  assert.equal(result.report.checkpointSeeded, false)
  assert.equal(result.report.appImported, false)
  assert.equal(result.report.deployed, false)
  assert.equal(result.report.artifactUploaded, false)
  assert.equal(result.report.capture.confirmedBoundaryCount, 35)
  assert.equal(setup.closes(), 1)
  assert.equal(setup.imports.length, 1)
  assert.equal(setup.imports[0].output, RANK_DISTRIBUTION_CLOUD_DATA_DIRECTORY)
  assert.equal(setup.launches.length, 1)
  assert.equal(setup.launches[0].headless, false)
  assert.equal(setup.launches[0].channel, 'msedge')
  assert.equal(setup.launches[0].minIntervalMs, 5000)
  assert.equal(setup.launches[0].totalCountPolicy, 'record')
  assert.equal(setup.launches[0].storageState.cookies[0].value, SECRET)
  for (const key of [BUCKLER_CLOUD_SESSION_ENV, 'DEBUG', 'NODE_OPTIONS', 'PWDEBUG', 'PW_TRACE_DIR', 'PLAYWRIGHT_LOG_PATH']) {
    assert.equal(key in setup.env, false)
    assert.equal(key in setup.launches[0].env, false)
  }
  assert.equal('GITHUB_TOKEN' in setup.launches[0].env, false)
  assert.equal('GITHUB_OUTPUT' in setup.launches[0].env, false)
  assert.equal(setup.launches[0].env.PATH, 'synthetic-platform-path')
  assert.deepEqual([...setup.outputs.keys()].sort(), [RANK_DISTRIBUTION_CLOUD_CHECKPOINT_PATH, RANK_DISTRIBUTION_CLOUD_REPORT_PATH].sort())
  assert.equal(setup.checkpoint()?.hints.length, 35)
  assert.ok(!JSON.stringify([result, [...setup.outputs], [...setup.privateWrites]]).includes(SECRET))
  assert.ok(!JSON.stringify([...setup.outputs]).includes('accountKey'))
})

test('stopped collection exports safe hints and report without importing or staging a partial dataset', async () => {
  const setup = fixture()
  setup.stopAfter(4)
  const result = await runRankDistributionCloudCollection(['--saved-session'], setup.dependencies)
  assert.equal(result.succeeded, false)
  assert.equal(result.artifactReady, true)
  assert.equal(setup.artifactReadyCalls(), 1)
  assert.equal(result.report.capture.status, 'failed')
  assert.equal(result.report.capture.reason, 'access-denied')
  assert.equal(result.report.capture.confirmedBoundaryCount, 4)
  assert.equal(result.report.datasetStaged, false)
  assert.equal(result.report.checkpointStaged, true)
  assert.equal(setup.imports.length, 0)
  assert.equal([...setup.privateWrites.keys()].some(path => path.includes('max-lp-estimate-')), false)
  assert.equal(JSON.parse(setup.outputs.get(RANK_DISTRIBUTION_CLOUD_CHECKPOINT_PATH)!).hints.length, 4)
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('cloud checkpoint seed is consumed, saved in the fixed store and used only as hints for all fresh boundary confirmations', async () => {
  const setup = fixture()
  setup.env[BUCKLER_CLOUD_RANK_CHECKPOINT_ENV] = JSON.stringify(historicalSeed())
  const result = await runRankDistributionCloudCollection(['--saved-session', '--resume'], setup.dependencies)
  assert.equal(result.succeeded, true)
  assert.equal(result.report.checkpointSeeded, true)
  assert.equal(result.report.capture.checkpointLoaded, true)
  assert.equal(result.report.capture.confirmedBoundaryCount, 35)
  assert.ok(result.report.capture.requestCount >= 39)
  assert.equal(BUCKLER_CLOUD_RANK_CHECKPOINT_ENV in setup.env, false)
  assert.equal(BUCKLER_CLOUD_RANK_CHECKPOINT_ENV in setup.launches[0].env, false)
  const dataset = [...setup.privateWrites.values()].find(value => value && typeof value === 'object' && 'entries' in value) as {
    captureStartedAt: string; entries: Array<{ rankId: number; count: number }>;
    observation: { boundaries: Array<{ observedAt: string }> }
  }
  assert.deepEqual(dataset.entries, Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, count: 2 })))
  assert.equal(dataset.observation.boundaries.length, 35)
  assert.ok(dataset.observation.boundaries.every(boundary => boundary.observedAt >= dataset.captureStartedAt))
  assert.ok(setup.checkpoint()!.hints.every(hint => hint.observedAt >= dataset.captureStartedAt))
})

test('resume without an input seed still uses the existing fixed checkpoint store', async () => {
  const setup = fixture()
  await setup.dependencies.checkpointStore!.save(historicalSeed())
  setup.env[BUCKLER_CLOUD_RANK_CHECKPOINT_ENV] = ''
  const result = await runRankDistributionCloudCollection(['--saved-session', '--resume'], setup.dependencies)
  assert.equal(result.succeeded, true)
  assert.equal(result.report.checkpointSeeded, false)
  assert.equal(result.report.capture.checkpointLoaded, true)
})

test('checkpoint seeds reject incompatible mode, excessive size, unknown fields and future dates before launch', async () => {
  const cases = [
    { args: ['--saved-session'], seed: JSON.stringify(historicalSeed()), code: 'checkpoint-without-resume' },
    { args: ['--saved-session', '--resume'], seed: 'x'.repeat(RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT + 1), code: 'checkpoint-too-large' },
    { args: ['--saved-session', '--resume'], seed: SECRET, code: 'checkpoint-invalid' },
    { args: ['--saved-session', '--resume'], seed: JSON.stringify({ ...historicalSeed(), cookie: SECRET }), code: 'checkpoint-invalid' },
    { args: ['--saved-session', '--resume'], seed: JSON.stringify({ ...historicalSeed(), savedAt: '2099-01-01T00:00:00.000Z' }), code: 'checkpoint-invalid' },
    { args: ['--invalid', SECRET], seed: JSON.stringify(historicalSeed()), code: 'arguments' },
  ]
  for (const item of cases) {
    const setup = fixture()
    setup.env[BUCKLER_CLOUD_RANK_CHECKPOINT_ENV] = item.seed
    await assert.rejects(runRankDistributionCloudCollection(item.args, setup.dependencies), error =>
      error instanceof RankDistributionCloudError && error.code === item.code && !error.message.includes(SECRET))
    assert.equal(BUCKLER_CLOUD_RANK_CHECKPOINT_ENV in setup.env, false)
    assert.equal(BUCKLER_CLOUD_SESSION_ENV in setup.env, false)
    assert.equal(setup.launches.length, 0)
    assert.equal(setup.outputs.size, 0)
    assert.equal(setup.artifactReadyCalls(), 0)
    assert.equal(setup.checkpoint(), null)
  }
})

test('artifact import failure remains a failed staging result while retaining the safe checkpoint', async () => {
  const setup = fixture()
  setup.dependencies.importDataset = async () => { throw new Error(`private import error ${SECRET}`) }
  const result = await runRankDistributionCloudCollection(['--saved-session'], setup.dependencies)
  assert.equal(result.succeeded, false)
  assert.equal(result.report.capture.reason, 'publication-failed')
  assert.equal(result.report.datasetStaged, false)
  assert.equal(result.report.capture.published, false)
  assert.equal(result.report.checkpointStaged, true)
  assert.ok(!JSON.stringify([result, [...setup.outputs]]).includes(SECRET))
})

test('an invalid checkpoint cannot be copied into Artifacts or count as a successful export', async () => {
  const setup = fixture()
  const store = setup.dependencies.checkpointStore!
  setup.dependencies.checkpointStore = {
    save: value => store.save(value),
    load: async () => {
      const checkpoint = await store.load()
      return checkpoint ? { ...checkpoint, cookie: SECRET } : null
    },
  }
  const result = await runRankDistributionCloudCollection(['--saved-session'], setup.dependencies)
  assert.equal(result.succeeded, false)
  assert.equal(result.report.checkpointExport, 'failed')
  assert.equal(result.report.checkpointStaged, false)
  assert.equal(setup.outputs.has(RANK_DISTRIBUTION_CLOUD_CHECKPOINT_PATH), false)
  assert.ok(!JSON.stringify([result, [...setup.outputs]]).includes(SECRET))
})

test('credentials and diagnostics are removed even when arguments, runner guard or state validation fail', async () => {
  const cases = [
    { args: ['--path', SECRET], patch: {}, code: 'arguments' },
    { args: ['--saved-session'], patch: { RUNNER_ENVIRONMENT: 'self-hosted' }, code: 'runner' },
    { args: ['--saved-session'], patch: { GITHUB_EVENT_NAME: 'push' }, code: 'runner' },
    { args: ['--saved-session'], patch: { GITHUB_REPOSITORY: 'someone/else' }, code: 'runner' },
    { args: ['--saved-session'], patch: { GITHUB_REF: 'refs/heads/main' }, code: 'runner' },
    { args: ['--saved-session'], patch: { [BUCKLER_CLOUD_SESSION_ENV]: '' }, code: 'session-missing' },
    { args: ['--saved-session'], patch: { [BUCKLER_CLOUD_SESSION_ENV]: 'x'.repeat(BUCKLER_CLOUD_SESSION_SIZE_LIMIT) }, code: 'session-too-large' },
    { args: ['--saved-session'], patch: { [BUCKLER_CLOUD_SESSION_ENV]: stateJson().replace('.streetfighter.com', '.capcom.com') }, code: 'session-invalid' },
  ]
  for (const item of cases) {
    const setup = fixture()
    Object.assign(setup.env, item.patch)
    await assert.rejects(runRankDistributionCloudCollection(item.args, setup.dependencies), error =>
      error instanceof RankDistributionCloudError && error.code === item.code && !error.message.includes(SECRET))
    assert.equal(BUCKLER_CLOUD_SESSION_ENV in setup.env, false)
    assert.equal('DEBUG' in setup.env, false)
    assert.equal(setup.launches.length, 0)
    assert.equal(setup.outputs.size, 0)
    assert.equal(setup.artifactReadyCalls(), 0)
  }
})

test('an existing staging directory is never marked uploadable, and report-write errors keep the readiness output absent', async () => {
  const stale = fixture()
  stale.infos.set(RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY, { directory: true, file: false, symbolicLink: false })
  stale.outputs.set(RANK_DISTRIBUTION_CLOUD_REPORT_PATH, SECRET)
  await assert.rejects(runRankDistributionCloudCollection(['--saved-session'], stale.dependencies), error =>
    error instanceof RankDistributionCloudError && error.code === 'output')
  assert.equal(stale.artifactReadyCalls(), 0)
  assert.equal(stale.launches.length, 0)
  assert.equal(stale.outputs.get(RANK_DISTRIBUTION_CLOUD_REPORT_PATH), SECRET)

  const interrupted = fixture()
  const write = interrupted.dependencies.outputIo!.write
  interrupted.dependencies.outputIo!.write = async (path, text) => {
    if (path === RANK_DISTRIBUTION_CLOUD_REPORT_PATH) throw new Error(SECRET)
    await write(path, text)
  }
  await assert.rejects(runRankDistributionCloudCollection(['--saved-session'], interrupted.dependencies), error =>
    error instanceof RankDistributionCloudError && error.code === 'output' && !error.message.includes(SECRET))
  assert.equal(interrupted.artifactReadyCalls(), 0)
})

test('workflow uploads only after the collection step explicitly marks safe staging ready, including failure paths', async () => {
  const workflow = await readFile(new URL('../.github/workflows/rank-distribution-cloud-probe.yml', import.meta.url), 'utf8')
  assert.match(workflow, /name: Collect all rank boundaries once\s+id: collect/)
  assert.match(workflow, /name: Upload only safe aggregate, checkpoint and report\s+if: always\(\) && steps\.collect\.outputs\.artifact_ready == 'true'/)
  assert.doesNotMatch(workflow, /path:\s*\.local\//)
})

test('fixed output parents reject links and existing staging, without browser launch or recursive removal', async () => {
  for (const target of [dirname(RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY), RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY]) {
    const setup = fixture()
    setup.infos.set(target, { directory: true, file: false, symbolicLink: true })
    await assert.rejects(runRankDistributionCloudCollection(['--saved-session'], setup.dependencies), error =>
      error instanceof RankDistributionCloudError && error.code === 'output')
    assert.equal(setup.launches.length, 0)
    assert.equal(setup.outputs.size, 0)
  }
})

test('browser environment is a platform allowlist and summary drops unknown diagnostics or text-bearing values', () => {
  assert.deepEqual(rankDistributionCloudBrowserEnvironment({ PATH: 'platform', GITHUB_TOKEN: SECRET, CUSTOM_SECRET: SECRET,
    [BUCKLER_CLOUD_SESSION_ENV]: SECRET, DEBUG: SECRET }), { PATH: 'platform' })
  const summary = summarizeRankDistributionCloudCapture({ status: 'failed', stage: SECRET, reason: SECRET,
    readFailureCode: SECRET, startedAt: SECRET, endedAt: SECRET, rows: [{ accountKey: SECRET }],
    requestCount: SECRET, checkpointHintCount: 999, lastHttpStatus: 503 })
  assert.equal(summary.stage, null)
  assert.equal(summary.lastHttpStatus, 503)
  assert.equal(summary.checkpointHintCount, 0)
  assert.ok(!JSON.stringify(summary).includes(SECRET))
  const authentication = summarizeRankDistributionCloudCapture({ lastAuthenticationEvidence: 'login-control',
    lastLoginRequiredHeading: false, lastRankingReadable: true })
  assert.equal(authentication.lastAuthenticationEvidence, 'login-control')
  assert.equal(authentication.lastLoginRequiredHeading, false)
  assert.equal(authentication.lastRankingReadable, true)
  const raw = summarizeRankDistributionCloudCapture({ lastAuthenticationEvidence: SECRET,
    lastLoginRequiredHeading: SECRET, lastRankingReadable: { raw: SECRET } })
  assert.equal(raw.lastAuthenticationEvidence, null)
  assert.equal(raw.lastLoginRequiredHeading, null)
  assert.equal(raw.lastRankingReadable, null)
  assert.ok(!JSON.stringify(raw).includes(SECRET))
})
