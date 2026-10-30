import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Browser, Page } from 'playwright'
import { createSampleSurveyReader, observeSampleSurveyRows } from './sample-survey-browser.ts'
import { createParallelFetchBrowserSession, observeParallelFetchChallenge } from './parallel-fetch-browser.ts'
import type { ParallelFetchBrowserDependencies } from './parallel-fetch-browser.ts'
import { SampleSurveyReadError, SampleSurveyRetryableReadError } from './sample-survey-reader.ts'
import { ParallelFetchReadError } from './parallel-fetch-runner.ts'
import type { ParallelFetchReadDiagnostics } from '../../src/types/parallelFetch.ts'
import type { ParallelFetchNavigationGate } from './parallel-fetch-runner.ts'
import { RankDistributionDomError } from './rank-distribution-dom.ts'

const salt = 'a'.repeat(64)
const key = (id: string) => createHash('sha256').update(`${salt}:/6/buckler/ja-jp/profile/${id}`).digest('hex')
type Capture = NonNullable<Awaited<ReturnType<typeof observeSampleSurveyRows>>>
type Target = 'lp' | 'mr'
function fixture() {
  let loaded = 0, launched = 0, contextClosed = 0, browserClosed = 0, captureCount = 0
  let challenge = false, readError: Error | null = null, status = 200
  let readDiagnostics: Record<string, unknown> | null = null
  let network: { status: number; resource?: string; site?: string; headers?: Record<string, string> | null }[] = []
  let mutate: ((capture: Capture) => void) | undefined
  let duringCapture: ((page: Page) => Promise<void>) | undefined
  const pages: Page[] = [], navigation: { target: Target; page: number }[] = [], factoryOptions: unknown[] = []
  const lastPages = new Map<Page, number>()
  const targetFor = new Map<Page, Target>()
  const rows = (target: Target, page: number) => [0, 1].map(index => ({
    accountId: String((page - 1) * 2 + index + 10001), value: target === 'lp' ? 12000 : 1600,
    rankId: target === 'lp' ? 16 : null,
    accountKey: key(String((page - 1) * 2 + index + 10001)),
  }))
  const browser = { close: async () => { browserClosed++ }, newContext: async () => ({
    close: async () => { contextClosed++ },
    newPage: async () => {
      let url = 'about:blank'
      const page = Object.assign(new EventEmitter(), {
        close: async () => {}, url: () => url,
        goto: async (value: string) => {
          url = value
          for (const event of network) {
            const request = { url: () => event.site ?? value, resourceType: () => event.resource ?? 'fetch' }
            const events = page as unknown as EventEmitter
            events.emit('request', request)
            events.emit('response', { request: () => request, status: () => event.status,
              ...(event.headers === null ? {} : { headers: () => event.headers ?? {} }) })
          }
          return { status: () => status }
        },
        evaluate: async (fn: unknown) => {
          if (fn === observeParallelFetchChallenge) return challenge
          if (fn !== observeSampleSurveyRows) return null
          captureCount++
          await duringCapture?.(page)
          const current = lastPages.get(page)!, target = targetFor.get(page)!
          const capture: Capture = { selectedPage: current, range: { from: (current - 1) * 2 + 1, to: current * 2, total: 6 }, rows: rows(target, current) }
          mutate?.(capture)
          return capture
        },
      }) as unknown as Page
      pages.push(page)
      return page
    },
  }) } as unknown as Browser
  const factory = (target: Target) => (guarded: Page, options: { navigateWithPacing: ParallelFetchNavigationGate; onObservation(value: unknown): void }) => {
    const page = pages.at(-1)!
    targetFor.set(page, target)
    factoryOptions.push(options)
    return {
      fetchPage: async (pageNumber: number, url: string) => {
        await options.navigateWithPacing(() => guarded.goto(url))
        navigation.push({ target, page: pageNumber }); lastPages.set(page, pageNumber)
        await guarded.evaluate(() => null, { salt })
        if (readDiagnostics) options.onObservation({ authenticationEvidence: readDiagnostics.lastAuthenticationEvidence,
          loginRequiredHeading: readDiagnostics.lastLoginRequiredHeading, rankingReadable: readDiagnostics.lastRankingReadable })
        if (readError) throw readError
        return { page: pageNumber, pageSize: 2, totalCount: 6, totalPages: 3, sourceUrl: url,
          entries: rows(target, pageNumber).map(row => target === 'lp'
            ? { accountKey: row.accountKey, leaguePoint: row.value, rankId: row.rankId }
            : { accountKey: row.accountKey, masterRating: row.value }) }
      },
      getDiagnostics: () => ({ lastHttpStatus: status, ...(readDiagnostics ? { lastAttemptedPage: lastPages.get(page), ...readDiagnostics } : {}) }),
    }
  }
  const dependencies: ParallelFetchBrowserDependencies = {
    loadSession: async () => { loaded++; return { cookies: [{ name: 'synthetic', value: 'synthetic-cookie', domain: 'www.streetfighter.com',
      path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] } },
    launch: async () => { launched++; return browser }, createLpReader: factory('lp') as never, createMrReader: factory('mr') as never,
  }
  return { dependencies, pages, navigation, factoryOptions,
    mutate: (value: typeof mutate) => { mutate = value },
    duringCapture: (value: typeof duringCapture) => { duringCapture = value },
    setChallenge: () => { challenge = true }, setError: (error: Error | null) => { readError = error },
    setStatus: (value: number) => { status = value },
    setReadDiagnostics: (value: Record<string, unknown> | null) => { readDiagnostics = value },
    setNetwork: (value: typeof network) => { network = value },
    stats: () => ({ loaded, launched, contextClosed, browserClosed, captureCount }),
  }
}
const errorCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof SampleSurveyReadError)
  assert.equal(error.code, code)
  assert.equal(error.message, `sample-survey:${code}`)
  assert.doesNotMatch(JSON.stringify(error), /10001|synthetic-cookie|accountKey|salt/)
  return true
}

