import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { Browser, Page } from 'playwright'
import { createParallelFetchBrowserSession, observeParallelFetchChallenge } from './parallel-fetch-browser.ts'
import { ParallelFetchReadError, runParallelFetch } from './parallel-fetch-runner.ts'
import type { ParallelFetchNavigationGate } from './parallel-fetch-runner.ts'
import { RankDistributionDomError } from './rank-distribution-dom.ts'
import { MrDistributionDomError } from './mr-distribution-dom.ts'
import type { ParallelFetchBrowserDependencies } from './parallel-fetch-browser.ts'
import { createParallelFetchDiagnosticRecorder } from './parallel-fetch-diagnostics.ts'

const navigateWithPacing: ParallelFetchNavigationGate = navigate => navigate()

function state() { return { cookies: [{ name: 'synthetic', value: 'private-cookie', domain: 'www.streetfighter.com', path: '/', expires: -1,
  httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] } }
function fixture() {
  let loaded = 0, launched = 0, browserClosed = 0, contextClosed = 0, challenge = false, status = 200, diagnosticStatus = 200
  let gotoError: Error | null = null
  let readDiagnostics: Record<string, unknown> | null = null, readError: Error | null = null
  let clock = 0, emitObservations = false, postReads = 0, recordStartEvidence = false
  let afterWait: (() => void) | undefined
  let afterNavigation: (() => Promise<void>) | undefined
  let postRead: (() => Promise<unknown>) | undefined
  const defaultSnapshot = () => ({ authenticationEvidence: readDiagnostics?.lastAuthenticationEvidence ?? null,
    loginRequiredHeading: readDiagnostics?.lastLoginRequiredHeading ?? null, rankingReadable: readDiagnostics?.lastRankingReadable ?? null })
  const pageCloses: number[] = [], captured: unknown[] = [], readTargets: string[] = []
  const navigationTimes: number[] = []
  const pages: Page[] = []
  const browser = { close: async () => { browserClosed++ }, newContext: async (options: unknown) => {
    captured.push(options)
    return { close: async () => { contextClosed++ }, newPage: async () => {
      const id = pages.length
      const page = Object.assign(new EventEmitter(), { close: async () => { pageCloses[id] = (pageCloses[id] ?? 0) + 1 }, url: () => 'fixed ranking',
        goto: async (url: string) => {
          readTargets.push(url); navigationTimes.push(clock)
          if (recordStartEvidence) {
            const request = { url: () => url, resourceType: () => 'document' }
            ;(page as unknown as EventEmitter).emit('request', request)
            ;(page as unknown as EventEmitter).emit('requestfailed', request)
          }
          if (gotoError) throw gotoError
          return { status: () => status }
        },
        evaluate: async (fn: unknown) => fn === observeParallelFetchChallenge ? challenge : null }) as unknown as Page
      pages.push(page)
      return page
    } }
  } } as unknown as Browser
  const factory = (target: 'lp' | 'mr') => (page: Page, options: unknown) => {
    captured.push({ target, options })
    let diagnostics: Record<string, unknown> = {}
    return { fetchPage: async (pageNumber: number, url: string) => {
      if (recordStartEvidence) { await Promise.resolve(); await Promise.resolve() }
      await (options as { navigateWithPacing: ParallelFetchNavigationGate }).navigateWithPacing(() => page.goto(url))
      await afterNavigation?.()
      diagnosticStatus = status
      if (status === 429) throw new RankDistributionDomError('http-denied')
      if (readDiagnostics) {
        await page.evaluate(() => null)
        diagnostics = { lastAttemptedPage: pageNumber, ...readDiagnostics }
        if (emitObservations) (options as { onObservation(value: unknown): void }).onObservation(defaultSnapshot())
      }
      if (readError) throw readError
      return { totalCount: 10000, totalPages: 500, page: pageNumber, entries: [{ accountKey: 'private-account-row' }], sourceUrl: 'private-url' }
    }, getDiagnostics: () => ({ lastHttpStatus: diagnosticStatus, ...diagnostics }),
    observeCurrentPage: async () => { postReads++; await page.evaluate(() => null); return postRead ? await postRead() : defaultSnapshot() } }
  }
  const dependencies: ParallelFetchBrowserDependencies = { loadSession: async () => { loaded++; return state() },
    launch: async () => { launched++; return browser }, createLpReader: factory('lp') as never, createMrReader: factory('mr') as never,
    now: () => clock, wait: async (milliseconds, signal) => { if (signal.aborted) throw new Error(); clock += milliseconds; afterWait?.(); if (signal.aborted) throw new Error() } }
  return { dependencies, pages, pageCloses, captured, readTargets, navigationTimes,
    now: () => clock, advance: (milliseconds: number) => { clock += milliseconds },
    recordStartEvidence: () => { recordStartEvidence = true },
    setChallenge: () => { challenge = true }, setStatus: (value: number) => { status = value },
    setGotoError: (error: Error) => { gotoError = error },
    setReadDiagnostics: (value: Record<string, unknown> | null) => { readDiagnostics = value },
    setReadError: (error: Error | null) => { readError = error },
    enableObservations: () => { emitObservations = true },
    setAfterWait: (value: () => void) => { afterWait = value },
    setAfterNavigation: (value: () => Promise<void>) => { afterNavigation = value },
    setPostRead: (value: () => Promise<unknown>) => { postRead = value },
    postReads: () => postReads,
    stats: () => ({ loaded, launched, browserClosed, contextClosed }) }
}

test('one owned context has separate worker pages and rows never cross the adapter boundary', async () => {
  const f = fixture(), run = new AbortController(), trial = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: run.signal }, f.dependencies)
  const first = await session.createReader(1, 'lp', trial.signal), second = await session.createReader(2, 'mr', trial.signal)
  assert.equal(f.pages.length, 2)
  assert.deepEqual(await first.readPage(1, navigateWithPacing), { totalCount: 10000, totalPages: 500, httpStatus: 200 })
  assert.deepEqual(await second.readPage(1, navigateWithPacing), { totalCount: 10000, totalPages: 500, httpStatus: 200 })
  assert.match(f.readTargets[0], /^https:\/\/www\.streetfighter\.com\/6\/buckler\/ja-jp\/ranking\/league\?/)
  assert.match(f.readTargets[1], /^https:\/\/www\.streetfighter\.com\/6\/buckler\/ja-jp\/ranking\/master\?/)
  assert.doesNotMatch(JSON.stringify(await first.readPage(2, navigateWithPacing)), /private|account|row|url/)
  assert.equal((f.captured[1] as { options: { allowReadablePagesAfterSignIn: boolean } }).options.allowReadablePagesAfterSignIn, false)
  await first.close(); await first.close()
  assert.equal(f.pageCloses[0], 1); assert.equal(f.stats().contextClosed, 0)
  await session.close(); await session.close()
  assert.deepEqual(f.stats(), { loaded: 1, launched: 1, browserClosed: 1, contextClosed: 1 })
})

