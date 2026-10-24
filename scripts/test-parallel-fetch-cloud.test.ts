import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseParallelFetchReport, plannedParallelFetchAttempts } from '../src/lib/parallelFetch.ts'
import type { ParallelFetchReport } from '../src/types/parallelFetch.ts'
import { BUCKLER_WEEKLY_SESSION_SECRET } from './lib/buckler-weekly-session.ts'
import { ParallelFetchReadError, runParallelFetch } from './lib/parallel-fetch-runner.ts'
import { isAllowedParallelFetchCloudExecution, PARALLEL_FETCH_CLOUD_BRANCH, PARALLEL_FETCH_CLOUD_TIMEOUT_MS,
  PARALLEL_FETCH_CLOUD_WORKFLOW, PARALLEL_FETCH_MAIN_WORKFLOW, ParallelFetchCloudError,
  parseParallelFetchCloudArguments, runParallelFetchCloudTest } from './test-parallel-fetch-cloud.ts'
import type { ParallelFetchCloudDependencies } from './test-parallel-fetch-cloud.ts'

const SECRET = 'synthetic-private-test-cookie'
const START = '2026-10-21T00:00:00.000Z'
const REQUEST_ID = '602771dc-8574-43da-97ac-d6990cc22246'
const envelope = () => JSON.stringify({ schemaVersion: 1, capturedAt: '2026-10-20T00:00:00.000Z',
  uploadedAt: '2026-10-20T00:01:00.000Z', storageState: { cookies: [{ name: 'session', value: SECRET,
    domain: '.streetfighter.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] } })
const hosted = (): Record<string, string | undefined> => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'gonchiman/sf6', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: PARALLEL_FETCH_CLOUD_BRANCH, GITHUB_WORKFLOW_REF: PARALLEL_FETCH_CLOUD_WORKFLOW,
  GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '2', [BUCKLER_WEEKLY_SESSION_SECRET]: envelope() })
const mainHosted = (): Record<string, string | undefined> => ({ ...hosted(), GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: PARALLEL_FETCH_MAIN_WORKFLOW, GITHUB_SHA: 'a'.repeat(40), PARALLEL_FETCH_REQUEST_ID: REQUEST_ID })

function fixture(env = hosted()) {
  let ticks = 0, opens = 0, closes = 0, marked = 0, disarmed = 0, readers = 0, closedReaders = 0
  let timeout: (() => void) | undefined
  let browserSignal: AbortSignal | undefined
  const reads: { worker: number; page: number }[] = []
  const saved: ParallelFetchReport[] = []
  const order: string[] = []
  const deps: ParallelFetchCloudDependencies = {
    env, now: () => new Date(Date.parse(START) + ticks),
    armDeadline: (abort, milliseconds) => {
      assert.equal(milliseconds, PARALLEL_FETCH_CLOUD_TIMEOUT_MS)
      timeout = abort
      return () => { disarmed++ }
    },
    openBrowser: async (options, dependencies) => {
      opens++
      browserSignal = options.signal
      assert.ok(options.intervalMs >= 0 && options.intervalMs <= 60000)
      assert.equal(env[BUCKLER_WEEKLY_SESSION_SECRET], undefined)
      assert.ok(dependencies?.loadSession, 'the browser receives a memory loader, not a private file location')
      assert.equal((await dependencies.loadSession()).cookies[0].value, SECRET)
      await assert.rejects(dependencies.loadSession(), error => error instanceof ParallelFetchReadError && error.code === 'session-unavailable')
      return {
        createReader: async (worker, target, signal) => {
          assert.equal(target, 'lp')
          readers++
          return {
            readPage: async (page, navigationGate) => navigationGate(async () => {
              assert.equal(signal.aborted, false)
              reads.push({ worker, page }); ticks += 1000
              return { totalCount: 3000000, totalPages: 150000, httpStatus: 200,
                diagnostics: { authenticationEvidence: 'logout-control' as const, loginRequiredHeading: false, rankingReadable: true } }
            }),
            close: async () => { closedReaders++ },
          }
        },
        close: async () => { closes++; order.push('close') },
      }
    },
    run: (config, dependencies) => runParallelFetch(config, { ...dependencies,
      now: () => ticks, wait: async (milliseconds, signal) => { signal.throwIfAborted(); ticks += milliseconds } }),
    saveReport: async report => { order.push('save'); saved.push(structuredClone(report)) },
    artifactReady: async () => { order.push('ready'); marked++ },
  }
  return { deps, env, reads, saved, order, triggerTimeout: () => timeout!(),
    stats: () => ({ opens, closes, marked, disarmed, readers, closedReaders, browserSignal }) }
}

test('accepts only the two fixed modes and help with no page, path, cadence or secret arguments', () => {
  for (const mode of ['serial', 'compare', 'help']) assert.deepEqual(parseParallelFetchCloudArguments([`--${mode}`]), { mode })
  for (const args of [[], ['--serial', '--compare'], ['--serial', '--serial'], ['--serial', '--page', '500'],
    ['--compare', '--interval', '0'], ['--compare', '--output', SECRET], ['--url', SECRET], ['--help', '--serial']]) {
    assert.throws(() => parseParallelFetchCloudArguments(args), error => error instanceof ParallelFetchCloudError
      && error.code === 'arguments' && !error.message.includes(SECRET))
  }
})

test('requires all exact hosted Windows workflow identity markers before opening a browser or saving', async () => {
  assert.equal(isAllowedParallelFetchCloudExecution(hosted()), true)
  const invalid = { GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Linux',
    GITHUB_REPOSITORY: 'other/sf6', GITHUB_EVENT_NAME: 'push', GITHUB_REF: PARALLEL_FETCH_CLOUD_BRANCH + '-other',
    GITHUB_WORKFLOW_REF: PARALLEL_FETCH_CLOUD_WORKFLOW.replace('rank-distribution-cloud-probe', 'other'),
    GITHUB_RUN_ID: '123\nsecret', GITHUB_RUN_ATTEMPT: '0' }
  for (const [key, value] of Object.entries(invalid)) {
    for (const replacement of [value, undefined]) {
      const f = fixture(); f.env[key] = replacement
      assert.equal(isAllowedParallelFetchCloudExecution(f.env), false)
      await assert.rejects(runParallelFetchCloudTest(['--serial'], f.deps),
        error => error instanceof ParallelFetchCloudError && error.code === 'runner')
      assert.equal(BUCKLER_WEEKLY_SESSION_SECRET in f.env, false)
      assert.equal(f.stats().opens, 0)
      assert.equal(f.saved.length, 0)
      assert.equal(f.stats().marked, 0)
    }
  }
})

test('permanent workflow requires main, its own workflow identity, dispatched SHA and a canonical request UUID', async () => {
  assert.equal(isAllowedParallelFetchCloudExecution(mainHosted()), true)
  const invalid: [string, string | undefined][] = [
    ['GITHUB_REF', PARALLEL_FETCH_CLOUD_BRANCH], ['GITHUB_REF', 'refs/heads/other'],
    ['GITHUB_WORKFLOW_REF', PARALLEL_FETCH_CLOUD_WORKFLOW], ['GITHUB_WORKFLOW_REF', PARALLEL_FETCH_MAIN_WORKFLOW.replace('@refs/heads/main', '@refs/heads/other')],
    ['GITHUB_EVENT_NAME', 'push'], ['GITHUB_EVENT_NAME', 'schedule'], ['RUNNER_ENVIRONMENT', 'self-hosted'],
    ['GITHUB_REPOSITORY', 'other/sf6'], ['RUNNER_OS', 'Linux'],
    ...[undefined, '', 'main', 'a'.repeat(39), `${'a'.repeat(40)}\n`].map(value => ['GITHUB_SHA', value] as [string, string | undefined]),
    ...[undefined, '', '../unsafe', REQUEST_ID.toUpperCase(), `${REQUEST_ID}\n`, REQUEST_ID.replace('-43da-', '-13da-')]
      .map(value => ['PARALLEL_FETCH_REQUEST_ID', value] as [string, string | undefined]),
  ]
  for (const [key, value] of invalid) {
    const f = fixture(mainHosted()); f.env[key] = value
    assert.equal(isAllowedParallelFetchCloudExecution(f.env), false, key)
    await assert.rejects(runParallelFetchCloudTest(['--serial'], f.deps), error => error instanceof ParallelFetchCloudError && error.code === 'runner')
    assert.equal(BUCKLER_WEEKLY_SESSION_SECRET in f.env, false)
    assert.equal(f.stats().opens, 0)
    assert.equal(f.saved.length, 0)
  }
})

test('consumes the Secret and debug configuration even when argument validation fails', async () => {
  const f = fixture()
  Object.assign(f.env, { DEBUG: 'pw:*', PWDEBUG: '1', NODE_DEBUG: 'child_process', NODE_OPTIONS: '--inspect',
    PW_LOG_PATH: SECRET, PLAYWRIGHT_TRACE_DIR: SECRET, BUCKLER_CLOUD_PROBE_SESSION: SECRET, BUCKLER_CLOUD_RANK_CHECKPOINT: SECRET })
  await assert.rejects(runParallelFetchCloudTest(['--url', SECRET], f.deps),
    error => error instanceof ParallelFetchCloudError && !error.message.includes(SECRET))
  for (const key of [BUCKLER_WEEKLY_SESSION_SECRET, 'DEBUG', 'PWDEBUG', 'NODE_DEBUG', 'NODE_OPTIONS', 'PW_LOG_PATH',
    'PLAYWRIGHT_TRACE_DIR', 'BUCKLER_CLOUD_PROBE_SESSION', 'BUCKLER_CLOUD_RANK_CHECKPOINT']) assert.equal(key in f.env, false)
  assert.equal(f.stats().opens, 0)
})

test('serial and comparison modes use the fixed existing engine and save only allowlisted terminal reports before ready', async () => {
  for (const environment of [hosted, mainHosted]) for (const mode of ['serial', 'compare'] as const) {
    const f = fixture(environment())
    const run = f.deps.run!
    f.deps.run = async (config, dependencies) => {
      const report = await run(config, dependencies)
      return { ...report, cookies: SECRET, trials: report.trials.map(trial => ({ ...trial, rawRows: [SECRET] })) }
    }
    const result = await runParallelFetchCloudTest([`--${mode}`], f.deps)
    assert.equal(result.succeeded, true)
    assert.equal(result.artifactReady, true)
    assert.equal(result.outputError, null)
    assert.equal(result.report.runId, `cloud-123456789-2-${mode}`)
    assert.deepEqual(result.report.config, { target: 'lp', startPage: 1, pageCount: 20,
      concurrencies: mode === 'serial' ? [1] : [1, 2], repetitions: mode === 'serial' ? 3 : 1, intervalMs: 5000, intervalScope: 'global' })
    assert.equal(f.reads.length, mode === 'serial' ? 63 : 43)
    assert.equal(f.reads.length, plannedParallelFetchAttempts(result.report.config))
    assert.ok(f.reads.every(read => read.page >= 1 && read.page <= 20))
    assert.equal(f.stats().opens, 1)
    assert.equal(f.stats().closes, 1)
    assert.equal(f.stats().readers, 3)
    assert.equal(f.stats().closedReaders, 3)
    assert.equal(f.stats().disarmed, 1)
    assert.deepEqual(f.order, ['close', 'save', 'ready'])
    assert.deepEqual(f.saved, [parseParallelFetchReport(result.report)])
    assert.equal(JSON.stringify([result, f.saved]).includes(SECRET), false)
  }
})

test('permanent workflow correlates requests, verifies dispatched code and exposes the Secret only to the bounded step', async () => {
  const workflow = await readFile(new URL('../.github/workflows/parallel-fetch-test.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^run-name: Parallel fetch \$\{\{ inputs\.request_id \}\}$/m)
  assert.match(workflow, /options: \['serial', 'compare', 'interval-compare'\]/)
  assert.match(workflow, /concurrencies:\s+description: [^\n]+\s+required: true\s+type: string\s+default: '1,2'/)
  assert.match(workflow, /parseParallelFetchCloudArguments\(e\.PARALLEL_TEST_MODE/)
  assert.match(workflow, /PARALLEL_TEST_CONCURRENCIES: \$\{\{ inputs\.concurrencies \}\}/)
  assert.match(workflow, /interval_seconds:\s+description: [^\n]+\s+required: true\s+type: string\s+default: '5,3'/)
  assert.match(workflow, /PARALLEL_TEST_INTERVAL_SECONDS: \$\{\{ inputs\.interval_seconds \}\}/)
  assert.match(workflow, /PARALLEL_TEST_INTERVAL_SCOPE: \$\{\{ inputs\.interval_scope \}\}/)
  assert.match(workflow, /--interval-seconds=/)
  assert.match(workflow, /--interval-scope=/)
  assert.doesNotMatch(workflow, /PARALLEL_TEST_CONCURRENCIES -cnotin/)
  assert.doesNotMatch(workflow, /^\s+(?:push|schedule|pull_request|workflow_call):/m)
  assert.match(workflow, /github\.repository == 'gonchiman\/sf6'.*github\.event_name == 'workflow_dispatch'.*github\.ref == 'refs\/heads\/main'/)
  assert.match(workflow, /group: rank-distribution-weekly-gonchiman-sf6/)
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(workflow, /\$checkedOutRevision -cne \$env:GITHUB_SHA/)
  assert.match(workflow, /PARALLEL_FETCH_REQUEST_ID\.Length -ne 36/)
  assert.equal((workflow.match(/\$\{\{ secrets\./g) ?? []).length, 1)
  assert.match(workflow, /name: Run bounded collection test\s+id: collect\s+shell: pwsh\s+env:\s+BUCKLER_WEEKLY_SESSION: \$\{\{ secrets\.BUCKLER_WEEKLY_SESSION \}\}/)
  assert.ok(workflow.indexOf('name: Validate fixed test inputs') < workflow.indexOf('secrets.BUCKLER_WEEKLY_SESSION'))
  assert.ok(workflow.indexOf('name: Validate combined test budget without session') < workflow.indexOf('secrets.BUCKLER_WEEKLY_SESSION'))
  for (const action of workflow.matchAll(/uses: (actions\/[a-z-]+)@([^\s]+)/g)) assert.match(action[2], /^[0-9a-f]{40}$/)
  assert.match(workflow, /if: always\(\) && steps\.collect\.outputs\.artifact_ready == 'true'/)
  assert.match(workflow, /path: \.local\/parallel-fetch\/parallel-fetch-cloud-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ env\.PARALLEL_TEST_MODE \}\}\.json/)
  assert.match(workflow, /retention-days: 7/)
  for (const script of workflow.split(/\n\s+run: /).slice(1)) {
    const lines = script.split(/\n\s+- name: /, 1)[0]
    assert.doesNotMatch(lines, /\$\{\{ inputs\./)
  }
})

test('missing, invalid and oversized Secrets save a zero-read safe failure with no browser launch', async () => {
  for (const value of [undefined, '', SECRET, '{}', 'x'.repeat(48 * 1024), envelope().replace('.streetfighter.com', '.capcom.com'),
    envelope().replace('2026-10-20T00:01:00.000Z', '2026-10-22T00:01:00.000Z')]) {
    const f = fixture(); f.env[BUCKLER_WEEKLY_SESSION_SECRET] = value
    const result = await runParallelFetchCloudTest(['--serial'], f.deps)
    assert.equal(result.succeeded, false)
    assert.equal(result.report.errorCode, 'session-unavailable')
    assert.equal(result.report.trials.length, 0)
    assert.equal(result.artifactReady, true)
    assert.equal(f.stats().opens, 0)
    assert.equal(f.stats().disarmed, 0)
    assert.deepEqual(f.order, ['save', 'ready'])
    assert.equal(JSON.stringify([result, f.saved]).includes(SECRET), false)
  }
})

test('challenge stops the shared engine without a later trial or authentication retry and retains safe evidence', async () => {
  const f = fixture(), openBrowser = f.deps.openBrowser!
  f.deps.openBrowser = async (...args) => {
    const session = await openBrowser(...args)
    return { ...session, createReader: async (...readerArgs) => {
      const reader = await session.createReader(...readerArgs)
      return { ...reader, readPage: async (page, navigationGate) => {
        if (page === 3) return navigationGate(async () => {
          throw new ParallelFetchReadError('human-verification', 405,
            { authenticationEvidence: 'no-control', loginRequiredHeading: false, rankingReadable: false })
        })
        return reader.readPage(page, navigationGate)
      } }
    } }
  }
  const result = await runParallelFetchCloudTest(['--serial'], f.deps)
  assert.equal(result.report.errorCode, 'human-verification')
  assert.equal(result.report.trials.length, 1)
  assert.deepEqual(result.report.trials[0].completedPages, [1, 2])
  assert.deepEqual(result.report.trials[0].attempts.map(attempt => attempt.page), [1, 1, 2, 3])
  assert.deepEqual(result.report.trials[0].attempts.at(-1)!.diagnostics,
    { authenticationEvidence: 'no-control', loginRequiredHeading: false, rankingReadable: false })
  assert.equal(result.artifactReady, true)
  assert.equal(result.succeeded, false)
  assert.equal(f.stats().closes, 1)
})

test('deadline aborts collection, closes owned resources and saves timeout without raw error text', async () => {
  const f = fixture()
  f.deps.run = async (_config, dependencies) => {
    f.triggerTimeout()
    assert.equal(dependencies.signal!.aborted, true)
    throw new Error(SECRET)
  }
  const result = await runParallelFetchCloudTest(['--serial'], f.deps)
  assert.equal(result.report.errorCode, 'timeout')
  assert.equal(result.report.state, 'error')
  assert.equal(result.artifactReady, true)
  assert.equal(f.stats().browserSignal!.aborted, true)
  assert.equal(f.stats().closes, 1)
  assert.equal(f.stats().disarmed, 1)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})

test('external cancellation prevents launch and unknown browser exceptions become fixed safe reports', async () => {
  const cancelled = fixture(); cancelled.deps.signal = AbortSignal.abort()
  const stopped = await runParallelFetchCloudTest(['--serial'], cancelled.deps)
  assert.equal(stopped.report.errorCode, 'cancelled')
  assert.equal(stopped.report.state, 'stopped')
  assert.equal(cancelled.stats().opens, 0)
  const failed = fixture(); failed.deps.openBrowser = async () => { throw new Error(SECRET) }
  const result = await runParallelFetchCloudTest(['--serial'], failed.deps)
  assert.equal(result.report.errorCode, 'read-failed')
  assert.equal(result.artifactReady, true)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})

test('failed report saves never signal artifact readiness and failed output signaling remains a fixed failure', async () => {
  for (const markerFailure of [false, true]) {
    const f = fixture()
    if (markerFailure) f.deps.artifactReady = async () => { throw new Error(SECRET) }
    else f.deps.saveReport = async () => { throw new Error(SECRET) }
    const result = await runParallelFetchCloudTest(['--compare'], f.deps)
    assert.equal(result.succeeded, false)
    assert.equal(result.artifactReady, false)
    assert.equal(result.outputError, 'report-save-failed')
    assert.equal(f.stats().marked, 0)
    assert.equal(f.saved.length, markerFailure ? 1 : 0)
    assert.equal(f.stats().closes, 1)
    assert.equal(JSON.stringify(result).includes(SECRET), false)
  }
})

test('CLI help and disallowed invocations print neither secrets nor stack traces and do not launch', () => {
  const script = fileURLToPath(new URL('./test-parallel-fetch-cloud.ts', import.meta.url))
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, [BUCKLER_WEEKLY_SESSION_SECRET]: SECRET }
  const help = spawnSync(process.execPath, [script, '--help'], { env, encoding: 'utf8', timeout: 10000 })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--serial/)
  assert.match(help.stdout, /--compare/)
  assert.equal(help.stdout.includes(SECRET), false)
  for (const args of [['--url', SECRET], ['--serial']]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1)
    assert.equal((result.stdout + result.stderr).includes(SECRET), false)
    assert.doesNotMatch(result.stderr, /\bat .*\(.+:\d+/)
  }
})

const intervalArgs = ['--interval-compare', '--intervals=5000,3000', '--concurrencies=1,2', '--repetitions=1']
test('interval CLI accepts bounded integer lists and rejects over-budget matrices', () => {
  assert.deepEqual(parseParallelFetchCloudArguments(intervalArgs), { mode: 'interval-compare',
    options: { intervalMsList: [5000, 3000], concurrencies: [1, 2], repetitions: 1, intervalScope: 'global' } })
  assert.deepEqual(parseParallelFetchCloudArguments(intervalArgs.map(arg => arg.replace('--concurrencies=1,2', '--concurrencies= 8, 1 ,3 '))),
    { mode: 'interval-compare', options: { intervalMsList: [5000, 3000], concurrencies: [1, 3, 8], repetitions: 1, intervalScope: 'global' } })
  assert.deepEqual(parseParallelFetchCloudArguments(['--interval-compare', '--intervals=3000', '--concurrencies=8,7,6,5,4,3,2,1', '--repetitions=1']),
    { mode: 'interval-compare', options: { intervalMsList: [3000], concurrencies: [1, 2, 3, 4, 5, 6, 7, 8], repetitions: 1, intervalScope: 'global' } })
  for (const args of [['--interval-compare'], [...intervalArgs, '--url=other'],
    intervalArgs.map(arg => arg.replace('5000,3000', '5000,5000')),
    intervalArgs.map(arg => arg.replace('5000,3000', '50')),
    intervalArgs.map(arg => arg.replace('--concurrencies=1,2', '--concurrencies=4')),
    intervalArgs.map(arg => arg.replace('--concurrencies=1,2', '--concurrencies=2')),
    intervalArgs.map(arg => arg.replace('--repetitions=1', '--repetitions=3')),
    ['--interval-compare', '--intervals=3000', '--concurrencies=1,2,3,4,5,6,7,8', '--repetitions=3'],
    ['--interval-compare', '--intervals=5000', '--concurrencies=1,2,3,4,5,6,7,8', '--repetitions=1'],
    ['--interval-compare', '--intervals=10000', '--concurrencies=1', '--repetitions=3']]) {
    assert.throws(() => parseParallelFetchCloudArguments(args), error => error instanceof ParallelFetchCloudError && error.code === 'arguments')
  }
})

test('concurrency argument rejects malformed and injection-like input with a fixed error', () => {
  for (const value of ['', '1,', ',1', '1,,2', '1,2,2', '1,0', '1,9', '1,-2', '1,2.5', '1,2e0', '1,0x2',
    '1,+2', '1 2', '--help', '1,2;Write-Output injected', '1,$(Write-Output injected)', '1,`whoami`',
    '1,2\n--url=private-input']) {
    const args = intervalArgs.map(arg => arg.startsWith('--concurrencies=') ? `--concurrencies=${value}` : arg)
    assert.throws(() => parseParallelFetchCloudArguments(args), error => error instanceof ParallelFetchCloudError
      && error.code === 'arguments' && error.message === new ParallelFetchCloudError('arguments').message)
  }
})

test('one cloud browser runs all interval conditions with the selected cadence and a versioned artifact', async () => {
  const f = fixture(mainHosted()), open = f.deps.openBrowser!, intervals: (number | undefined)[] = []
  f.deps.openBrowser = async (...args) => {
    const session = await open(...args)
    return { ...session, createReader: async (worker, target, signal, intervalMs) => {
      intervals.push(intervalMs)
      return session.createReader(worker, target, signal, intervalMs)
    } }
  }
  const result = await runParallelFetchCloudTest(intervalArgs, f.deps)
  assert.equal(result.succeeded, true)
  assert.equal(result.report.schemaVersion, 3)
  assert.equal(result.report.runId, 'cloud-123456789-2-interval-compare')
  assert.deepEqual(result.report.config.intervalMsList, [5000, 3000])
  assert.deepEqual(result.report.trials.map(trial => [trial.intervalMs, trial.concurrency]), [[5000, 1], [5000, 2], [3000, 1], [3000, 2]])
  assert.deepEqual(intervals, [5000, 5000, 5000, 3000, 3000, 3000])
  assert.equal(f.reads.length, 86)
  assert.equal(f.stats().opens, 1)
  assert.equal(f.stats().closes, 1)
  assert.deepEqual(f.order, ['close', 'save', 'ready'])
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})

test('cloud collection forwards and records new concurrency values across the same bounded runner', async () => {
  const f = fixture(mainHosted())
  const result = await runParallelFetchCloudTest(intervalArgs.map(arg => arg.replace('--concurrencies=1,2', '--concurrencies=8,1,3')), f.deps)
  assert.equal(result.succeeded, true)
  assert.deepEqual(result.report.config.concurrencies, [1, 3, 8])
  assert.deepEqual(result.report.trials.map(trial => [trial.intervalMs, trial.concurrency]),
    [[5000, 1], [5000, 3], [5000, 8], [3000, 1], [3000, 3], [3000, 8]])
  assert.equal(f.reads.length, 144)
  assert.equal(f.stats().readers, 24)
  assert.equal(f.stats().closedReaders, 24)
  assert.equal(f.stats().opens, 1)
  assert.equal(f.stats().closes, 1)
  assert.deepEqual(f.saved, [result.report])
})

test('interval mode fails safely before launch for invalid limits, branch or session', async () => {
  const branch = fixture()
  await assert.rejects(runParallelFetchCloudTest(intervalArgs, branch.deps), error => error instanceof ParallelFetchCloudError && error.code === 'runner')
  assert.equal(branch.stats().opens, 0)
  const overBudget = fixture(mainHosted())
  await assert.rejects(runParallelFetchCloudTest(intervalArgs.map(arg => arg.replace('--repetitions=1', '--repetitions=3')), overBudget.deps))
  assert.equal(overBudget.stats().opens, 0)
  const missing = fixture(mainHosted()); delete missing.env[BUCKLER_WEEKLY_SESSION_SECRET]
  const result = await runParallelFetchCloudTest(intervalArgs, missing.deps)
  assert.equal(result.report.errorCode, 'session-unavailable')
  assert.equal(result.report.schemaVersion, 3)
  assert.equal(result.report.trials.length, 0)
  assert.equal(result.artifactReady, true)
  assert.equal(missing.stats().opens, 0)
})

test('seconds CLI normalizes zero, decimal and whitespace values with an explicit scope', () => {
  const args = ['--interval-compare', '--interval-seconds= 0, 5.1 ,0.1 ', '--concurrencies=1,2', '--repetitions=1', '--interval-scope=per-tab']
  assert.deepEqual(parseParallelFetchCloudArguments(args), { mode: 'interval-compare', options: {
    intervalMsList: [5100, 100, 0], concurrencies: [1, 2], repetitions: 1, intervalScope: 'per-tab',
  } })
  assert.equal(parseParallelFetchCloudArguments(args.slice(0, 4)).options?.intervalScope, 'global')
  for (const value of ['', '1,', ',1', '1,,2', '-1', '60.1', '0.01', '5,5.0', '1,2,3,4',
    '1e0', '0x5', '1;Write-Output injected', '1,$(Write-Output injected)', '1,`whoami`']) {
    assert.throws(() => parseParallelFetchCloudArguments(args.map(arg => arg.startsWith('--interval-seconds=') ? `--interval-seconds=${value}` : arg)),
      error => error instanceof ParallelFetchCloudError && error.code === 'arguments')
  }
  for (const scope of ['worker', 'per-tab;injected', '', 'GLOBAL']) {
    assert.throws(() => parseParallelFetchCloudArguments([...args.slice(0, 4), `--interval-scope=${scope}`]))
  }
})

test('cloud decimal and zero intervals preserve per-tab semantics in version 3 artifacts', async () => {
  const f = fixture(mainHosted())
  const result = await runParallelFetchCloudTest(['--interval-compare', '--interval-seconds=0,5.1', '--concurrencies=1,2', '--repetitions=1', '--interval-scope=per-tab'], f.deps)
  assert.equal(result.succeeded, true)
  assert.equal(result.report.schemaVersion, 3)
  assert.equal(result.report.config.intervalScope, 'per-tab')
  assert.deepEqual(result.report.config.intervalMsList, [5100, 0])
  assert.deepEqual(result.report.trials.map(trial => [trial.intervalMs, trial.concurrency]), [[5100, 1], [5100, 2], [0, 1], [0, 2]])
  assert.equal(f.reads.length, 86)
  assert.deepEqual(f.saved, [result.report])
  assert.equal(f.stats().opens, 1)
  assert.equal(f.stats().closes, 1)
})