test('headed strict LP/MR readers return only verified private rows and defer spacing to the caller', async () => {
  const f = fixture(), controller = new AbortController()
  let headless: boolean | undefined
  const reader = await createSampleSurveyReader({ signal: controller.signal }, { browser: f.dependencies,
    now: () => Date.UTC(2026, 9, 27),
    createSession: (options, dependencies) => { headless = options.headless; return createParallelFetchBrowserSession(options, dependencies) },
  })
  assert.equal(headless, false)
  const first = await reader.readPage('lp', 1)
  assert.deepEqual(first, { target: 'lp', page: 1, pageSize: 2, totalCount: 6, totalPages: 3,
    observedAt: '2026-10-27T00:00:00.000Z', entries: [{ accountId: '10001', value: 12000, rankId: 16 }, { accountId: '10002', value: 12000, rankId: 16 }] })
  await reader.readPage('lp', 3)
  const mr = await reader.readPage('mr', 1)
  assert.equal(mr.entries[0].rankId, null)
  assert.equal(mr.entries[0].value, 1600)
  assert.doesNotMatch(JSON.stringify(first), /accountKey|sourceUrl|salt|cookie|playerName/)
  assert.deepEqual(f.navigation, [{ target: 'lp', page: 1 }, { target: 'lp', page: 3 }, { target: 'mr', page: 1 }])
  assert.equal(f.pages.length, 2)
  for (const options of f.factoryOptions as { allowReadablePagesAfterSignIn: boolean; minIntervalMs?: number }[]) {
    assert.equal(options.allowReadablePagesAfterSignIn, false)
    assert.equal(options.minIntervalMs, undefined)
  }
  await reader.close(); await reader.close()
  assert.deepEqual(f.stats(), { loaded: 1, launched: 1, contextClosed: 1, browserClosed: 1, captureCount: 3 })
})

