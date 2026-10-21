import assert from 'node:assert/strict'
import test from 'node:test'
import type { Browser, Page } from 'playwright'
import { createParallelFetchBrowserSession, observeParallelFetchChallenge } from './parallel-fetch-browser.ts'
import { ParallelFetchReadError } from './parallel-fetch-runner.ts'
import { RankDistributionDomError } from './rank-distribution-dom.ts'
import type { ParallelFetchBrowserDependencies } from './parallel-fetch-browser.ts'

function state() { return { cookies: [{ name: 'synthetic', value: 'private-cookie', domain: 'www.streetfighter.com', path: '/', expires: -1,
  httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] } }
function fixture() {
  let loaded = 0, launched = 0, browserClosed = 0, contextClosed = 0, challenge = false, status = 200, diagnosticStatus = 200
  let gotoError: Error | null = null
  let readDiagnostics: Record<string, unknown> | null = null, readError: Error | null = null
  const pageCloses: number[] = [], captured: unknown[] = [], readTargets: string[] = []
  const pages: Page[] = []
  const browser = { close: async () => { browserClosed++ }, newContext: async (options: unknown) => {
    captured.push(options)
    return { close: async () => { contextClosed++ }, newPage: async () => {
      const id = pages.length
      const page = { close: async () => { pageCloses[id] = (pageCloses[id] ?? 0) + 1 }, url: () => 'fixed ranking',
        goto: async (url: string) => { readTargets.push(url); if (gotoError) throw gotoError; return { status: () => status } },
        evaluate: async (fn: unknown) => fn === observeParallelFetchChallenge ? challenge : null } as unknown as Page
      pages.push(page)
      return page
    } }
  } } as unknown as Browser
  const factory = (target: 'lp' | 'mr') => (page: Page, options: unknown) => {
    captured.push({ target, options })
    let diagnostics: Record<string, unknown> = {}
    return { fetchPage: async (pageNumber: number, url: string) => {
      await page.goto(url)
      diagnosticStatus = status
      if (status === 429) throw new RankDistributionDomError('http-denied')
      if (readDiagnostics) {
        await page.evaluate(() => null)
        diagnostics = { lastAttemptedPage: pageNumber, ...readDiagnostics }
      }
      if (readError) throw readError
      return { totalCount: 10000, totalPages: 500, page: pageNumber, entries: [{ accountKey: 'private-account-row' }], sourceUrl: 'private-url' }
    }, getDiagnostics: () => ({ lastHttpStatus: diagnosticStatus, ...diagnostics }) }
  }
  const dependencies: ParallelFetchBrowserDependencies = { loadSession: async () => { loaded++; return state() },
    launch: async () => { launched++; return browser }, createLpReader: factory('lp') as never, createMrReader: factory('mr') as never }
  return { dependencies, pages, pageCloses, captured, readTargets,
    setChallenge: () => { challenge = true }, setStatus: (value: number) => { status = value },
    setGotoError: (error: Error) => { gotoError = error },
    setReadDiagnostics: (value: Record<string, unknown> | null) => { readDiagnostics = value },
    setReadError: (error: Error) => { readError = error },
    stats: () => ({ loaded, launched, browserClosed, contextClosed }) }
}

test('one owned context has separate worker pages and rows never cross the adapter boundary', async () => {
  const f = fixture(), run = new AbortController(), trial = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: run.signal }, f.dependencies)
  const first = await session.createReader(1, 'lp', trial.signal), second = await session.createReader(2, 'mr', trial.signal)
  assert.equal(f.pages.length, 2)
  assert.deepEqual(await first.readPage(1), { totalCount: 10000, totalPages: 500, httpStatus: 200 })
  assert.deepEqual(await second.readPage(1), { totalCount: 10000, totalPages: 500, httpStatus: 200 })
  assert.match(f.readTargets[0], /^https:\/\/www\.streetfighter\.com\/6\/buckler\/ja-jp\/ranking\/league\?/)
  assert.match(f.readTargets[1], /^https:\/\/www\.streetfighter\.com\/6\/buckler\/ja-jp\/ranking\/master\?/)
  assert.doesNotMatch(JSON.stringify(await first.readPage(2)), /private|account|row|url/)
  assert.equal((f.captured[1] as { options: { allowReadablePagesAfterSignIn: boolean } }).options.allowReadablePagesAfterSignIn, false)
  await first.close(); await first.close()
  assert.equal(f.pageCloses[0], 1); assert.equal(f.stats().contextClosed, 0)
  await session.close(); await session.close()
  assert.deepEqual(f.stats(), { loaded: 1, launched: 1, browserClosed: 1, contextClosed: 1 })
})

