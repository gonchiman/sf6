import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname } from 'node:path'
import { createMrDistributionPrivateWriter, MR_DISTRIBUTION_CAPTURE_DIRECTORY,
  parseMrDistributionCaptureArguments, MrDistributionArgumentsError, runMrDistributionCollection } from './collect-mr-distribution.ts'
import type { MrDistributionCaptureDependencies, MrDistributionPrivateWriterIo } from './collect-mr-distribution.ts'
import type { MrDistributionDataset } from '../src/types/mrDistribution.ts'
import { MrDistributionDomError } from './lib/mr-distribution-dom.ts'
import type { MrDistributionDomErrorCode, MrDistributionPageReaderDiagnostics } from './lib/mr-distribution-dom.ts'

const SECRET = 'synthetic-private-mr-cookie'
const START = Date.parse('2026-10-16T08:00:00.000Z')
const options = { mode: 'collect' as const, maxRequests: 600, import: false }
function fixture(config: { failureCode?: MrDistributionDomErrorCode; failures?: number; failureAt?: number; httpStatus?: number; initialConfirmed?: boolean } = {}) {
  let clock = 0, closed = 0, imports = 0, failed = 0
  const requests: Array<{ page: number; url: string }> = [], waits: number[] = [], datasets: MrDistributionDataset[] = []
  const diagnostics: MrDistributionPageReaderDiagnostics = { requestCount: 0, successfulReadCount: 0, pageSize: 20, totalCount: 104,
    lastPage: null, lastAttemptedPage: null, lastHttpStatus: null, displayedConditionsConfirmed: true, currentActConfirmed: true,
    initialSignInConfirmed: config.initialConfirmed ?? true, lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false,
    lastRankingReadable: true, readableWithoutSignInReadCount: 0 }
  const deps: MrDistributionCaptureDependencies = {
    now: () => new Date(START + clock++),
    loadSession: async () => ({ cookies: [{ name: 'synthetic', value: SECRET, domain: '.streetfighter.com', path: '/',
      expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] }),
    launch: async state => {
      assert.equal(state.cookies[0].value, SECRET)
      return { fetchPage: async (page, sourceUrl) => {
        requests.push({ page, url: sourceUrl }); diagnostics.requestCount++
        diagnostics.lastAttemptedPage = page
        diagnostics.lastHttpStatus = null
        diagnostics.lastAuthenticationEvidence = null
        diagnostics.lastLoginRequiredHeading = null
        diagnostics.lastRankingReadable = null
        if (config.failureCode && diagnostics.requestCount >= (config.failureAt ?? 1) && failed++ < (config.failures ?? 1)) {
          diagnostics.lastHttpStatus = config.httpStatus ?? null
          throw new MrDistributionDomError(config.failureCode)
        }
        const from = (page - 1) * 20
        diagnostics.lastHttpStatus = 200
        diagnostics.lastAuthenticationEvidence = 'logout-control'
        diagnostics.lastLoginRequiredHeading = false
        diagnostics.lastRankingReadable = true
        diagnostics.successfulReadCount++
        diagnostics.lastPage = page
        return { sourceUrl, page, pageSize: 20, totalCount: 104, totalPages: 6,
          entries: Array.from({ length: Math.min(20, 104 - from) }, (_, i) => ({
            masterRating: (25 - Math.floor((from + i) / 4)) * 100, accountKey: `private-${from + i}`,
          })) }
      }, getDiagnostics: () => ({ ...diagnostics, rawCookie: SECRET }), close: async () => { closed++ } }
    },
    saveDataset: async data => { datasets.push(data); return `${MR_DISTRIBUTION_CAPTURE_DIRECTORY}/${data.id}.json` },
    importDataset: async path => { assert.ok(path.includes('max-mr-estimate-')); imports++ },
    wait: async ms => { waits.push(ms) },
  }
  return { deps, diagnostics, requests, waits, datasets, closed: () => closed, imports: () => imports }
}

test('CLI is local-save by default and permits only bounded read count plus explicit import', () => {
  assert.deepEqual(parseMrDistributionCaptureArguments(['--collect']), options)
  assert.deepEqual(parseMrDistributionCaptureArguments(['--collect', '--import', '--max-requests', '400']), { ...options, maxRequests: 400, import: true })
  assert.deepEqual(parseMrDistributionCaptureArguments(['--help']), { mode: 'help' })
  for (const args of [[], ['--saved-session'], ['--collect', '--import', '--import'], ['--collect', '--resume'],
    ['--collect', '--max-requests', '601'], ['--collect', '--max-requests', '02'], ['--collect', '--output', SECRET]]) {
    assert.throws(() => parseMrDistributionCaptureArguments(args), error => error instanceof MrDistributionArgumentsError && !error.message.includes(SECRET))
  }
})

test('complete synthetic collection saves one aggregate, closes the browser and imports only when requested', async () => {
  for (const imported of [false, true]) {
    const setup = fixture()
    const report = await runMrDistributionCollection({ ...options, import: imported }, setup.deps)
    assert.equal(report.status, 'succeeded')
    assert.equal(report.confirmedBoundaryCount, 25)
    assert.equal(report.datasetSaved, true)
    assert.equal(report.imported, imported)
    assert.equal(report.initialSignInConfirmed, true)
    assert.equal(report.browserClosed, true)
    assert.equal(setup.closed(), 1)
    assert.equal(setup.imports(), Number(imported))
    assert.equal(setup.datasets.length, 1)
    assert.equal(setup.datasets[0].entries.reduce((total, value) => total + value.count, 0), 104)
    assert.doesNotMatch(JSON.stringify([report, setup.datasets]), /synthetic-private-mr-cookie|rawCookie|accountKey|private-/)
  }
})

test('one same-URL reread recovers transient hydration while explicit denial and login headings are never retried', async () => {
  for (const code of ['read-failed', 'authentication-unconfirmed', 'server-error', 'http-denied', 'login-required', 'human-verification'] as const) {
    const setup = fixture({ failureCode: code })
    const report = await runMrDistributionCollection(options, setup.deps)
    const retryable = ['read-failed', 'authentication-unconfirmed', 'server-error'].includes(code)
    assert.equal(report.status, retryable ? 'succeeded' : 'failed')
    assert.equal(report.retryCount, Number(retryable))
    assert.equal(report.readFailureCode, code)
    if (retryable) { assert.deepEqual(setup.requests[0], setup.requests[1]); assert.equal(setup.waits[0], code === 'server-error' ? 5000 : 500) }
    else { assert.equal(setup.requests.length, 1); assert.equal(setup.datasets.length, 0) }
    assert.equal(setup.closed(), 1)
  }
  const persistent = fixture({ failureCode: 'read-failed', failures: 2 })
  const failed = await runMrDistributionCollection(options, persistent.deps)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.requestCount, 2)
  assert.equal(failed.retryCount, 1)
  assert.equal(persistent.datasets.length, 0)
})