test('capture hook leaves the parallel fetch public metrics free of IDs and salt', async () => {
  const f = fixture(), controller = new AbortController()
  let captures = 0
  const session = await createParallelFetchBrowserSession({ signal: controller.signal, intervalMs: 10000 }, {
    ...f.dependencies, onValidatedPage: async input => { captures++; assert.equal(input.identitySalt, salt) },
  })
  const reader = await session.createReader(1, 'lp', controller.signal)
  const result = await reader.readPage(1, navigate => navigate())
  assert.equal(captures, 1)
  assert.deepEqual(result, { totalCount: 6, totalPages: 3, httpStatus: 200 })
  assert.doesNotMatch(JSON.stringify(result), /10001|account|salt/)
  await session.close()
})

test('private capture rejects row movement, wrong values/rank, counters, duplicates and invalid identities', async () => {
  const mutations: ((capture: Capture) => void)[] = [
    capture => { capture.rows.reverse() }, // Equal LP and rank still cannot hide swapped accounts.
    capture => { capture.rows[0].value++ }, capture => { capture.rows[0].rankId = 17 },
    capture => { capture.selectedPage++ }, capture => { capture.range.total++ }, capture => { capture.range.from++ },
    capture => { capture.rows.pop() }, capture => { capture.rows[1] = { ...capture.rows[0] } },
    capture => { capture.rows[0].accountId = 'invalid' }, capture => { capture.rows[0].accountKey = 'b'.repeat(64) },
  ]
  for (const mutation of mutations) {
    const f = fixture(), controller = new AbortController()
    f.mutate(mutation)
    const reader = await createSampleSurveyReader({ signal: controller.signal }, { browser: f.dependencies })
    await assert.rejects(reader.readPage('lp', 1), errorCode('condition-mismatch'))
    assert.equal(f.stats().contextClosed, 1)
    await assert.rejects(reader.readPage('lp', 1), errorCode('cancelled'))
  }
})

test('first page is required for each target and concurrent reads never navigate', async () => {
  const f = fixture(), controller = new AbortController()
  const reader = await createSampleSurveyReader({ signal: controller.signal }, { browser: f.dependencies })
  await reader.readPage('lp', 1)
  await assert.rejects(reader.readPage('mr', 2), errorCode('invalid-request'))
  assert.deepEqual(f.navigation, [{ target: 'lp', page: 1 }])
  const g = fixture(), second = await createSampleSurveyReader({ signal: controller.signal }, { browser: g.dependencies })
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  g.duringCapture(async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
  const pending = second.readPage('lp', 1)
  await started
  await assert.rejects(second.readPage('mr', 1), errorCode('invalid-request'))
  release(); await pending
  assert.equal(g.navigation.length, 1)
  await second.close()
})

test('challenge/auth failure stops before capture and unknown errors are sanitized', async () => {
  for (const code of ['human-verification', 'authentication-unconfirmed', 'read-failed']) {
    const f = fixture(), controller = new AbortController()
    if (code === 'human-verification') f.setChallenge()
    else f.setError(code === 'authentication-unconfirmed' ? new RankDistributionDomError(code) : new Error('account 10001 synthetic-cookie'))
    const reader = await createSampleSurveyReader({ signal: controller.signal }, { browser: f.dependencies })
    await assert.rejects(reader.readPage('lp', 1), errorCode(code))
    assert.equal(f.stats().captureCount, 0)
    assert.equal(f.stats().browserClosed, 1)
  }
})

test('fixed diagnostic evidence is delivered before closing without replacing the original failure', async () => {
  const f = fixture(), controller = new AbortController(), evidence: unknown[] = []
  f.setError(new RankDistributionDomError('authentication-unconfirmed'))
  const reader = await createSampleSurveyReader({ signal: controller.signal, onReadFailure(value) {
    assert.equal(f.stats().browserClosed, 0)
    evidence.push(value)
    throw new Error('synthetic-private-storage-error')
  } }, { browser: f.dependencies })
  await assert.rejects(reader.readPage('lp', 1), errorCode('authentication-unconfirmed'))
  assert.equal(evidence.length, 1)
  assert.equal((evidence[0] as { innerCode: string }).innerCode, 'authentication-unconfirmed')
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-cookie|synthetic-private-storage-error|"accountId"|"accountKey"|"salt"/)
  assert.equal(f.stats().browserClosed, 1)
})

