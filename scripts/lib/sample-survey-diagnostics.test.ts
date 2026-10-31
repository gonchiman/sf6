import assert from 'node:assert/strict'
import test from 'node:test'
import type { Page } from 'playwright'
import { ParallelFetchReadError } from './parallel-fetch-runner.ts'
import { SampleSurveyReadError } from './sample-survey-reader.ts'
import { createSampleSurveyDiagnostics, serializeSampleSurveyFailureDiagnostic, serializeSampleSurveyReadRetry, SAMPLE_SURVEY_DIAGNOSTIC_MAX_BYTES } from './sample-survey-diagnostics.ts'

const secret = 'private-cookie-profile-id-and-url'
const retry = { at: '2026-10-30T12:00:00.000Z', target: 'lp', page: 130877, attempt: 21,
  retryNumber: 1, code: 'authentication-unconfirmed', httpStatus: 502, delayMs: 30000 }

test('retry diagnostics whitelist bounded values without exporting failed rows or authentication details', () => {
  for (const retryNumber of [1, 2, 3]) {
    for (const code of ['authentication-unconfirmed', 'server-error']) {
      for (const httpStatus of code === 'authentication-unconfirmed' ? [200, 502, 503, 504] : [502, 503, 504]) {
        const line = serializeSampleSurveyReadRetry({ ...retry, code, retryNumber, httpStatus, accountId: secret, cookie: secret, url: secret, message: secret })!
        assert.deepEqual(JSON.parse(line), { sampleSurveyReadRetry: { ...retry, code, retryNumber, httpStatus } })
        assert.ok(!line.includes(secret)); assert.ok(Buffer.byteLength(line) < 1024)
      }
    }
  }
})

test('unsupported retry evidence and hostile getters cannot be written as a recovery event', () => {
  for (const patch of [{ at: '2026-02-30T00:00:00.000Z' }, { target: secret }, { page: -1 }, { page: 1.5 },
    { attempt: 0 }, { retryNumber: 0 }, { retryNumber: 4 }, { retryNumber: 1.5 }, { retryNumber: '2' },
    { code: 'human-verification' }, { httpStatus: 403 }, { httpStatus: 429 }, { httpStatus: 500 },
    { code: 'server-error', httpStatus: 200 }, { delayMs: 0 }]) {
    assert.equal(serializeSampleSurveyReadRetry({ ...retry, ...patch }), null)
  }
  for (const value of [null, [], {}, { get at() { throw new Error(secret) } }]) {
    assert.equal(serializeSampleSurveyReadRetry(value), null)
  }
})
function fakePage(options: { value?: unknown; gotoError?: unknown; evaluateError?: unknown; status?: number } = {}): Page {
  return { goto: async () => { if (options.gotoError) throw options.gotoError; return { status: () => options.status ?? 200 } },
    evaluate: async () => { if (options.evaluateError) throw options.evaluateError; return options.value },
    url: () => `https://example.test/${secret}` } as unknown as Page
}

test('diagnostics preserve reading results but only record fixed safe observation fields', async () => {
  const value = { maintenance: false, loginRequired: false, signedIn: true, authenticationEvidence: 'logout-control',
    loginRequiredHeading: false, conditionsMatch: true, leagueLabelsMatch: true, currentActMatch: null,
    selectedPage: 2, range: { from: 21, to: 40, total: 100, secret }, rankIcons: 'ready',
    entries: [{ accountId: secret, name: secret, value: 12000 }], cookies: secret, url: secret }
  const recorder = createSampleSurveyDiagnostics(), page = recorder.wrapPage(fakePage({ value }), 'lp')
  const response = await page.goto(`https://example.test/${secret}`)
  assert.equal(response!.status(), 200)
  assert.equal(await page.evaluate(() => secret, { secret }), value)
  assert.ok(page.url().includes(secret))
  recorder.mark('capture-start'); recorder.mark('capture-complete')
  const result = recorder.failure(new SampleSurveyReadError('read-failed'))
  assert.equal(result.innerCode, 'read-failed'); assert.equal(result.httpStatus, 200)
  assert.equal(result.capture, 'complete')
  const summary = result.events.find(event => event.observation)?.observation
  assert.deepEqual(summary, { maintenance: false, loginRequired: false, signedIn: true, loginRequiredHeading: false,
    conditionsMatch: true, leagueLabelsMatch: true, currentActMatch: null, authenticationEvidence: 'logout-control',
    selectedPage: 2, range: { from: 21, to: 40, total: 100 }, rankIcons: 'ready', entryCount: 1 })
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(result.events.every(event => event.elapsedMs >= 0 && event.elapsedMs <= 7 * 86400000))
})