test('initial authentication evidence, request bounds and aborts prevent incomplete saves', async () => {
  const anonymous = fixture({ initialConfirmed: false })
  assert.equal((await runMrDistributionCollection(options, anonymous.deps)).status, 'failed')
  assert.equal(anonymous.datasets.length, 0)
  const bounded = fixture()
  const result = await runMrDistributionCollection({ ...options, maxRequests: 2 }, bounded.deps)
  assert.equal(result.reason, 'request-limit')
  assert.equal(bounded.requests.length, 2)
  assert.equal(bounded.datasets.length, 0)
  const aborted = fixture(); aborted.deps.signal = AbortSignal.abort()
  assert.equal((await runMrDistributionCollection(options, aborted.deps)).reason, 'cancelled')
  assert.equal(aborted.requests.length, 0)
})

test('HTTP 404 retains the failed page and last successful page without attributing earlier DOM evidence to the failure', async () => {
  const setup = fixture({ failureCode: 'http-error', failureAt: 3, httpStatus: 404 })
  const report = await runMrDistributionCollection(options, setup.deps)
  assert.equal(report.status, 'failed')
  assert.equal(report.readFailureCode, 'http-error')
  assert.equal(report.requestCount, 3)
  assert.equal(report.successfulReadCount, 2)
  assert.equal(report.retryCount, 0)
  assert.deepEqual(report.diagnostics, { lastAttemptedPage: setup.requests[2].page,
    lastSuccessfulPage: setup.requests[1].page, lastHttpStatus: 404, lastAuthenticationEvidence: null,
    lastLoginRequiredHeading: null, lastRankingReadable: null })
  assert.equal(report.initialSignInConfirmed, true)
  assert.equal(report.browserClosed, true)
  assert.equal(setup.datasets.length, 0)
  assert.deepEqual(setup.waits, [])
  assert.doesNotMatch(JSON.stringify(report), /synthetic-private-mr-cookie|rawCookie|accountKey|https?:/)
})