test('LP and MR sessions support eight worker pages and reject a ninth before creating a page', async () => {
  for (const target of ['lp', 'mr'] as const) {
    const f = fixture(), controller = new AbortController()
    const session = await createParallelFetchBrowserSession({ intervalMs: 3000, signal: controller.signal }, f.dependencies)
    const readers = []
    for (let workerId = 1; workerId <= 8; workerId++) {
      readers.push(await session.createReader(workerId, target, controller.signal))
    }
    assert.equal(f.pages.length, 8)
    assert.equal(new Set(f.pages).size, 8)
    assert.deepEqual(await readers[7].readPage(1, navigateWithPacing), { totalCount: 10000, totalPages: 500, httpStatus: 200 })
    await assert.rejects(session.createReader(9, target, controller.signal), /invalid-request/)
    assert.equal(f.pages.length, 8)
    await Promise.all(readers.map(reader => reader.close()))
    assert.deepEqual(f.pageCloses, Array(8).fill(1))
    await session.close()
    assert.deepEqual(f.stats(), { loaded: 1, launched: 1, browserClosed: 1, contextClosed: 1 })
  }
})

test('each condition delegates pacing to the caller for LP and MR, including zero and long intervals', async () => {
  const f = fixture(), controller = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 10000, signal: controller.signal }, f.dependencies)
  await session.createReader(1, 'lp', controller.signal)
  await session.createReader(1, 'lp', controller.signal, 0)
  await session.createReader(1, 'mr', controller.signal, 60000)
  for (const value of f.captured.slice(1)) {
    const options = (value as { options: { minIntervalMs?: number; navigateWithPacing?: unknown } }).options
    assert.equal(options.minIntervalMs, undefined)
    assert.equal(typeof options.navigateWithPacing, 'function')
  }
  for (const interval of [-1, 1, 250, 60001, NaN, Infinity]) {
    await assert.rejects(session.createReader(1, 'lp', controller.signal, interval), /invalid-request/)
  }
  assert.equal(f.pages.length, 3)
  await session.close()
})