function transientAuthentication(f: ReturnType<typeof fixture>, status: 502 | 503 | 504 = 502) {
  f.setError(new RankDistributionDomError('authentication-unconfirmed'))
  f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
  f.setNetwork([{ status }])
}
const retryable = (code: string, status: number) => (error: unknown) => {
  errorCode(code)(error)
  assert.ok(error instanceof SampleSurveyRetryableReadError)
  assert.equal(error.transientHttpStatus, status)
  return true
}
const terminal = (code: string) => (error: unknown) => {
  errorCode(code)(error)
  assert.ok(!(error instanceof SampleSurveyRetryableReadError))
  return true
}

for (const target of ['lp', 'mr'] as const) test(`${target} transient auth failure retains the strict reader until a caller-paced same-page recovery`, async () => {
  const f = fixture(), evidence: unknown[] = [], controller = new AbortController()
  const reader = await createSampleSurveyReader({ signal: controller.signal, onReadFailure(value) { evidence.push(value) } }, { browser: f.dependencies })
  await reader.readPage(target, 1)
  transientAuthentication(f)
  await assert.rejects(reader.readPage(target, 2), retryable('authentication-unconfirmed', 502))
  assert.equal(f.navigation.length, 2, 'the adapter never starts its own retry')
  assert.equal(f.stats().captureCount, 1, 'failed authentication never enters private capture')
  assert.equal(f.stats().contextClosed, 0); assert.equal(evidence.length, 0)
  f.setError(null); f.setNetwork([])
  f.setReadDiagnostics({ lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false, lastRankingReadable: true })
  const recovered = await reader.readPage(target, 2)
  assert.equal(recovered.page, 2); assert.equal(recovered.entries[0].accountId, '10003')
  assert.deepEqual(f.navigation.map(value => value.page), [1, 2, 2])
  assert.equal(f.stats().captureCount, 2)
  await reader.close()
  assert.equal(evidence.length, 0, 'successful strict recovery discards the pending failure')
  assert.equal(f.stats().contextClosed, 1)
  for (const options of f.factoryOptions as { allowReadablePagesAfterSignIn: boolean }[]) assert.equal(options.allowReadablePagesAfterSignIn, false)
})

for (const status of [502, 503, 504] as const) test(`a verified main-document ${status} can be retried before initial sign-in`, async () => {
  const f = fixture(), evidence: unknown[] = []
  f.setStatus(status); f.setError(new RankDistributionDomError('server-error'))
  f.setNetwork([{ status, resource: 'document' }])
  const reader = await createSampleSurveyReader({ signal: new AbortController().signal, onReadFailure(value) { evidence.push(value) } }, { browser: f.dependencies })
  await assert.rejects(reader.readPage('lp', 1), retryable('server-error', status))
  assert.equal(f.stats().contextClosed, 0); assert.equal(f.stats().captureCount, 0); assert.equal(evidence.length, 0)
  f.setStatus(200); f.setError(null); f.setNetwork([])
  await reader.readPage('lp', 1); await reader.close()
  assert.deepEqual(f.navigation.map(value => value.page), [1, 1]); assert.equal(evidence.length, 0)
})

for (const target of ['lp', 'mr'] as const) test(`${target} authentication retry needs a prior strict success for that target`, async () => {
  const f = fixture(), reader = await createSampleSurveyReader({ signal: new AbortController().signal }, { browser: f.dependencies })
  if (target === 'mr') await reader.readPage('lp', 1)
  transientAuthentication(f)
  await assert.rejects(reader.readPage(target, 1), terminal('authentication-unconfirmed'))
  assert.equal(f.stats().contextClosed, 1)
})