test('capture diagnostics retain only validated scalar evidence, not arbitrary transport metadata', async () => {
  for (const value of [SECRET, '503', -1, 0, 99, 600, 200.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity,
    null, undefined, 200, 503, 16000]) {
    const setup = fixture()
    const launch = setup.deps.launch
    setup.deps.launch = async (...args) => {
      const transport = await launch(...args)
      return { ...transport, getDiagnostics: () => ({ ...transport.getDiagnostics(), lastAttemptedPage: value,
        lastPage: value, lastHttpStatus: value, lastAuthenticationEvidence: SECRET,
        lastLoginRequiredHeading: SECRET, lastRankingReadable: { raw: SECRET }, url: SECRET, html: SECRET,
        cookies: [SECRET] } as unknown as MrDistributionPageReaderDiagnostics) }
    }
    const report = await runMrDistributionCollection(options, setup.deps)
    const safeInteger = typeof value === 'number' && Number.isSafeInteger(value)
    assert.equal(report.status, 'succeeded')
    assert.deepEqual(report.diagnostics, {
      lastAttemptedPage: safeInteger && value >= 1 ? value : null,
      lastSuccessfulPage: safeInteger && value >= 1 ? value : null,
      lastHttpStatus: safeInteger && value >= 100 && value <= 599 ? value : null,
      lastAuthenticationEvidence: null, lastLoginRequiredHeading: null, lastRankingReadable: null,
    })
    assert.doesNotMatch(JSON.stringify(report), /synthetic-private-mr-cookie|rawCookie|cookies|html|accountKey/)
  }
})

test('a diagnostic reader failure preserves the collection failure and closes the browser without private error text', async () => {
  const setup = fixture({ failureCode: 'http-error', httpStatus: 404 })
  const launch = setup.deps.launch
  setup.deps.launch = async (...args) => {
    const transport = await launch(...args)
    return { ...transport, getDiagnostics: () => { throw new Error(SECRET) } }
  }
  const report = await runMrDistributionCollection(options, setup.deps)
  assert.equal(report.status, 'failed')
  assert.equal(report.readFailureCode, 'http-error')
  assert.equal(report.browserClosed, true)
  assert.equal(setup.closed(), 1)
  assert.deepEqual(report.diagnostics, { lastAttemptedPage: null, lastSuccessfulPage: null, lastHttpStatus: null,
    lastAuthenticationEvidence: null, lastLoginRequiredHeading: null, lastRankingReadable: null })
  assert.equal(JSON.stringify(report).includes(SECRET), false)
})

test('human-verification evidence reaches the failed report and never triggers another request', async () => {
  for (const humanVerification of [
    { wafHeaderChecked: true, wafAction: 'captcha' as const, domDetected: null },
    { wafHeaderChecked: true, wafAction: 'challenge' as const, domDetected: null },
    { wafHeaderChecked: true, wafAction: null, domDetected: true },
  ]) {
    const setup = fixture({ failureCode: 'human-verification', failureAt: 3, httpStatus: humanVerification.domDetected ? 200 : 405 })
    setup.diagnostics.humanVerification = humanVerification
    const report = await runMrDistributionCollection(options, setup.deps)
    assert.equal(report.status, 'failed')
    assert.equal(report.readFailureCode, 'human-verification')
    assert.equal(report.requestCount, 3)
    assert.equal(report.successfulReadCount, 2)
    assert.equal(report.retryCount, 0)
    assert.deepEqual(report.diagnostics?.humanVerification, humanVerification)
    assert.equal(report.diagnostics?.lastHttpStatus, humanVerification.domDetected ? 200 : 405)
    assert.equal(report.datasetSaved, false)
    assert.equal(report.browserClosed, true)
    assert.equal(setup.datasets.length, 0)
    assert.deepEqual(setup.waits, [])
    assert.doesNotMatch(JSON.stringify(report), /synthetic-private-mr-cookie|rawCookie|accountKey|https?:/)
  }
})