test('the adapter requires and awaits the caller gate immediately before each navigation', async () => {
  for (const target of ['lp', 'mr'] as const) {
    const f = fixture(), controller = new AbortController()
    const session = await createParallelFetchBrowserSession({ intervalMs: 0, signal: controller.signal }, f.dependencies)
    const reader = await session.createReader(1, target, controller.signal, 60000)
    await assert.rejects(reader.readPage(1, undefined as never), /invalid-request/)
    assert.equal(f.readTargets.length, 0)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const pending = reader.readPage(1, navigate => gate.then(navigate))
    await Promise.resolve()
    assert.equal(f.readTargets.length, 0)
    release()
    await pending
    assert.equal(f.readTargets.length, 1)
    await reader.readPage(2, navigate => { assert.equal(f.readTargets.length, 1); return navigate() })
    assert.equal(f.readTargets.length, 2)
    await session.close()
  }
})

test('expensive progress updates cannot compress actual starts or move the diagnostic clock', async () => {
  for (const target of ['lp', 'mr'] as const) {
    const f = fixture(), controller = new AbortController()
    f.recordStartEvidence()
    const session = await createParallelFetchBrowserSession({ intervalMs: 100, signal: controller.signal }, f.dependencies)
    const seenReading = new Set<string>()
    const epoch = Date.UTC(2026, 0, 1)
    const report = await runParallelFetch({ target, startPage: 1, pageCount: 20,
      concurrencies: [1, 2], repetitions: 1, intervalMs: 100, intervalScope: 'global' }, {
      now: f.now, wallNow: () => new Date(epoch + f.now()).toISOString(),
      wait: async milliseconds => { f.advance(milliseconds) },
      createReader: (...args) => session.createReader(...args),
      onUpdate: snapshot => {
        const trial = snapshot.trials.at(-1)
        for (const worker of trial?.workers ?? []) {
          const key = `${snapshot.trials.length}:${trial!.state}:${worker.id}:${worker.page}`
          if (worker.state === 'reading' && !seenReading.has(key)) {
            seenReading.add(key)
            f.advance(250)
          }
        }
      },
    })
    assert.equal(report.state, 'complete')
    assert.equal(f.navigationTimes.length, 43)
    for (let index = 1; index < f.navigationTimes.length; index++) {
      assert.ok(f.navigationTimes[index] - f.navigationTimes[index - 1] >= 100)
    }
    const attempts = report.trials.flatMap(trial => trial.attempts)
    assert.deepEqual(attempts.map(attempt => Date.parse(attempt.startedAt) - epoch).sort((a, b) => a - b),
      [...f.navigationTimes].sort((a, b) => a - b))
    assert.ok(attempts.every(attempt => attempt.diagnostics?.trace?.network[0]?.elapsedMs === 0))
    await session.close()
  }
})