test('continued unconfirmed login and a later fatal error replace pending evidence and close once', async () => {
  for (const code of ['authentication-unconfirmed', 'page-mismatch'] as const) {
    const f = fixture(), evidence: { innerCode: string | null; diagnostics?: ParallelFetchReadDiagnostics }[] = []
    const reader = await createSampleSurveyReader({ signal: new AbortController().signal, onReadFailure(value) { evidence.push(value) } }, { browser: f.dependencies })
    await reader.readPage('lp', 1); transientAuthentication(f)
    await assert.rejects(reader.readPage('lp', 2), retryable('authentication-unconfirmed', 502))
    f.setNetwork([]); f.setError(new RankDistributionDomError(code))
    await assert.rejects(reader.readPage('lp', 2), terminal(code))
    await reader.close()
    assert.equal(evidence.length, 1); assert.equal(evidence[0].innerCode, code)
    assert.equal(evidence[0].diagnostics?.trace?.network.length, 0, 'final evidence does not reuse the initial 502')
    assert.equal(f.stats().contextClosed, 1)
  }
})

for (const finish of ['close', 'abort'] as const) test(`pending transient evidence is flushed once on ${finish} when the runner cannot retry`, async () => {
  const f = fixture(), evidence: { innerCode: string | null; diagnostics?: ParallelFetchReadDiagnostics }[] = [], controller = new AbortController()
  const reader = await createSampleSurveyReader({ signal: controller.signal, onReadFailure(value) {
    evidence.push(value); throw new Error('synthetic-private-log-failure')
  } }, { browser: f.dependencies })
  await reader.readPage('lp', 1); transientAuthentication(f)
  await assert.rejects(reader.readPage('lp', 2), retryable('authentication-unconfirmed', 502))
  assert.equal(evidence.length, 0)
  if (finish === 'abort') controller.abort()
  await reader.close(); await reader.close()
  assert.equal(evidence.length, 1); assert.equal(evidence[0].innerCode, 'authentication-unconfirmed')
  assert.equal(evidence[0].diagnostics?.trace?.network[0].status, 502)
  assert.equal(f.stats().contextClosed, 1)
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-cookie|synthetic-private-log-failure|"accountId"|"accountKey"|"salt"|profile\//)
})

test('only complete current-read transient evidence permits an authentication retry', async () => {
  const scenarios: { name: string; change(f: ReturnType<typeof fixture>): void; code?: string }[] = [
    { name: 'no transient response', change: f => f.setNetwork([]) },
    { name: 'foreign response', change: f => f.setNetwork([{ status: 502, site: 'https://example.com/unrelated' }]) },
    { name: 'image response', change: f => f.setNetwork([{ status: 502, resource: 'image' }]) },
    { name: 'unchecked protection headers', change: f => f.setNetwork([{ status: 502, headers: null }]) },
    { name: 'omitted events', change: f => f.setNetwork(Array.from({ length: 81 }, () => ({ status: 502 }))) },
    { name: 'login heading', change: f => f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: true, lastRankingReadable: true }) },
    { name: 'unreadable ranking', change: f => f.setReadDiagnostics({ lastAuthenticationEvidence: 'login-control', lastLoginRequiredHeading: false, lastRankingReadable: false }) },
    { name: 'missing header evidence', change: f => f.setReadDiagnostics(null) },
    { name: 'conflicting controls', change: f => f.setReadDiagnostics({ lastAuthenticationEvidence: 'conflicting-controls', lastLoginRequiredHeading: false, lastRankingReadable: true }) },
    ...[401, 403, 404, 429].map(status => ({ name: `subresource ${status}`, change: (f: ReturnType<typeof fixture>) => f.setNetwork([{ status: 502 }, { status }]) })),
    ...[401, 403, 429].map(status => ({ name: `main response ${status}`, change: (f: ReturnType<typeof fixture>) => f.setStatus(status), code: 'http-denied' })),
    { name: 'visible human verification', change: f => f.setChallenge(), code: 'human-verification' },
    { name: 'WAF CAPTCHA', change: f => f.setNetwork([{ status: 502 }, { status: 405, headers: { 'x-amzn-waf-action': 'captcha' } }]), code: 'human-verification' },
    ...(['login-required', 'condition-mismatch', 'page-mismatch', 'read-failed', 'timeout'] as const).map(code => ({ name: code, change: (f: ReturnType<typeof fixture>) => f.setError(new RankDistributionDomError(code)), code })),
  ]
  for (const scenario of scenarios) {
    const f = fixture(), reader = await createSampleSurveyReader({ signal: new AbortController().signal }, { browser: f.dependencies })
    await reader.readPage('lp', 1); transientAuthentication(f); scenario.change(f)
    await assert.rejects(reader.readPage('lp', 2), terminal(scenario.code ?? 'authentication-unconfirmed'), scenario.name)
    assert.equal(f.stats().contextClosed, 1, scenario.name)
    assert.ok(f.navigation.length <= 2, scenario.name)
  }
})