test('challenge diagnostics omit old observations and copy only normalized evidence from newer readers', async () => {
  const legacy = await runMrDistributionCollection(options, fixture().deps)
  assert.equal(Object.hasOwn(legacy.diagnostics!, 'humanVerification'), false)
  const cases = [
    { input: { wafHeaderChecked: true, wafAction: null, domDetected: false }, expected: { wafHeaderChecked: true, wafAction: null, domDetected: false } },
    { input: { wafHeaderChecked: false, wafAction: null, domDetected: null }, expected: { wafHeaderChecked: false, wafAction: null, domDetected: null } },
    { input: { wafHeaderChecked: true, wafAction: 'captcha', domDetected: null, headers: { cookie: SECRET }, html: SECRET, url: SECRET },
      expected: { wafHeaderChecked: true, wafAction: 'captcha', domDetected: null } },
    { input: { wafHeaderChecked: true, wafAction: SECRET, domDetected: SECRET }, expected: { wafHeaderChecked: true, wafAction: null, domDetected: null } },
    { input: { wafHeaderChecked: 'true', wafAction: 'captcha', domDetected: 1 }, expected: { wafHeaderChecked: false, wafAction: null, domDetected: null } },
    { input: { wafHeaderChecked: false, wafAction: 'challenge', domDetected: true }, expected: { wafHeaderChecked: false, wafAction: null, domDetected: true } },
    { input: null, expected: { wafHeaderChecked: false, wafAction: null, domDetected: null } },
  ]
  for (const { input, expected } of cases) {
    const setup = fixture({ failureCode: 'http-error', httpStatus: 405 })
    setup.diagnostics.humanVerification = input as unknown as MrDistributionPageReaderDiagnostics['humanVerification']
    const report = await runMrDistributionCollection(options, setup.deps)
    assert.deepEqual(report.diagnostics?.humanVerification, expected)
    assert.doesNotMatch(JSON.stringify(report), /synthetic-private-mr-cookie|headers|cookie|html|url/)
  }
})

test('authentication, save and import errors are fixed classifications without private text', async () => {
  for (const stage of ['authentication', 'dataset-save', 'import'] as const) {
    const setup = fixture()
    if (stage === 'authentication') setup.deps.loadSession = async () => { throw new Error(SECRET) }
    if (stage === 'dataset-save') setup.deps.saveDataset = async () => { throw new Error(SECRET) }
    if (stage === 'import') setup.deps.importDataset = async () => { throw new Error(SECRET) }
    const report = await runMrDistributionCollection({ ...options, import: true }, setup.deps)
    assert.equal(report.status, 'failed')
    assert.equal(report.reason, stage === 'authentication' ? 'authentication-unavailable' : stage === 'dataset-save' ? 'dataset-save-failed' : 'import-failed')
    assert.equal(JSON.stringify(report).includes(SECRET), false)
    assert.equal(report.imported, false)
  }
})

test('fixed private writer rejects links, overwrite and unknown identity fields without touching auth or arbitrary paths', async () => {
  const setup = fixture()
  await runMrDistributionCollection(options, setup.deps)
  const dataset = setup.datasets[0]
  const directories = new Map<string, { directory: boolean; symbolicLink: boolean }>()
  for (let current = dirname(MR_DISTRIBUTION_CAPTURE_DIRECTORY); ; current = dirname(current)) {
    directories.set(current, { directory: true, symbolicLink: false })
    if (current === dirname(current)) break
  }
  const files = new Map<string, string>()
  const io: MrDistributionPrivateWriterIo = {
    inspect: async path => directories.get(path) ?? (files.has(path) ? { directory: false, symbolicLink: false } : null),
    mkdir: async path => { directories.set(path, { directory: true, symbolicLink: false }) },
    write: async (path, text) => { assert.equal(files.has(path), false); files.set(path, text) },
  }
  const writer = createMrDistributionPrivateWriter(io)
  const path = await writer(dataset)
  assert.ok(path.startsWith(MR_DISTRIBUTION_CAPTURE_DIRECTORY))
  assert.equal(files.size, 1)
  assert.doesNotMatch([...files.values()][0], /accountKey|cookies|synthetic-private-mr-cookie/)
  await assert.rejects(writer(dataset))
  await assert.rejects(writer({ ...dataset, accountKey: SECRET } as MrDistributionDataset))
  directories.set(MR_DISTRIBUTION_CAPTURE_DIRECTORY, { directory: true, symbolicLink: true })
  await assert.rejects(writer(dataset))
  assert.equal(files.size, 1)
})