test('a new response or navigation timeout cannot reuse a previous HTTP status', async () => {
  const f = fixture(), controller = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', controller.signal)
  assert.equal((await reader.readPage(1, navigateWithPacing)).httpStatus, 200)
  f.setStatus(403); f.setChallenge()
  await assert.rejects(reader.readPage(2, navigateWithPacing), (error: unknown) => error instanceof ParallelFetchReadError
    && error.code === 'human-verification' && error.httpStatus === 403)
  await session.close()
  const next = fixture(), second = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, next.dependencies)
  const another = await second.createReader(1, 'mr', controller.signal)
  assert.equal((await another.readPage(1, navigateWithPacing)).httpStatus, 200)
  const timeout = new Error('private navigation information'); timeout.name = 'TimeoutError'
  next.setGotoError(timeout)
  await assert.rejects(another.readPage(2, navigateWithPacing), (error: unknown) => error instanceof ParallelFetchReadError
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
    const result = await reader.readPage(1, navigateWithPacing)
    assert.deepEqual(result.diagnostics, { authenticationEvidence: 'logout-control', loginRequiredHeading: false, rankingReadable: true })
    assert.doesNotMatch(JSON.stringify(result), /private|cookies|accountKey|sourceUrl/)
    f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: false, lastRankingReadable: true,
      rawText: 'private-page-text' })
    f.setReadError(new RankDistributionDomError('authentication-unconfirmed'))
    await assert.rejects(reader.readPage(2, navigateWithPacing), (error: unknown) => {
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
    assert.equal((await reader.readPage(1, navigateWithPacing)).diagnostics?.authenticationEvidence, 'logout-control')
    const timeout = new Error('private navigation information'); timeout.name = 'TimeoutError'
    f.setGotoError(timeout)
    await assert.rejects(reader.readPage(1, navigateWithPacing), (error: unknown) => error instanceof ParallelFetchReadError
      && error.code === 'timeout' && error.httpStatus === null && error.diagnostics === undefined)
    await session.close()
  }
})