test('transient document eligibility requires the exact main response and checked protection evidence', async () => {
  for (const events of [[], [{ status: 502 }], [{ status: 503, resource: 'document' }], [{ status: 502, resource: 'document', headers: null }],
    [{ status: 502, resource: 'document' }, { status: 429 }]]) {
    const f = fixture(); f.setStatus(502); f.setError(new RankDistributionDomError('server-error')); f.setNetwork(events)
    const reader = await createSampleSurveyReader({ signal: new AbortController().signal }, { browser: f.dependencies })
    await assert.rejects(reader.readPage('lp', 1), terminal('server-error'))
    assert.equal(f.stats().contextClosed, 1)
  }
})

test('missing, omitted, post-stop and protected observation traces never enable recovery', async () => {
  const mutations: ((value: ParallelFetchReadDiagnostics) => void)[] = [
    value => { delete value.trace },
    value => { value.trace!.droppedObservations = 1 },
    value => { value.trace!.observations = [] },
    value => { value.trace!.observations[0].humanVerification = true },
    value => { value.trace!.observations[0].humanVerification = null },
    value => { value.trace!.observations[0].loginRequiredHeading = true },
    value => { value.trace!.observations[0].phase = 'after-stop' },
    value => { value.trace!.network[0].phase = 'after-stop' },
    value => { value.trace!.postStop = { durationMs: 0, outcome: 'not-run' } },
  ]
  for (const mutate of mutations) {
    const f = fixture()
    const reader = await createSampleSurveyReader({ signal: new AbortController().signal }, { browser: f.dependencies,
      async createSession(options, dependencies) {
        const session = await createParallelFetchBrowserSession(options, dependencies)
        return { ...session, async createReader(...args) {
          const inner = await session.createReader(...args)
          return { ...inner, async readPage(...args) {
            try { return await inner.readPage(...args) } catch (error) {
              assert.ok(error instanceof ParallelFetchReadError)
              const evidence = structuredClone(error.diagnostics!)
              mutate(evidence)
              throw new ParallelFetchReadError(error.code, error.httpStatus, evidence)
            }
          } }
        } }
      },
    })
    await reader.readPage('lp', 1); transientAuthentication(f)
    await assert.rejects(reader.readPage('lp', 2), terminal('authentication-unconfirmed'))
    assert.equal(f.stats().contextClosed, 1)
  }
})

test('private-row mismatches cannot be reclassified as transient even alongside a 502', async () => {
  const f = fixture(), reader = await createSampleSurveyReader({ signal: new AbortController().signal }, { browser: f.dependencies })
  await reader.readPage('lp', 1)
  f.setNetwork([{ status: 502 }]); f.mutate(value => { value.rows[0].value++ })
  await assert.rejects(reader.readPage('lp', 2), terminal('condition-mismatch'))
  assert.equal(f.stats().contextClosed, 1)
})

