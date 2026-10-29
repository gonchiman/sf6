import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BucklerAuthProbeReadError } from './lib/buckler-auth-probe.ts'
import { BUCKLER_CLOUD_SESSION_ENV, BUCKLER_CLOUD_SESSION_SIZE_LIMIT, BucklerCloudProbeError,
  isHostedGitHubExecution, observeCloudProbeBlocker, parseCloudProbeArguments, runBucklerCloudProbe,
  sanitizeCloudProbeDiagnostics } from './probe-buckler-cloud.ts'
import type { BucklerCloudProbeDependencies, BucklerCloudProbeLaunchOptions } from './probe-buckler-cloud.ts'

const SECRET = 'synthetic-cookie-private-value'
const validState = () => JSON.stringify({ cookies: [{ name: 'session', value: SECRET, domain: '.streetfighter.com',
  path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] })
const hosted = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' })
const readable = (signedIn: boolean | null = false) => ({ maintenance: false, loginRequired: false,
  signedIn, rankingRows: 20, visibleCounters: { from: 1, to: 20, total: 3_000_000 }, controlMatches: true, pageConfirmed: true })

function fixture(observation: unknown = readable(), additional: Partial<BucklerCloudProbeDependencies> = {}) {
  let launches = 0
  let reads = 0
  let closes = 0
  let launched: BucklerCloudProbeLaunchOptions | undefined
  const dependencies: BucklerCloudProbeDependencies = {
    env: hosted(), now: () => new Date('2026-10-15T06:00:00.000Z'),
    launch: async options => {
      launches++
      launched = options
      return { read: async () => { reads++; return observation }, close: async () => { closes++ } }
    }, ...additional,
  }
  return { dependencies, stats: () => ({ launches, reads, closes, launched }) }
}

test('requires one explicit mode and accepts only a single optional headless comparison flag', () => {
  assert.deepEqual(parseCloudProbeArguments(['--anonymous']), { mode: 'anonymous', headless: false })
  assert.deepEqual(parseCloudProbeArguments(['--headless', '--saved-session']), { mode: 'saved-session', headless: true })
  for (const args of [[], ['--anonymous', '--saved-session'], ['--anonymous', '--anonymous'], ['--headless'],
    ['--anonymous', '--headless', '--headless'], ['--anonymous', '--url', SECRET], ['--saved-session', '--path', SECRET],
    ['--anonymous', '--repository', SECRET], ['--anonymous', '--browser', 'chrome']]) {
    assert.throws(() => parseCloudProbeArguments(args), error => error instanceof BucklerCloudProbeError && !error.message.includes(SECRET))
  }
})

test('consumes credentials and debug configuration before launch without forwarding them to children', async () => {
  const env = { ...hosted(), [BUCKLER_CLOUD_SESSION_ENV]: validState(), DEBUG: 'pw:*', PWDEBUG: '1',
    NODE_DEBUG: 'child_process', NODE_OPTIONS: '--inspect', PW_LOG_PATH: SECRET, PLAYWRIGHT_TRACE_DIR: SECRET,
    PATH: 'synthetic-path' }
  const setup = fixture(readable(true), { env })
  const result = await runBucklerCloudProbe(['--saved-session'], setup.dependencies)
  assert.equal(result.succeeded, true)
  const { launched } = setup.stats()
  assert.ok(launched)
  assert.equal(launched.storageState?.cookies[0].value, SECRET)
  assert.equal(launched.headless, false)
  assert.equal(launched.expectSignedIn, true)
  for (const key of [BUCKLER_CLOUD_SESSION_ENV, 'DEBUG', 'PWDEBUG', 'NODE_DEBUG', 'NODE_OPTIONS', 'PW_LOG_PATH', 'PLAYWRIGHT_TRACE_DIR']) {
    assert.equal(key in env, false)
    assert.equal(key in launched.env, false)
  }
  assert.equal(launched.env.PATH, 'synthetic-path')
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('credentials are consumed even for invalid arguments and never echoed in errors', async () => {
  const env = { [BUCKLER_CLOUD_SESSION_ENV]: validState() }
  const setup = fixture(readable(), { env })
  await assert.rejects(runBucklerCloudProbe(['--url', SECRET], setup.dependencies),
    error => error instanceof BucklerCloudProbeError && error.code === 'arguments' && !error.message.includes(SECRET))
  assert.equal(BUCKLER_CLOUD_SESSION_ENV in env, false)
  assert.equal(setup.stats().launches, 0)
})

test('invalid state, identity-provider state and deceptive domains fail before any launch', async () => {
  for (const state of [SECRET, '{}', validState().replace('.streetfighter.com', '.capcom.com'),
    validState().replace('.streetfighter.com', '.streetfighter.com.example.com'),
    JSON.stringify({ cookies: [], origins: [{ origin: 'https://cid.capcom.com', localStorage: [{ name: 'token', value: SECRET }] }] }),
    JSON.stringify({ cookies: [], origins: [], password: SECRET })]) {
    const env = { ...hosted(), [BUCKLER_CLOUD_SESSION_ENV]: state }
    const setup = fixture(readable(true), { env })
    await assert.rejects(runBucklerCloudProbe(['--saved-session'], setup.dependencies),
      error => error instanceof BucklerCloudProbeError && error.code === 'session-invalid' && !error.message.includes(SECRET))
    assert.equal(BUCKLER_CLOUD_SESSION_ENV in env, false)
    assert.equal(setup.stats().launches, 0)
  }
})

test('missing state and state at the 48KiB limit are rejected without launching', async () => {
  for (const [state, expected] of [[undefined, 'session-missing'], ['', 'session-missing'],
    ['x'.repeat(BUCKLER_CLOUD_SESSION_SIZE_LIMIT), 'session-too-large'],
    ['あ'.repeat(BUCKLER_CLOUD_SESSION_SIZE_LIMIT / 3), 'session-too-large']] as const) {
    const env = { ...hosted(), [BUCKLER_CLOUD_SESSION_ENV]: state }
    const setup = fixture(readable(), { env })
    await assert.rejects(runBucklerCloudProbe(['--saved-session'], setup.dependencies),
      error => error instanceof BucklerCloudProbeError && error.code === expected)
    assert.equal(BUCKLER_CLOUD_SESSION_ENV in env, false)
    assert.equal(setup.stats().launches, 0)
  }
})

test('anonymous readability never confirms cloud authentication, even if the DOM claims signed in', async () => {
  for (const signedIn of [false, null, true]) {
    const setup = fixture({ ...readable(signedIn), cookie: SECRET, playerName: SECRET },
      { env: { ...hosted(), [BUCKLER_CLOUD_SESSION_ENV]: SECRET } })
    const result = await runBucklerCloudProbe(['--anonymous', '--headless'], setup.dependencies)
    assert.equal(result.succeeded, true)
    assert.equal(result.report.cloudAuthentication, 'not-tested')
    assert.equal(result.report.browserMode, 'headless')
    assert.equal(setup.stats().launched?.storageState, undefined)
    assert.equal(setup.stats().launched?.expectSignedIn, false)
    assert.deepEqual({ launches: setup.stats().launches, reads: setup.stats().reads, closes: setup.stats().closes },
      { launches: 1, reads: 1, closes: 1 })
    assert.ok(!JSON.stringify(result.report).includes(SECRET))
  }
})

test('cloud evidence requires both exact hosted-runner markers, independently of page-supplied fields', async () => {
  for (const env of [{}, { GITHUB_ACTIONS: 'true' }, { RUNNER_ENVIRONMENT: 'github-hosted' },
    { GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'github-hosted' },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_ACTIONS: 'TRUE', RUNNER_ENVIRONMENT: 'github-hosted' }]) {
    assert.equal(isHostedGitHubExecution(env), false)
    const setup = fixture({ ...readable(true), cloudExecution: true, cloudAuthentication: 'confirmed' },
      { env: { ...env, [BUCKLER_CLOUD_SESSION_ENV]: validState() } })
    const result = await runBucklerCloudProbe(['--saved-session'], setup.dependencies)
    assert.equal(result.succeeded, false)
    assert.equal(result.report.cloudExecution, false)
    assert.equal(result.report.cloudAuthentication, 'not-confirmed')
  }
  assert.equal(isHostedGitHubExecution(hosted()), true)
})

test('only signed-in readability in saved-session mode confirms cloud authentication', async () => {
  for (const signedIn of [false, null, true]) {
    const setup = fixture(readable(signedIn), { env: { ...hosted(), [BUCKLER_CLOUD_SESSION_ENV]: validState() } })
    const result = await runBucklerCloudProbe(['--saved-session'], setup.dependencies)
    assert.equal(result.succeeded, signedIn === true)
    assert.equal(result.report.cloudAuthentication, signedIn === true ? 'confirmed' : 'not-confirmed')
    assert.equal(result.report.manualLoginPerformed, false)
    assert.equal(result.report.wholeDistribution, 'not-tested')
    assert.equal(result.report.sessionLifetime, 'not-tested')
    assert.equal(result.report.weeklyExecution, 'not-tested')
  }
})

test('maintenance and condition mismatch cannot be reported as successful authentication', async () => {
  for (const observation of [{ ...readable(true), maintenance: true }, { ...readable(true), pageConfirmed: false },
    { ...readable(true), loginRequired: true }, { ...readable(true), controlMatches: false }]) {
    const setup = fixture(observation, { env: { ...hosted(), [BUCKLER_CLOUD_SESSION_ENV]: validState() } })
    const result = await runBucklerCloudProbe(['--saved-session'], setup.dependencies)
    assert.equal(result.succeeded, false)
    assert.equal(result.report.cloudAuthentication, 'not-confirmed')
    assert.equal(setup.stats().reads, 1)
  }
})

test('read timeouts and raw browser errors remain fixed statuses, close once and never trigger a retry', async () => {
  for (const error of [new BucklerAuthProbeReadError('timeout'), new Error(`https://auth.example/?token=${SECRET}`)]) {
    let reads = 0
    let closes = 0
    const setup = fixture(undefined, { launch: async () => ({ read: async () => { reads++; throw error },
      close: async () => { closes++; throw new Error(SECRET) } }) })
    const result = await runBucklerCloudProbe(['--anonymous'], setup.dependencies)
    assert.equal(result.succeeded, false)
    assert.equal(result.report.observation.status, error instanceof BucklerAuthProbeReadError ? 'timeout' : 'read-failed')
    assert.equal(result.report.failureStage, 'page-read')
    assert.equal(reads, 1)
    assert.equal(closes, 1)
    assert.ok(!JSON.stringify(result).includes(SECRET))
  }
})

test('browser launch errors cannot escape into reports or cause an automatic retry', async () => {
  let launches = 0
  const setup = fixture(undefined, { launch: async () => { launches++; throw new Error(SECRET) } })
  const result = await runBucklerCloudProbe(['--anonymous'], setup.dependencies)
  assert.equal(launches, 1)
  assert.equal(result.report.observation.status, 'read-failed')
  assert.equal(result.report.failureStage, 'browser-launch')
  assert.equal(result.succeeded, false)
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('diagnostics retain only bounded status codes and known blockers without raw response information', async () => {
  assert.deepEqual(sanitizeCloudProbeDiagnostics({ documentHttpStatus: 403, accessBlocker: 'cloudfront-blocked', body: SECRET, url: SECRET }),
    { documentHttpStatus: 403, accessBlocker: 'cloudfront-blocked' })
  for (const status of [99, 600, 403.5, '403', NaN, Infinity, null]) {
    assert.deepEqual(sanitizeCloudProbeDiagnostics({ documentHttpStatus: status, accessBlocker: SECRET }),
      { documentHttpStatus: null, accessBlocker: 'unknown' })
  }
  const setup = fixture(undefined, { launch: async () => ({ read: async () => { throw new Error(SECRET) },
    diagnostics: async () => ({ documentHttpStatus: 403, accessBlocker: 'cloudflare-challenge', body: SECRET }),
    close: async () => {} }) })
  const result = await runBucklerCloudProbe(['--anonymous'], setup.dependencies)
  assert.equal(result.report.documentHttpStatus, 403)
  assert.equal(result.report.accessBlocker, 'cloudflare-challenge')
  assert.equal(result.report.observation.status, 'read-failed')
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('blocker diagnosis inspects visible headings only and returns no page text', t => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let headings: { innerText: string; hidden?: boolean; parentElement: null;
    getBoundingClientRect(): { width: number; height: number }; hasAttribute(name: string): boolean }[] = []
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    querySelectorAll: (selector: string) => { assert.equal(selector, 'h1,h2,h3'); return headings },
    get body() { throw new Error('Body text must not be inspected') },
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  } })
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const heading = (innerText: string, hidden = false) => ({ innerText, hidden, parentElement: null,
    getBoundingClientRect: () => ({ width: 100, height: 20 }), hasAttribute: (name: string) => name === 'hidden' && hidden })
  headings = [heading('The request could not be satisfied. ' + SECRET)]
  assert.equal(observeCloudProbeBlocker(), 'cloudfront-blocked')
  headings = [heading('セキュリティ検証の実行 ' + SECRET)]
  assert.equal(observeCloudProbeBlocker(), 'cloudflare-challenge')
  headings = [heading('ランキング'), heading('Cloudflare ' + SECRET, true)]
  assert.equal(observeCloudProbeBlocker(), 'none')
  headings = []
  assert.equal(observeCloudProbeBlocker(), 'unknown')
})

test('CLI help and rejected input never launch a browser or print secret input', () => {
  const script = fileURLToPath(new URL('./probe-buckler-cloud.ts', import.meta.url))
  const env = { ...process.env, [BUCKLER_CLOUD_SESSION_ENV]: SECRET }
  const help = spawnSync(process.execPath, [script, '--help'], { env, encoding: 'utf8', timeout: 10_000 })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--saved-session/)
  assert.ok(!help.stdout.includes(SECRET))
  for (const args of [['--url', SECRET], ['--saved-session']]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 1)
    assert.ok(!result.stdout.includes(SECRET))
    assert.ok(!result.stderr.includes(SECRET))
    assert.doesNotMatch(result.stderr, /\bat .*\(.+:\d+/)
  }
})