test('missing, mismatched, or unsupported diagnostic fields are omitted or normalized', async () => {
  const f = fixture(), controller = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', controller.signal)
  f.setReadDiagnostics({ lastAuthenticationEvidence: 'private-unrecognized-value', lastLoginRequiredHeading: 'private', lastRankingReadable: {} })
  assert.equal((await reader.readPage(1, navigateWithPacing)).diagnostics, undefined)
  f.setReadDiagnostics({ lastAuthenticationEvidence: 'private-unrecognized-value', lastLoginRequiredHeading: true, lastRankingReadable: false })
  assert.deepEqual((await reader.readPage(2, navigateWithPacing)).diagnostics, { authenticationEvidence: null, loginRequiredHeading: true, rankingReadable: false })
  f.setReadDiagnostics({ lastAttemptedPage: 2, lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
  assert.equal((await reader.readPage(3, navigateWithPacing)).diagnostics, undefined)
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
    await assert.rejects(reader.readPage(1, navigateWithPacing), (error: unknown) => error instanceof ParallelFetchReadError && error.code === 'human-verification')
    await session.close()
  }
  const f = fixture(), controller = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: controller.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', controller.signal)
  f.setStatus(429)
  await assert.rejects(reader.readPage(1, navigateWithPacing), (error: unknown) => error instanceof ParallelFetchReadError && error.code === 'http-denied' && error.httpStatus === 429)
  await session.close()
})

test('trial abort closes owned pages; run abort closes the owned context and browser', async () => {
  const f = fixture(), run = new AbortController(), trial = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: run.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', trial.signal)
  trial.abort()
  await assert.rejects(reader.readPage(1, navigateWithPacing), (error: unknown) => error instanceof ParallelFetchReadError && error.code === 'cancelled')
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

test('after auth failure only the failing page survives internal abort; passive recovery never navigates or resumes', async () => {
  for (const target of ['lp', 'mr'] as const) {
    const f = fixture(), run = new AbortController(), trial = new AbortController()
    const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: run.signal }, f.dependencies)
    const first = await session.createReader(1, target, trial.signal)
    await session.createReader(2, target, trial.signal)
    f.enableObservations()
    f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
    f.setReadError(new RankDistributionDomError('authentication-unconfirmed'))
    await assert.rejects(first.readPage(7, navigateWithPacing), /authentication-unconfirmed/)
    trial.abort()
    assert.equal(f.pageCloses[0], undefined)
    assert.equal(f.pageCloses[1], 1)
    f.setAfterWait(() => f.setReadDiagnostics({ lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false, lastRankingReadable: true }))
    const diagnostics = await first.observeAfterStop!(run.signal)
    assert.equal(diagnostics?.authenticationEvidence, 'login-control', 'original failure observation is retained')
    assert.deepEqual(diagnostics?.trace?.postStop, { durationMs: 30000, outcome: 'observed' })
    const observations = diagnostics!.trace!.observations
    assert.equal(observations[0].phase, 'read')
    assert.ok(observations.some(item => item.phase === 'after-stop' && item.authenticationEvidence === 'logout-control' && item.elapsedMs === 5000))
    assert.equal(f.postReads(), 6)
    assert.equal(f.readTargets.length, 1, 'no goto/reload during observation')
    await assert.rejects(first.readPage(8, navigateWithPacing), /cancelled/)
    assert.equal(await first.observeAfterStop!(run.signal), undefined, 'no second observation window')
    await first.close(); await session.close()
    assert.equal(f.pageCloses[0], 1)
  }
})

test('a new successful strict read clears prior auth stop state and closes normally on abort', async () => {
  for (const target of ['lp', 'mr'] as const) {
    const f = fixture(), run = new AbortController(), trial = new AbortController()
    const session = await createParallelFetchBrowserSession({ intervalMs: 10000, signal: run.signal }, f.dependencies)
    const reader = await session.createReader(1, target, trial.signal)
    f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
    f.setReadError(new RankDistributionDomError('authentication-unconfirmed'))
    await assert.rejects(reader.readPage(2, navigateWithPacing), /authentication-unconfirmed/)
    f.setReadError(null)
    f.setReadDiagnostics({ lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
    await reader.readPage(2, navigateWithPacing)
    assert.equal(await reader.observeAfterStop!(run.signal), undefined, 'old auth failure must not open a passive observation window')
    assert.equal(f.postReads(), 0); assert.equal(f.readTargets.length, 2)
    trial.abort()
    assert.equal(f.pageCloses[0], 1, 'the recovered page no longer survives an internal abort')
    await session.close()
  }
})

test('auth stop reset never clears sticky WAF protection before a caller retry', async () => {
  const f = fixture(), run = new AbortController(), trial = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 10000, signal: run.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', trial.signal)
  f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
  f.setReadError(new RankDistributionDomError('authentication-unconfirmed'))
  await assert.rejects(reader.readPage(2, navigateWithPacing), /authentication-unconfirmed/)
  const events = f.pages[0] as unknown as EventEmitter
  const request = { url: () => 'https://www.streetfighter.com/6/buckler/ranking', resourceType: () => 'fetch' }
  events.emit('request', request)
  events.emit('response', { request: () => request, status: () => 405, headers: () => ({ 'x-amzn-waf-action': 'captcha' }) })
  f.setReadError(null)
  await assert.rejects(reader.readPage(2, navigateWithPacing), /human-verification/)
  assert.equal(f.readTargets.length, 1)
  await session.close()
})

test('passive observation is cancelled promptly and ends on challenge or page failure with fixed diagnostics', async () => {
  for (const outcome of ['cancelled', 'human-verification', 'page-unavailable'] as const) {
    const f = fixture(), run = new AbortController(), trial = new AbortController()
    const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: run.signal }, f.dependencies)
    const reader = await session.createReader(1, 'lp', trial.signal)
    f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: false, lastRankingReadable: false })
    f.setReadError(new RankDistributionDomError('authentication-unconfirmed'))
    await assert.rejects(reader.readPage(1, navigateWithPacing), /authentication-unconfirmed/)
    trial.abort()
    if (outcome === 'cancelled') f.setAfterWait(() => run.abort())
    if (outcome === 'human-verification') f.setAfterWait(() => f.setChallenge())
    if (outcome === 'page-unavailable') f.setPostRead(async () => { throw new Error('private-url?secret=private-cookie') })
    const result = await reader.observeAfterStop!(run.signal)
    assert.equal(result?.trace?.postStop?.outcome, outcome)
    assert.ok(result!.trace!.postStop!.durationMs <= 5000)
    assert.doesNotMatch(JSON.stringify(result), /private|secret|cookie/)
    assert.equal(f.readTargets.length, 1)
    if (outcome === 'human-verification') assert.equal(result?.trace?.observations.at(-1)?.humanVerification, true)
    await reader.close(); await session.close()
  }
})

test('an in-flight passive DOM sample does not prevent user cancellation', async () => {
  const f = fixture(), run = new AbortController(), trial = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: run.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', trial.signal)
  f.setReadError(new RankDistributionDomError('authentication-unconfirmed'))
  await assert.rejects(reader.readPage(1, navigateWithPacing), /authentication-unconfirmed/)
  trial.abort()
  f.setPostRead(() => new Promise(() => {}))
  const observing = reader.observeAfterStop!(run.signal)
  run.abort()
  assert.equal((await observing)?.trace?.postStop?.outcome, 'cancelled')
  await reader.close(); await session.close()
})