test('WAF CAPTCHA during private capture rejects promptly and closes before any late result', async () => {
  const f = fixture(), controller = new AbortController()
  let release!: () => void
  f.duringCapture(async page => {
    const request = { url: () => page.url(), resourceType: () => 'fetch' }
    const events = page as unknown as EventEmitter
    events.emit('request', request)
    events.emit('response', { request: () => request, status: () => 405, headers: () => ({ 'x-amzn-waf-action': 'captcha' }) })
    await new Promise<void>(resolve => { release = resolve })
  })
  const reader = await createSampleSurveyReader({ signal: controller.signal }, { browser: f.dependencies })
  await assert.rejects(reader.readPage('lp', 1), errorCode('human-verification'))
  assert.equal(f.stats().contextClosed, 1)
  release()
  await assert.rejects(reader.readPage('lp', 2), errorCode('cancelled'))
  assert.equal(f.navigation.length, 1)
})

test('abort while capturing closes the owned context and never accepts a late result', async () => {
  const f = fixture(), controller = new AbortController()
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.duringCapture(async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
  const reader = await createSampleSurveyReader({ signal: controller.signal }, { browser: f.dependencies })
  const pending = reader.readPage('lp', 1)
  await started; controller.abort()
  await assert.rejects(pending, errorCode('cancelled'))
  release(); await reader.close()
  assert.equal(f.stats().contextClosed, 1)
  assert.equal(f.stats().browserClosed, 1)
})

function domFixture(target: Target) {
  const element = (text = '', attributes: Record<string, string> = {}, children: Record<string, unknown[]> = {}) => ({
    innerText: text, parentElement: null, value: '1', currentSrc: '', complete: true, naturalWidth: 100,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    hasAttribute: (name: string) => Object.hasOwn(attributes, name), getAttribute: (name: string) => attributes[name] ?? null,
    closest: () => null, querySelectorAll: (selector: string) => children[selector] ?? [],
  })
  const points = element(target === 'lp' ? '12000LP' : '1600MR')
  const rank = element(); rank.currentSrc = 'https://www.streetfighter.com/6/buckler/assets/images/material/rank/rank16_l.png'
  const attributes = { href: '/6/buckler/ja-jp/profile/10001' }
  const link = element('private-player-name', attributes, { dd: [points], 'div[class*="ranking_league_rank_icon"] img': [rank] })
  const list = element('', {}, { 'a[href*="/profile/"]': [link], 'li > a[href*="/profile/"]': [link] })
  const nodes: Record<string, unknown[]> = {
    'a,button': [element('ログアウト')], 'h1,h2': [], p: [element('1 - 1 / 1')],
    select: Array.from({ length: target === 'lp' ? 6 : 5 }, () => element()),
    'ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])': [list],
  }
  return { attributes, rank, nodes, element,
    globals: { document: { querySelectorAll: (selector: string) => nodes[selector] ?? [] },
      location: { origin: 'https://www.streetfighter.com' },
      window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) } },
  }
}

test('rendered-row observer accepts exact official links and rejects login, foreign links and invalid rank assets', async t => {
  const names = ['document', 'window', 'location'] as const
  const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  t.after(() => { for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  } })
  for (const target of ['lp', 'mr'] as const) {
    const f = domFixture(target)
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: f.globals[name] })
    const capture = await observeSampleSurveyRows({ target, salt })
    assert.ok(capture)
    assert.deepEqual(capture.rows, [{ accountId: '10001', value: target === 'lp' ? 12000 : 1600, rankId: target === 'lp' ? 16 : null, accountKey: key('10001') }])
    assert.doesNotMatch(JSON.stringify(capture), /private-player-name|href|sourceUrl/)
    f.attributes.href = 'https://example.com/6/buckler/ja-jp/profile/10001'
    assert.equal(await observeSampleSurveyRows({ target, salt }), null)
    f.attributes.href = '/6/buckler/ja-jp/profile/10001'
    if (target === 'lp') {
      f.rank.currentSrc = 'https://example.com/6/buckler/assets/images/material/rank/rank16_l.png'
      assert.equal(await observeSampleSurveyRows({ target, salt }), null)
    }
    f.nodes['a,button'] = [f.element('ログイン')]
    assert.equal(await observeSampleSurveyRows({ target, salt }), null)
  }
})