test('a new response or navigation timeout cannot reuse a previous HTTP status', async () => {
  const f = fixture(), controller = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', controller.signal)
  assert.equal((await reader.readPage(1)).httpStatus, 200)
  f.setStatus(403); f.setChallenge()
  await assert.rejects(reader.readPage(2), (error: unknown) => error instanceof ParallelFetchReadError
    && error.code === 'human-verification' && error.httpStatus === 403)
  await session.close()
  const next = fixture(), second = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, next.dependencies)
  const another = await second.createReader(1, 'mr', controller.signal)
  assert.equal((await another.readPage(1)).httpStatus, 200)
  const timeout = new Error('private navigation information'); timeout.name = 'TimeoutError'
  next.setGotoError(timeout)
  await assert.rejects(another.readPage(2), (error: unknown) => error instanceof ParallelFetchReadError
    && error.code === 'timeout' && error.httpStatus === null)
  await second.close()
})

test('success and authentication failure expose only current allowlisted DOM diagnostics', async () => {
  for (const target of ['lp', 'mr'] as const) {
    const f = fixture(), controller = new AbortController()
    const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, f.dependencies)
    const reader = await session.createReader(1, target, controller.signal)
    f.setReadDiagnostics({ lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false, lastRankingReadable: true,
      cookies: 'private-cookie', accountKey: 'private-account', sourceUrl: 'private-url' })
    const result = await reader.readPage(1)
    assert.deepEqual(result.diagnostics, { authenticationEvidence: 'logout-control', loginRequiredHeading: false, rankingReadable: true })
    assert.doesNotMatch(JSON.stringify(result), /private|cookies|accountKey|sourceUrl/)
    f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: false, lastRankingReadable: true,
      rawText: 'private-page-text' })
    f.setReadError(new RankDistributionDomError('authentication-unconfirmed'))
    await assert.rejects(reader.readPage(2), (error: unknown) => {
      assert.ok(error instanceof ParallelFetchReadError)
      assert.equal(error.code, 'authentication-unconfirmed')
      assert.deepEqual(error.diagnostics, { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: true })
      assert.doesNotMatch(JSON.stringify(error), /private|rawText/)
      return true
    })
    await session.close()
  }
})