test('an unresponsive passive DOM sample ends at the observation deadline', async t => {
  const f = fixture(), run = new AbortController(), trial = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: run.signal }, f.dependencies)
  const reader = await session.createReader(1, 'lp', trial.signal)
  f.setReadError(new RankDistributionDomError('authentication-unconfirmed'))
  await assert.rejects(reader.readPage(1, navigateWithPacing), /authentication-unconfirmed/)
  trial.abort()
  f.setPostRead(() => new Promise(() => {}))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const observing = reader.observeAfterStop!(run.signal)
  t.mock.timers.tick(30_000)
  const result = await observing
  assert.equal(result?.trace?.postStop?.outcome, 'page-unavailable')
  assert.equal(f.readTargets.length, 1)
  await reader.close(); await session.close()
})

test('MR challenge detection after the initial guard is reflected in the final trace', async () => {
  const f = fixture(), run = new AbortController(), trial = new AbortController()
  const session = await createParallelFetchBrowserSession({ intervalMs: 5000, signal: run.signal }, f.dependencies)
  const reader = await session.createReader(1, 'mr', trial.signal)
  f.enableObservations()
  f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: false, lastRankingReadable: false })
  f.setReadError(new MrDistributionDomError('human-verification'))
  await assert.rejects(reader.readPage(1, navigateWithPacing), (error: unknown) => {
    assert.ok(error instanceof ParallelFetchReadError)
    assert.equal(error.code, 'human-verification')
    assert.equal(error.diagnostics?.trace?.observations.at(-1)?.humanVerification, true)
    return true
  })
  await session.close()
})

test('network diagnostics classify failures, discard secrets, ignore stale requests and detach listeners', () => {
  const page = new EventEmitter(), clock = { value: 0 }
  const recorder = createParallelFetchDiagnosticRecorder(page as unknown as Page, () => clock.value)
  const request = (url: string, resource = 'fetch') => ({ url: () => url, resourceType: () => resource })
  const failure = (req: unknown, status: number) => page.emit('response', { request: () => req, status: () => status })
  const stale = request('https://www.streetfighter.com/private?token=private-secret')
  recorder.begin(); page.emit('request', stale)
  recorder.begin(); failure(stale, 503)
  const auth = request('https://auth.cid.capcom.com/private?token=private-secret')
  page.emit('request', auth); failure(auth, 200); clock.value = 12; failure(auth, 401)
  const buckler = request('https://www.streetfighter.com/private-id', 'xhr')
  page.emit('request', buckler); page.emit('requestfailed', buckler)
  recorder.afterStop()
  const thirdParty = request('https://secret.example.com/private-id', 'media')
  page.emit('request', thirdParty); failure(thirdParty, 503)
  const trace = recorder.snapshot()!.trace!
  assert.deepEqual(trace.network, [
    { elapsedMs: 12, phase: 'read', kind: 'http-error', resource: 'fetch', site: 'capcom-auth', status: 401 },
    { elapsedMs: 12, phase: 'read', kind: 'request-failed', resource: 'xhr', site: 'buckler', status: null },
    { elapsedMs: 12, phase: 'after-stop', kind: 'http-error', resource: 'other', site: 'other', status: 503 },
  ])
  assert.doesNotMatch(JSON.stringify(trace), /https|private|secret|token/)
  recorder.dispose()
  assert.equal(page.eventNames().length, 0)
})

test('trace bounds retain newest events with truncation counts and compact successful reads', () => {
  const page = new EventEmitter(), clock = { value: 0 }
  const recorder = createParallelFetchDiagnosticRecorder(page as unknown as Page, () => clock.value)
  recorder.begin()
  const req = { url: () => 'https://www.streetfighter.com/6/buckler', resourceType: () => 'fetch' }
  page.emit('request', req)
  for (let i = 0; i < 90; i++) {
    clock.value = i
    recorder.observe({ authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: false, humanVerification: false }, true)
    page.emit('requestfailed', req)
  }
  const failure = recorder.snapshot()!.trace!, success = recorder.snapshot(undefined, true)!.trace!
  assert.equal(failure.observations.length, 80); assert.equal(failure.network.length, 80)
  assert.equal(failure.droppedObservations, 10); assert.equal(failure.droppedNetworkEvents, 10)
  assert.equal(failure.observations[0].elapsedMs, 10)
  assert.equal(success.observations.length, 8); assert.equal(success.network.length, 8)
  assert.equal(success.droppedObservations, 82); assert.equal(success.droppedNetworkEvents, 82)
  recorder.dispose()
})

