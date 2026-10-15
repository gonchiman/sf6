import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { bucklerOnlyStorageState, isSeparateLaunch, parseCaptureRecord, parseSessionProbeArguments, selectManualBucklerPage } from './probe-buckler-session.ts'
import type { BrowserContext } from 'playwright'

const script = fileURLToPath(new URL('./probe-buckler-session.ts', import.meta.url))

test('requires an explicit capture or reuse mode and refuses arbitrary state paths and duplicate flags', () => {
  assert.deepEqual(parseSessionProbeArguments(['--capture']), { mode: 'capture', browser: 'msedge', manualBrowser: false, loginBrowser: false })
  assert.deepEqual(parseSessionProbeArguments(['--reuse', '--browser', 'chrome']), { mode: 'reuse', browser: 'chrome', manualBrowser: false, loginBrowser: false })
  for (const args of [[], ['--capture', '--reuse'], ['--capture', '--capture'], ['--reuse', '--path', 'secret'], ['--reuse', '--browser', 'unknown']]) {
    assert.throws(() => parseSessionProbeArguments(args))
  }
})

test('manual attachment requires explicit capture and the fixed dedicated Edge, excluding arbitrary endpoints', () => {
  assert.deepEqual(parseSessionProbeArguments(['--capture', '--manual-browser']), { mode: 'capture', browser: 'msedge', manualBrowser: true, loginBrowser: false })
  assert.equal(parseSessionProbeArguments(['--open-manual-browser']).mode, 'open-manual-browser')
  assert.equal(parseSessionProbeArguments(['--close-manual-browser']).mode, 'close-manual-browser')
  for (const args of [['--reuse', '--manual-browser'], ['--capture', '--manual-browser', '--browser', 'chrome'],
    ['--capture', '--manual-browser', '--manual-browser'], ['--open-manual-browser', '--browser', 'msedge'],
    ['--open-manual-browser', '--manual-browser'], ['--close-manual-browser', '--capture'],
    ['--capture', '--manual-browser', '--endpoint', 'http://127.0.0.1:9222']]) {
    assert.throws(() => parseSessionProbeArguments(args))
  }
})

test('login-only preparation and restart capture are explicit and cannot be mixed with direct attachment or another browser', () => {
  assert.equal(parseSessionProbeArguments(['--open-login-browser']).mode, 'open-login-browser')
  assert.equal(parseSessionProbeArguments(['--close-login-browser']).mode, 'close-login-browser')
  assert.deepEqual(parseSessionProbeArguments(['--capture', '--login-browser']),
    { mode: 'capture', browser: 'msedge', manualBrowser: false, loginBrowser: true })
  for (const args of [['--capture', '--login-browser', '--manual-browser'], ['--reuse', '--login-browser'],
    ['--open-login-browser', '--browser', 'chrome'], ['--open-login-browser', '--login-browser'],
    ['--capture', '--login-browser', '--login-browser'], ['--close-login-browser', '--browser', 'msedge']]) {
    assert.throws(() => parseSessionProbeArguments(args))
  }
})

test('manual attachment selects only one existing Buckler ranking page and never an identity-provider page', () => {
  const context = (urls: string[]) => ({ pages: () => urls.map(url => ({ url: () => url })) }) as unknown as BrowserContext
  const ranking = 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league'
  assert.equal(selectManualBucklerPage(context(['https://cid.capcom.com/ja/', ranking])).url(), ranking)
  for (const urls of [[], ['https://auth.cid.capcom.com/authorize?private-token'], [ranking, ranking + '?page=1'],
    ['https://www.streetfighter.com.example.com/6/buckler/ja-jp/ranking/league'],
    ['https://private-token@www.streetfighter.com/6/buckler/ja-jp/ranking/league']]) {
    assert.throws(() => selectManualBucklerPage(context(urls)), error => error instanceof Error && !error.message.includes('private-token'))
  }
})

test('saves only Street Fighter site state, excluding identity-provider and unrelated cookies and storage', async () => {
  const context = { storageState: async () => ({
    cookies: [{ domain: '.streetfighter.com', name: 'session', value: 'test-cookie' },
      { domain: '.capcom.com', name: 'identity', value: 'private-provider-token' },
      { domain: 'streetfighter.com.example.com', name: 'other', value: 'private-unrelated-token' }],
    origins: [{ origin: 'https://www.streetfighter.com', localStorage: [] },
      { origin: 'https://cid.capcom.com', localStorage: [{ name: 'private', value: 'private-provider-token' }] }],
  }) } as unknown as BrowserContext
  const state = JSON.parse(await bucklerOnlyStorageState(context))
  assert.equal(state.cookies.length, 1)
  assert.equal(state.origins.length, 1)
  assert.ok(!JSON.stringify(state).includes('private-provider-token'))
  assert.ok(!JSON.stringify(state).includes('private-unrelated-token'))
})

test('help and invalid noninteractive input do not launch a browser or echo sensitive arguments', () => {
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /暗号化/)
  assert.match(help.stdout, /SAVE/)
  assert.match(help.stdout, /OPEN/)
  assert.match(help.stdout, /manual-browser-profile/)
  const failure = spawnSync(process.execPath, [script, '--capture', '--path', 'private-token'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(failure.status, 1)
  assert.ok(!failure.stderr.includes('private-token'))
  const capture = spawnSync(process.execPath, [script, '--capture'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(capture.status, 1)
  assert.match(capture.stderr, /対話ターミナル/)
  for (const args of [['--capture', '--manual-browser'], ['--open-manual-browser'], ['--open-login-browser'], ['--capture', '--login-browser']]) {
    const manual = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(manual.status, 1)
    assert.match(manual.stderr, /対話ターミナル/)
  }
})

test('capture records normalize only canonical dates and reject mismatched or unknown identity fields', () => {
  const record = { schemaVersion: 1, capturedAt: '2026-10-14T03:00:00.000Z', processId: 1234,
    launchId: '01234567-89ab-4def-8123-456789abcdef', stateIdentity: 'a'.repeat(64) }
  assert.deepEqual(parseCaptureRecord(record), record)
  for (const change of [{ capturedAt: '2026-02-30T03:00:00.000Z' }, { capturedAt: 'Oct 14 2026' },
    { stateIdentity: 'private-token' }, { launchId: '-'.repeat(36) }, { secret: 'private-token' }]) {
    assert.throws(() => parseCaptureRecord({ ...record, ...change }), error => error instanceof Error && !error.message.includes('private-token'))
  }
  assert.equal(isSeparateLaunch(record as ReturnType<typeof parseCaptureRecord>, record.launchId), false)
  // A new launch remains distinct even if Windows recycles the same PID.
  assert.equal(isSeparateLaunch(record as ReturnType<typeof parseCaptureRecord>, '01234567-89ab-4def-8123-456789abcdee'), true)
})