test('same-page navigation failure cannot inherit prior authentication observations', async () => {
  for (const target of ['lp', 'mr'] as const) {
    const f = fixture(), controller = new AbortController()
    const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, f.dependencies)
    const reader = await session.createReader(1, target, controller.signal)
    f.setReadDiagnostics({ lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
    assert.equal((await reader.readPage(1)).diagnostics?.authenticationEvidence, 'logout-control')
    const timeout = new Error('private navigation information'); timeout.name = 'TimeoutError'
    f.setGotoError(timeout)
    await assert.rejects(reader.readPage(1), (error: unknown) => error instanceof ParallelFetchReadError
      && error.code === 'timeout' && error.httpStatus === null && error.diagnostics === undefined)
    await session.close()
  }
})

test('missing, mismatched, or unsupported diagnostic fields are omitted or normalized', async () => {
  const f = fixture(), controller = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', controller.signal)
  f.setReadDiagnostics({ lastAuthenticationEvidence: 'private-unrecognized-value', lastLoginRequiredHeading: 'private', lastRankingReadable: {} })
  assert.equal((await reader.readPage(1)).diagnostics, undefined)
  f.setReadDiagnostics({ lastAuthenticationEvidence: 'private-unrecognized-value', lastLoginRequiredHeading: true, lastRankingReadable: false })
  assert.deepEqual((await reader.readPage(2)).diagnostics, { authenticationEvidence: null, loginRequiredHeading: true, rankingReadable: false })
  f.setReadDiagnostics({ lastAttemptedPage: 2, lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
  assert.equal((await reader.readPage(3)).diagnostics, undefined)
  await session.close()
})

test('only visible human-verification headings or challenge controls cause the DOM guard to stop', t => {
  let headings: unknown[] = [], controls: unknown[] = []
  const previous = ['document', 'window'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: (selector: string) => selector === 'h1,h2' ? headings : controls } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) } })
  t.after(() => { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) } })
  const node = (text: string, hidden = false) => ({ innerText: text, parentElement: null,
    getBoundingClientRect: () => ({ width: hidden ? 0 : 100, height: 20 }), hasAttribute: () => false })
  assert.equal(observeParallelFetchChallenge(), false)
  headings = [node('LPランキング')]; assert.equal(observeParallelFetchChallenge(), false)
  headings = [node('セキュリティ検証の実行', true)]; assert.equal(observeParallelFetchChallenge(), false)
  headings = [node('セキュリティ検証の実行')]; assert.equal(observeParallelFetchChallenge(), true)
  headings = [node('Verify you are human')]; assert.equal(observeParallelFetchChallenge(), true)
  headings = []; controls = [node('')]; assert.equal(observeParallelFetchChallenge(), true)
})

test('visible challenges and HTTP 429 stop with safe fixed codes', async () => {
  for (const target of ['lp', 'mr'] as const) {
    const f = fixture(), run = new AbortController(), trial = new AbortController()
    const session = await createParallelFetchBrowserSession({ intervalMs: 10000, signal: run.signal }, f.dependencies)
    const reader = await session.createReader(1, target, trial.signal)
    f.setChallenge()
    await assert.rejects(reader.readPage(1), (error: unknown) => error instanceof ParallelFetchReadError && error.code === 'human-verification')
    await session.close()
  }
  const f = fixture(), controller = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', controller.signal)
  f.setStatus(429)
  await assert.rejects(reader.readPage(1), (error: unknown) => error instanceof ParallelFetchReadError && error.code === 'http-denied' && error.httpStatus === 429)
  await session.close()
})

test('trial abort closes owned pages; run abort closes the owned context and browser', async () => {
  const f = fixture(), run = new AbortController(), trial = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: run.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', trial.signal)
  trial.abort()
  await assert.rejects(reader.readPage(1), (error: unknown) => error instanceof ParallelFetchReadError && error.code === 'cancelled')
  assert.equal(f.pageCloses[0], 1); assert.equal(f.stats().contextClosed, 0)
  run.abort(); await session.close()
  assert.equal(f.stats().contextClosed, 1); assert.equal(f.stats().browserClosed, 1)
  await assert.rejects(session.createReader(1, 'lp', new AbortController().signal), /cancelled/)
})

test('authentication and browser failures are sanitized and never open a login flow', async () => {
  const controller = new AbortController(), f = fixture()
  await assert.rejects(createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, {
    ...f.dependencies, loadSession: async () => { throw new Error('private cookies C:/session') },
  }), (error: unknown) => error instanceof ParallelFetchReadError && error.code === 'session-unavailable' && !/private|session\//.test(error.message))
  assert.equal(f.stats().launched, 0)
  await assert.rejects(createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, {
    ...f.dependencies, launch: async () => { throw new Error('private browser details') },
  }), (error: unknown) => error instanceof ParallelFetchReadError && error.code === 'browser-unavailable')
  const loadedBeforeStop = f.stats().loaded
  const stopped = new AbortController(); stopped.abort()
  await assert.rejects(createParallelFetchBrowserSession({ intervalMs: 5000, signal: stopped.signal }, f.dependencies), /cancelled/)
  assert.equal(f.stats().loaded, loadedBeforeStop)
})