for (const [error, failureKind, networkCode] of [
  [new Error(`page.goto: net::ERR_CONNECTION_RESET at https://example.test/${secret}`), 'network', 'ERR_CONNECTION_RESET'],
  [new Error(`net::ERR_NOT_A_SUPPORTED_CODE ${secret}`), 'other', undefined],
  [new Error(`page.evaluate: ReferenceError: __name is not defined ${secret}`), 'undefined-helper', undefined],
  [new ReferenceError(secret), 'reference-error', undefined],
  [new Error(`page.evaluate: TypeError: ${secret}`), 'type-error', undefined],
  [new Error(`Target page, context or browser has been closed ${secret}`), 'browser-closed', undefined],
  [Object.assign(new Error(secret), { name: 'TimeoutError' }), 'timeout', undefined],
  [secret, 'other', undefined],
] as const) test(`safe failure classification: ${failureKind} ${networkCode ?? ''}`, async () => {
  const recorder = createSampleSurveyDiagnostics(), page = recorder.wrapPage(fakePage({ gotoError: error }), 'mr')
  await assert.rejects(page.goto(`https://example.test/${secret}`), candidate => candidate === error)
  // The wrapper retains the original category even when a downstream reader sanitizes the error.
  const result = recorder.failure(new SampleSurveyReadError('read-failed'))
  assert.equal(result.failureKind, failureKind); assert.equal(result.networkCode, networkCode)
  assert.equal(result.events.at(-1)?.stage, 'navigation')
  assert.equal(result.events.at(-1)?.outcome, 'failed')
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('a failed DOM evaluation is distinguishable from a completed navigation', async () => {
  const error = new Error(`page.evaluate: ReferenceError: __name is not defined ${secret}`)
  const recorder = createSampleSurveyDiagnostics(), page = recorder.wrapPage(fakePage({ evaluateError: error }), 'lp')
  await page.goto('https://example.test/')
  await assert.rejects(page.evaluate(() => null), candidate => candidate === error)
  const result = recorder.failure(new ParallelFetchReadError('read-failed'))
  assert.equal(result.failureKind, 'undefined-helper'); assert.equal(result.httpStatus, 200)
  assert.equal(result.events.at(-1)?.stage, 'ranking-evaluate')
  assert.equal(result.events.at(-1)?.outcome, 'failed')
})

test('existing ParallelFetch status and sanitized diagnostics survive without arbitrary properties', () => {
  const recorder = createSampleSurveyDiagnostics()
  const error = new ParallelFetchReadError('authentication-unconfirmed', 200, {
    authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: false,
  })
  Object.assign(error.diagnostics!, { secret, accountId: secret })
  const result = recorder.failure(error)
  assert.equal(result.innerCode, 'authentication-unconfirmed'); assert.equal(result.httpStatus, 200)
  assert.deepEqual(result.diagnostics, { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: false })
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('events are bounded, returned snapshots are isolated, and a new navigation clears earlier failures', async () => {
  const recorder = createSampleSurveyDiagnostics(), page = recorder.wrapPage(fakePage({ value: { entries: null } }), 'lp')
  for (let index = 0; index < 30; index++) await page.evaluate(() => null)
  const snapshot = recorder.failure(null)
  assert.equal(snapshot.events.length, 32); assert.equal(snapshot.droppedEvents, 28)
  snapshot.events.length = 0
  assert.equal(recorder.failure(null).events.length, 32)
  recorder.mark('capture-start')
  await page.goto('https://example.test/')
  assert.equal(recorder.failure(null).capture, 'not-started')
  assert.equal(recorder.failure(null).failureKind, 'other')
})

test('malformed fields and arbitrary error-like objects do not enter records', async () => {
  const value = { maintenance: secret, authenticationEvidence: { toString: () => 'logout-control', secret },
    rankIcons: { toString: () => 'ready', secret }, selectedPage: -1,
    range: { from: 1, to: secret, total: 5 }, entries: secret }
  const recorder = createSampleSurveyDiagnostics(), page = recorder.wrapPage(fakePage({ value, status: 999 }), 'lp')
  await page.goto('https://example.test/'); await page.evaluate(() => null)
  const result = recorder.failure({ message: secret, code: secret, diagnostics: { secret } })
  assert.equal(result.innerCode, null); assert.equal(result.httpStatus, null)
  assert.ok(result.events.every(event => event.observation === undefined))
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('cloud log serialization rebuilds bounded safe fields including the existing network trace', () => {
  const event = { elapsedMs: 15, stage: 'ranking-evaluate', outcome: 'complete', target: 'lp',
    observation: { signedIn: false, authenticationEvidence: 'login-control', loginRequiredHeading: false,
      selectedPage: 123, range: { from: 2441, to: 2460, total: 3100000, url: secret }, entryCount: 20,
      html: secret, cookies: secret }, url: secret }
  const input = { schemaVersion: 1, capturedAt: '2026-10-29T03:39:00.180Z', innerCode: 'authentication-unconfirmed',
    httpStatus: 200, capture: 'not-started', failureKind: 'network', networkCode: 'ERR_CONNECTION_RESET',
    diagnostics: { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: false, secret,
      trace: { observations: [{ elapsedMs: 15, phase: 'read', authenticationEvidence: 'login-control', loginRequiredHeading: false,
        rankingReadable: false, humanVerification: false, accountId: secret }],
      network: [{ elapsedMs: 5, phase: 'read', kind: 'http-error', resource: 'fetch', site: 'buckler', status: 502, url: secret }],
      droppedObservations: 0, droppedNetworkEvents: 0, headers: secret } },
    events: [event], droppedEvents: 0, cookies: secret, accountId: secret, message: secret, toJSON: () => secret }
  const line = serializeSampleSurveyFailureDiagnostic(input)!
  assert.ok(line && Buffer.byteLength(line) <= SAMPLE_SURVEY_DIAGNOSTIC_MAX_BYTES)
  assert.doesNotMatch(line, new RegExp(secret)); assert.doesNotMatch(line, /\n/)
  const result = JSON.parse(line).sampleSurveyFailureDiagnostic
  assert.equal(result.innerCode, 'authentication-unconfirmed'); assert.equal(result.httpStatus, 200)
  assert.equal(result.networkCode, 'ERR_CONNECTION_RESET')
  assert.equal(result.events[0].observation.entryCount, 20)
  assert.equal(result.diagnostics.trace.network[0].status, 502)
  assert.deepEqual(Object.keys(result.diagnostics.trace.network[0]), ['elapsedMs', 'phase', 'kind', 'resource', 'site', 'status'])
  assert.equal(Object.hasOwn(result, 'cookies'), false)
})

test('cloud diagnostic output retains at most 32 events and drops malformed or unsupported values', () => {
  const input = { schemaVersion: 1, capturedAt: '2026-10-29T03:39:00.180Z', innerCode: secret, httpStatus: 999,
    failureKind: secret, networkCode: secret, capture: secret, diagnostics: { authenticationEvidence: secret }, droppedEvents: 7,
    events: Array.from({ length: 80 }, (_, elapsedMs) => ({ elapsedMs, stage: 'navigation', outcome: 'complete',
      target: secret, httpStatus: 200, networkCode: secret, payload: secret.repeat(10000) })) }
  const line = serializeSampleSurveyFailureDiagnostic(input)!
  assert.ok(Buffer.byteLength(line) <= SAMPLE_SURVEY_DIAGNOSTIC_MAX_BYTES)
  assert.ok(!line.includes(secret))
  const result = JSON.parse(line).sampleSurveyFailureDiagnostic
  assert.equal(result.events.length, 32); assert.equal(result.events[0].elapsedMs, 48); assert.equal(result.droppedEvents, 55)
  assert.equal(result.innerCode, null); assert.equal(result.httpStatus, null); assert.equal(result.failureKind, 'other')
  assert.equal(result.capture, 'not-started'); assert.equal(result.diagnostics, undefined)
  const badEvents = JSON.parse(serializeSampleSurveyFailureDiagnostic({ ...input, droppedEvents: -1,
    events: [null, { elapsedMs: -1, stage: 'navigation', outcome: 'complete' }] })!).sampleSurveyFailureDiagnostic
  assert.equal(badEvents.events.length, 0); assert.equal(badEvents.droppedEvents, 2)
})

test('broken callback payloads and hostile getters cannot escape through the serializer', () => {
  for (const value of [null, [], secret, {}, { schemaVersion: 1, capturedAt: secret, events: [] },
    { schemaVersion: 1, capturedAt: '2026-02-30T00:00:00.000Z', events: [] },
    { get schemaVersion() { throw new Error(secret) } }]) assert.equal(serializeSampleSurveyFailureDiagnostic(value), null)
  let reads = 0
  const line = serializeSampleSurveyFailureDiagnostic({ schemaVersion: 1,
    get capturedAt() { return reads++ === 0 ? '2026-10-29T03:39:00.180Z' : secret }, events: [] })!
  assert.equal(reads, 1); assert.ok(line && !line.includes(secret))
})