test('response diagnostics retain only known WAF actions and notify only for current first-party requests', () => {
  const page = new EventEmitter(), calls: number[] = []
  const recorder = createParallelFetchDiagnosticRecorder(page as unknown as Page, () => 0, () => { calls.push(1) })
  const request = (host: string) => ({ url: () => `https://${host}/private?token=secret`, resourceType: () => 'fetch' })
  const response = (req: unknown, status: number, action: string | undefined) => page.emit('response', {
    request: () => req, status: () => status,
    headers: () => ({ 'x-amzn-waf-action': action, 'set-cookie': 'private-cookie', authorization: 'secret-token' }),
  })
  recorder.begin()
  const stale = request('www.streetfighter.com')
  page.emit('request', stale)
  recorder.begin(); response(stale, 405, 'captcha')
  for (const [host, status, action] of [
    ['www.streetfighter.com', 405, 'captcha'], ['auth.cid.capcom.com', 202, 'challenge'],
    ['external.example.com', 405, 'captcha'], ['www.streetfighter.com', 405, undefined],
    ['www.streetfighter.com', 405, 'private-arbitrary-header'],
  ] as const) {
    const req = request(host)
    page.emit('request', req); response(req, status, action)
  }
  const trace = recorder.snapshot()!.trace!
  assert.deepEqual(trace.network.map(({ kind, status, wafAction }) => ({ kind, status, wafAction })), [
    { kind: 'waf-action', status: 405, wafAction: 'captcha' },
    { kind: 'waf-action', status: 202, wafAction: 'challenge' },
    { kind: 'waf-action', status: 405, wafAction: 'captcha' },
    { kind: 'http-error', status: 405, wafAction: null },
    { kind: 'http-error', status: 405, wafAction: null },
  ])
  assert.equal(calls.length, 2)
  assert.doesNotMatch(JSON.stringify(trace), /https|private|secret|cookie|authorization|token/)
  recorder.end(); response(stale, 405, 'captcha')
  assert.equal(calls.length, 2)
  recorder.dispose()
})

test('LP and MR stop an in-flight read on a WAF subresource action without a visible challenge or further navigation', async () => {
  for (const target of ['lp', 'mr'] as const) for (const [status, action] of [[405, 'captcha'], [202, 'challenge']] as const) {
    const f = fixture(), controller = new AbortController()
    const session = await createParallelFetchBrowserSession({ intervalMs: 10000, signal: controller.signal }, f.dependencies)
    const reader = await session.createReader(1, target, controller.signal)
    f.setAfterNavigation(async () => {
      const page = f.pages[0] as unknown as EventEmitter
      const req = { url: () => 'https://www.streetfighter.com/private-data', resourceType: () => 'fetch' }
      page.emit('request', req)
      page.emit('response', { request: () => req, status: () => status, headers: () => ({ 'x-amzn-waf-action': action }) })
      await new Promise(() => {}) // A stalled DOM read must not delay stopping.
    })
    await assert.rejects(reader.readPage(1, navigateWithPacing), (error: unknown) => {
      assert.ok(error instanceof ParallelFetchReadError)
      assert.equal(error.code, 'human-verification')
      assert.equal(error.httpStatus, 200, 'top-level navigation status remains distinct from the subresource')
      assert.equal(error.diagnostics?.trace?.network[0].wafAction, action)
      assert.equal(error.diagnostics?.trace?.observations.at(-1)?.humanVerification, true)
      return true
    })
    await assert.rejects(reader.readPage(2, navigateWithPacing), /human-verification/)
    assert.equal(f.readTargets.length, 1)
    assert.equal(await reader.observeAfterStop!(controller.signal), undefined)
    await reader.close(); await session.close()
  }
})
