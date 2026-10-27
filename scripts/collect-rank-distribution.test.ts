import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import type { RankDistributionDataset } from '../src/types/rankDistribution.ts'
import { parseRankDistributionDataset } from '../src/lib/rankDistribution.ts'
import { createRankDistributionPageReader, RankDistributionDomError } from './lib/rank-distribution-dom.ts'
import type { RankBoundaryPage } from './lib/rank-distribution-boundaries.ts'
import type { RankDistributionPageReaderDiagnostics } from './lib/rank-distribution-dom.ts'
import { RANK_BOUNDARY_SOURCE_URL } from './lib/rank-distribution-boundaries.ts'
import type { RankDistributionCheckpoint } from './lib/rank-distribution-checkpoint.ts'
import {
  createRankDistributionPrivateWriter, disableRankDistributionDiagnostics, parseRankDistributionCaptureArguments,
  RANK_DISTRIBUTION_CAPTURE_DIRECTORY, runRankDistributionCollection,
} from './collect-rank-distribution.ts'
import type {
  RankDistributionCaptureDependencies, RankDistributionCaptureReport, RankDistributionPrivateFileInfo, RankDistributionPrivateWriterIo,
} from './collect-rank-distribution.ts'

const startedAt = '2026-10-15T10:00:00.000Z'
const options = { mode: 'collect' as const, maxRequests: 600, accuracy: 'strict' as const }
const estimateOptions = { mode: 'collect' as const, maxRequests: 600, accuracy: 'estimate' as const }
// Entirely synthetic rows, identities and state; these are never real population or authentication data.
function fixture() {
  const values = Array.from({ length: 36 }, (_, index) => 36 - index).flatMap(rankId => [1, 0].map(offset => ({
    rankId, leaguePoint: rankId * 100 + offset,
  }))).map((entry, index) => ({ ...entry, accountKey: index.toString(16).padStart(64, '0') }))
  const diagnostics: RankDistributionPageReaderDiagnostics & {
    lastObservedTotal: number | null; lastAttemptedPage: number | null; lastHttpStatus: number | null
  } = {
    requestCount: 0, successfulReadCount: 0, pageSize: null, totalCount: null, lastPage: null,
    rankMappingConfirmed: false, leagueLabelsConfirmed: false, displayedConditionsConfirmed: false,
    userStatusEvidence: 'fixed-url-only', observedRankIds: [], tailRankIds: [], lastObservedTotal: null,
    lastAttemptedPage: null, lastHttpStatus: null,
  }
  const calls = { load: 0, launch: 0, close: 0, save: 0, publish: 0, availability: 0, report: 0 }
  const requests: number[] = []
  const saved: RankDistributionDataset[] = []
  const reports: RankDistributionCaptureReport[] = []
  const statuses: Array<{ status: string; reason: string; checkedAt: string }> = []
  const progress: unknown[] = []
  const launchAccuracies: Array<'strict' | 'estimate' | undefined> = []
  const waits: number[] = []
  let clock = 0
  const fetchPage = async (page: number, sourceUrl: string): Promise<RankBoundaryPage> => {
    requests.push(page)
    const value = { sourceUrl, page, pageSize: 5, totalCount: values.length, totalPages: Math.ceil(values.length / 5),
      entries: structuredClone(values.slice((page - 1) * 5, page * 5)) }
    diagnostics.requestCount++
    diagnostics.successfulReadCount++
    diagnostics.pageSize = value.pageSize
    diagnostics.totalCount = value.totalCount
    diagnostics.lastPage = page
    diagnostics.lastAttemptedPage = page
    diagnostics.lastObservedTotal = value.totalCount
    diagnostics.lastHttpStatus = 200
    diagnostics.rankMappingConfirmed = true
    diagnostics.leagueLabelsConfirmed = true
    diagnostics.displayedConditionsConfirmed = true
    diagnostics.observedRankIds = [...new Set([...diagnostics.observedRankIds, ...value.entries.map(entry => entry.rankId)])].sort((a, b) => a - b)
    if (page === value.totalPages) diagnostics.tailRankIds = [...new Set(value.entries.map(entry => entry.rankId))].sort((a, b) => a - b)
    return value
  }
  const transport = {
    fetchPage,
    getDiagnostics: () => ({ ...diagnostics, rows: values, privateDOM: '<div>private diagnostic DOM</div>', cookie: 'private diagnostic cookie' }),
    close: async () => { calls.close++ },
  }
  const deps: RankDistributionCaptureDependencies = {
    loadSession: async () => { calls.load++; return { cookies: [{ name: 'synthetic', value: 'private-auth-value', domain: 'www.streetfighter.com',
      path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] } },
    launch: async (_state, _signal, accuracy) => { calls.launch++; launchAccuracies.push(accuracy); return transport },
    saveDataset: async value => { calls.save++; saved.push(value); return resolve('.local/rank-distribution', `${value.id}.json`) },
    publish: async () => { calls.publish++ },
    recordAvailability: async value => { calls.availability++; statuses.push(value) },
    writeReport: async value => { calls.report++; reports.push(value) },
    now: () => new Date(Date.parse(startedAt) + clock++ * 1000),
    progress: value => { progress.push(value) },
    wait: async (milliseconds, signal) => { waits.push(milliseconds); signal.throwIfAborted() },
  }
  return { values, diagnostics, calls, requests, saved, reports, statuses, progress, launchAccuracies, waits, fetchPage, transport, deps }
}

test('strict CLI accepts one collection mode and bounded integers, with help alone', () => {
  assert.deepEqual(parseRankDistributionCaptureArguments(['--collect']), estimateOptions)
  assert.deepEqual(parseRankDistributionCaptureArguments(['--collect', '--strict']), options)
  assert.deepEqual(parseRankDistributionCaptureArguments(['--collect', '--max-requests', '2']), { mode: 'collect', maxRequests: 2, accuracy: 'estimate' })
  assert.deepEqual(parseRankDistributionCaptureArguments(['--collect', '--max-requests', '1000']), { mode: 'collect', maxRequests: 1000, accuracy: 'estimate' })
  assert.deepEqual(parseRankDistributionCaptureArguments(['--collect', '--strict', '--max-requests', '20']), { mode: 'collect', maxRequests: 20, accuracy: 'strict' })
  assert.deepEqual(parseRankDistributionCaptureArguments(['--collect', '--max-requests', '20', '--strict']), { mode: 'collect', maxRequests: 20, accuracy: 'strict' })
  assert.deepEqual(parseRankDistributionCaptureArguments(['--help']), { mode: 'help' })
  assert.deepEqual(parseRankDistributionCaptureArguments(['--collect', '--resume']), { ...estimateOptions, resume: true })
  assert.deepEqual(parseRankDistributionCaptureArguments(['--collect', '--max-requests', '20', '--resume']), { ...estimateOptions, maxRequests: 20, resume: true })
  for (const args of [[], ['--collect', '--collect'], ['--help', '--collect'], ['--collect', '--browser', 'chrome'],
    ['--collect', '--url', 'https://example.com'], ['--collect', '--path', 'private'], ['--collect', '--max-requests', '1'],
    ['--collect', '--max-requests', '1001'], ['--collect', '--max-requests', '02'], ['--collect', '--max-requests', '2.5'],
    ['--collect', '--max-requests', '2', '--max-requests', '3'], ['--max-requests', '10', '--collect'],
    ['--collect', '--strict', '--strict'], ['--collect', '--resume', '--resume'],
    ['--collect', '--strict', '--resume'], ['--collect', '--resume', '--strict']]) {
    assert.throws(() => parseRankDistributionCaptureArguments(args), error => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes('https://example.com'))
      assert.ok(!error.message.includes('private'))
      return true
    })
  }
})

function syntheticCheckpoint(): RankDistributionCheckpoint {
  const savedAt = '2026-10-15T09:59:59.000Z'
  return { schemaVersion: 1, method: 'boundary-search-estimate', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
    pageSize: 5, savedAt, hints: Array.from({ length: 5 }, (_, index) => ({
      rankId: index + 2, countAtOrAbove: (35 - index) * 2, totalCount: 72, observedAt: savedAt,
    })) }
}

test('resume uses saved positions only as hints and publishes only all newly confirmed boundaries', async () => {
  const input = fixture()
  const checkpoint = syntheticCheckpoint()
  let loads = 0
  const checkpoints: RankDistributionCheckpoint[] = []
  input.deps.loadCheckpoint = async () => { loads++; return checkpoint }
  input.deps.saveCheckpoint = async value => { checkpoints.push(structuredClone(value)); return value }
  const report = await runRankDistributionCollection({ ...estimateOptions, resume: true }, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(loads, 1)
  assert.equal(report.resumeRequested, true)
  assert.equal(report.checkpointLoaded, true)
  assert.equal(report.checkpointSaved, true)
  assert.equal(report.checkpointHintCount, 35)
  assert.equal(report.confirmedBoundaryCount, 35)
  assert.equal(checkpoints.length, 35)
  assert.ok(checkpoints[0].hints.length > checkpoint.hints.length)
  assert.equal(input.saved[0].captureStartedAt, startedAt)
  assert.ok(input.saved[0].observation!.boundaries.every(value => value.observedAt >= startedAt))
  assert.deepEqual(parseRankDistributionDataset(input.saved[0]), input.saved[0])
})

test('a stopped capture keeps safe hints for a separate process without publishing partial data', async () => {
  const first = fixture()
  const controller = new AbortController()
  first.deps.signal = controller.signal
  let persisted: RankDistributionCheckpoint | null = null
  first.deps.saveCheckpoint = async value => {
    persisted = structuredClone(value)
    if (value.hints.length === 5) controller.abort()
    return value
  }
  const failed = await runRankDistributionCollection(estimateOptions, first.deps)
  assert.equal(failed.reason, 'cancelled')
  assert.equal(failed.checkpointSaved, true)
  assert.equal(failed.published, false)
  assert.equal(persisted!.hints.length, 5)
  const second = fixture()
  let clock = 0
  second.deps.now = () => new Date(Date.parse('2026-10-15T11:00:00.000Z') + clock++ * 1000)
  second.deps.loadCheckpoint = async () => persisted
  second.deps.saveCheckpoint = async value => { persisted = structuredClone(value); return value }
  const completed = await runRankDistributionCollection({ ...estimateOptions, resume: true }, second.deps)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.confirmedBoundaryCount, 35)
  assert.equal(persisted!.hints.length, 35)
  assert.equal(second.saved[0].captureStartedAt, '2026-10-15T11:00:00.000Z')
  assert.ok(second.saved[0].observation!.boundaries.every(value => value.observedAt >= second.saved[0].captureStartedAt))
})

test('missing, malformed or future checkpoints stop before accessing authentication or opening a browser', async () => {
  for (const kind of ['missing', 'malformed', 'future'] as const) {
    const input = fixture()
    const checkpoint = syntheticCheckpoint()
    input.deps.loadCheckpoint = async () => kind === 'missing' ? null : kind === 'malformed'
      ? { ...checkpoint, cookies: 'private-test-secret' } as RankDistributionCheckpoint
      : { ...checkpoint, savedAt: '2026-10-16T00:00:00.000Z' }
    const report = await runRankDistributionCollection({ ...estimateOptions, resume: true }, input.deps)
    assert.equal(report.reason, 'checkpoint-unavailable')
    assert.equal(report.stage, 'checkpoint-load')
    assert.equal(input.calls.load, 0)
    assert.equal(input.calls.launch, 0)
    assert.equal(input.calls.publish, 0)
    assert.ok(!JSON.stringify(report).includes('private-test-secret'))
  }
})

test('resume rejects a different observed page size and a failed checkpoint save preserves completed history', async () => {
  const changed = fixture()
  changed.deps.loadCheckpoint = async () => ({ ...syntheticCheckpoint(), pageSize: 20 })
  const mismatch = await runRankDistributionCollection({ ...estimateOptions, resume: true }, changed.deps)
  assert.equal(mismatch.reason, 'checkpoint-unavailable')
  assert.equal(mismatch.requestCount, 1)
  assert.equal(changed.calls.publish, 0)
  assert.equal(changed.calls.close, 1)
  const failedSave = fixture()
  failedSave.deps.saveCheckpoint = async () => { throw new Error('private-test-secret') }
  const failure = await runRankDistributionCollection(estimateOptions, failedSave.deps)
  assert.equal(failure.reason, 'checkpoint-unavailable')
  assert.equal(failure.stage, 'checkpoint-save')
  assert.equal(failure.datasetSaved, false)
  assert.equal(failure.published, false)
  assert.equal(failedSave.calls.close, 1)
  assert.ok(!JSON.stringify(failure).includes('private-test-secret'))
})

test('strict capture never reads or writes checkpoints and rejects resume programmatically', async () => {
  const input = fixture()
  input.deps.loadCheckpoint = async () => { assert.fail('strict must not load checkpoints') }
  input.deps.saveCheckpoint = async () => { assert.fail('strict must not save checkpoints') }
  const report = await runRankDistributionCollection(options, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.checkpointLoaded, false)
  assert.equal(report.checkpointSaved, false)
  const invalid = await runRankDistributionCollection({ ...options, resume: true }, fixture().deps)
  assert.equal(invalid.reason, 'configuration-invalid')
})

test('only a complete synthetic capture is saved and published, with preflight included in its interval', async () => {
  const input = fixture()
  const report = await runRankDistributionCollection(options, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.accuracy, 'strict')
  assert.equal(report.timeLimitMinutes, 15)
  assert.equal(report.confirmedBoundaryCount, 35)
  assert.deepEqual(input.launchAccuracies, ['strict'])
  assert.equal(report.reason, null)
  assert.equal(report.published, true)
  assert.equal(report.datasetSaved, true)
  assert.equal(report.browserClosed, true)
  assert.equal(report.reportSaved, true)
  assert.equal(report.manualLoginPerformed, false)
  assert.equal(report.requestCount, input.requests.length)
  assert.deepEqual(input.calls, { load: 1, launch: 1, close: 1, save: 1, publish: 1, availability: 0, report: 1 })
  assert.deepEqual(input.requests.slice(0, 2), [1, 15])
  assert.deepEqual(parseRankDistributionDataset(input.saved[0]), input.saved[0])
  assert.equal(input.saved[0].captureStartedAt, startedAt)
  assert.deepEqual(input.saved[0].entries, Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, count: 2 })))
  assert.match(input.saved[0].validation.notes.join(' '), /user_status=1は固定URLの一致/)
  assert.match(input.saved[0].validation.notes.join(' '), /全ユーザーを意味するとは断定しない/)
  assert.match(input.saved[0].validation.notes.join(' '), /個別一意性や実人数を証明しない/)
  assert.ok(input.progress.length > 0)
  assert.ok(input.progress.every(value => (value as { successfulReadCount: number }).successfulReadCount % 10 === 0))
})

function appendSyntheticTail(input: ReturnType<typeof fixture>, count: number) {
  for (let index = 0; index < count; index++) input.values.push({ rankId: 1, leaguePoint: 0,
    accountKey: input.values.length.toString(16).padStart(64, '0') })
}

test('collection defaults to a complete estimate while explicit strict mode remains available', async () => {
  const input = fixture()
  const report = await runRankDistributionCollection({ mode: 'collect', maxRequests: 600 }, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.accuracy, 'estimate')
  assert.equal(report.timeLimitMinutes, 110)
  assert.equal(report.confirmedBoundaryCount, 35)
  assert.deepEqual(input.launchAccuracies, ['estimate'])
  assert.equal(input.saved[0].method, 'boundary-search-estimate')
  assert.equal(input.saved[0].validation.status, 'estimated')
  assert.equal(input.saved[0].validation.coverage, 'all-rank-boundaries')
  assert.equal(input.saved[0].observation!.boundaries.length, 35)
  assert.equal(input.calls.publish, 1)
})

test('estimate accepts total changes before and during collection, recording them without calling the result exact', async () => {
  const input = fixture()
  input.transport.fetchPage = async (page, url) => {
    if (input.requests.length === 1 || input.requests.length === 3) appendSyntheticTail(input, 1)
    return input.fetchPage(page, url)
  }
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.totalMin, 72)
  assert.equal(report.totalMax, 74)
  assert.equal(report.totalAtEnd, 74)
  assert.equal(report.confirmedBoundaryCount, 35)
  assert.equal(input.calls.save, 1)
  assert.equal(input.calls.publish, 1)
  const dataset = input.saved[0]
  assert.equal(dataset.method, 'boundary-search-estimate')
  assert.equal(dataset.validation.status, 'estimated')
  assert.equal(dataset.observation!.totalAtStart, 72)
  assert.equal(dataset.observation!.totalAtEnd, 74)
  assert.equal(dataset.observation!.minTotal, 72)
  assert.equal(dataset.observation!.maxTotal, 74)
  assert.equal(dataset.entries[0].count, 4)
  assert.equal(dataset.entries.reduce((sum, entry) => sum + entry.count, 0), dataset.totalCount)
  assert.match(dataset.validation.notes.join(' '), /事前確認を含む取得期間全体/)
  assert.deepEqual(parseRankDistributionDataset(dataset), dataset)
})

test('estimate follows a moved terminal page within its three-read limit before creating tail evidence', async () => {
  const input = fixture()
  input.transport.fetchPage = async (page, url) => {
    if (input.requests.length === 1) appendSyntheticTail(input, 10)
    return input.fetchPage(page, url)
  }
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.deepEqual(input.requests.slice(0, 3), [1, 15, 17])
  assert.equal(report.totalMin, 72)
  assert.equal(report.totalMax, 82)
  assert.equal(report.confirmedBoundaryCount, 35)
  assert.equal(input.calls.publish, 1)
})

test('estimate refuses an unreachable moving tail or unknown tail instead of publishing a partial estimate', async () => {
  for (const change of ['moving-tail', 'unknown-tail'] as const) {
    const input = fixture()
    input.transport.fetchPage = async (page, url) => {
      if (change === 'moving-tail' && input.requests.length >= 1) appendSyntheticTail(input, 10)
      const value = await input.fetchPage(page, url)
      if (change === 'unknown-tail' && input.requests.length === 2) value.entries.at(-1)!.rankId = 37
      return value
    }
    const report = await runRankDistributionCollection(estimateOptions, input.deps)
    assert.equal(report.status, 'failed')
    assert.equal(report.reason, change === 'moving-tail' ? 'observation-changed' : 'unknown-rank')
    assert.equal(input.requests.length, change === 'moving-tail' ? 4 : 2)
    assert.equal(input.calls.save, 0)
    assert.equal(input.calls.publish, 0)
    assert.equal(report.browserClosed, true)
  }
})

test('missing authentication never launches, saves, or publishes and never leaks its failure', async () => {
  const input = fixture()
  input.deps.loadSession = async () => { throw new Error('private auth file cookie=private-auth-value') }
  const report = await runRankDistributionCollection(options, input.deps)
  assert.equal(report.reason, 'authentication-required')
  assert.equal(report.authenticationStateLoaded, false)
  assert.equal(input.calls.launch, 0)
  assert.equal(input.calls.save, 0)
  assert.equal(input.calls.publish, 0)
  assert.equal(report.availabilityUpdated, true)
  assert.equal(input.statuses[0].status, 'collection-failed')
  assert.ok(!JSON.stringify(report).includes('private'))
})

test('incomplete display or tail evidence prevents the collector and publication', async () => {
  for (const key of ['rankMappingConfirmed', 'leagueLabelsConfirmed', 'displayedConditionsConfirmed', 'tailRankIds'] as const) {
    const input = fixture()
    input.transport.getDiagnostics = () => ({ ...input.diagnostics, [key]: key === 'tailRankIds' ? [] : false,
      rows: input.values, privateDOM: 'private', cookie: 'private' })
    const report = await runRankDistributionCollection(options, input.deps)
    assert.equal(report.reason, 'evidence-unconfirmed')
    assert.equal(report.stage, 'preflight')
    assert.equal(input.requests.length, 2)
    assert.equal(input.calls.save, 0)
    assert.equal(input.calls.publish, 0)
    assert.equal(input.statuses[0].status, 'verification-pending')
    assert.equal(input.calls.close, 1)
  }
})

test('first/last total changes are rejected before collection and preserve both observed totals safely', async () => {
  const input = fixture()
  input.transport.fetchPage = async (page, url) => {
    const value = await input.fetchPage(page, url)
    if (input.requests.length === 2) { value.totalCount++; input.diagnostics.lastObservedTotal = value.totalCount }
    return value
  }
  const report = await runRankDistributionCollection(options, input.deps)
  assert.equal(report.reason, 'observation-changed')
  assert.equal(report.stage, 'preflight')
  assert.equal(report.totalCount, 72)
  assert.equal(report.lastObservedTotal, 73)
  assert.equal(input.calls.save, 0)
  assert.equal(input.calls.publish, 0)
  assert.equal(input.calls.close, 1)
})

test('unknown tail icons or unstable core observations never become a complete dataset', async () => {
  for (const change of ['unknown-tail', 'total', 'content'] as const) {
    const input = fixture()
    const seen = new Map<number, number>()
    input.transport.fetchPage = async (page, url) => {
      const value = await input.fetchPage(page, url)
      const count = (seen.get(page) ?? 0) + 1
      seen.set(page, count)
      if (change === 'unknown-tail' && input.requests.length === 2) value.entries.at(-1)!.rankId = 0
      if (change === 'total' && input.requests.length === 4) value.totalCount++
      if (change === 'content' && page === 1 && count >= 3) value.entries[0].leaguePoint--
      return value
    }
    const report = await runRankDistributionCollection(options, input.deps)
    assert.equal(report.reason, change === 'unknown-tail' ? 'unknown-rank' : 'observation-changed')
    assert.equal(input.calls.save, 0)
    assert.equal(input.calls.publish, 0)
    assert.equal(report.datasetSaved, false)
    assert.equal(report.status, 'failed')
  }
})

test('DOM-specific refusal codes survive core wrapping without exposing browser errors', async () => {
  for (const [code, reason] of [
    ['http-denied', 'access-denied'], ['maintenance', 'maintenance'], ['login-required', 'authentication-required'],
    ['unsupported-rank-icon', 'unknown-rank'], ['total-count-changed', 'observation-changed'],
  ] as const) {
    const input = fixture()
    input.transport.fetchPage = async (page, url) => {
      if (input.requests.length >= 2) throw new RankDistributionDomError(code)
      return input.fetchPage(page, url)
    }
    const report = await runRankDistributionCollection(options, input.deps)
    assert.equal(report.reason, reason)
    assert.equal(report.stage, 'collection')
    assert.equal(input.calls.save, 0)
    assert.equal(input.calls.publish, 0)
    assert.equal(report.browserClosed, true)
  }
})

test('one fresh same-page read recovers only transient DOM failures, counting every actual attempt', async () => {
  for (const code of ['authentication-unconfirmed', 'timeout', 'read-failed'] as const) {
    const input = fixture()
    let attempts = 0
    const attemptedPages: number[] = []
    input.transport.fetchPage = async (page, url) => {
      attemptedPages.push(page)
      if (++attempts === 3) throw new RankDistributionDomError(code)
      return input.fetchPage(page, url)
    }
    const report = await runRankDistributionCollection(estimateOptions, input.deps)
    assert.equal(report.status, 'succeeded')
    assert.equal(report.requestCount, attempts)
    assert.equal(report.successfulReadCount, attempts - 1)
    assert.equal(report.retryCount, 1)
    assert.equal(report.readFailureCode, code)
    assert.deepEqual(attemptedPages.slice(2, 4), [1, 1])
    assert.deepEqual(input.waits, [500])
    assert.equal(input.calls.publish, 1)
    assert.equal(input.calls.close, 1)
  }
})

/** Actual pure reader/CLI coupling with a fake page; no browser or authentication is accessed. */
function incompleteDisplayFixture(failedNavigations: readonly number[], appearance: 'login-control' | 'signed-in-pending' = 'login-control') {
  const input = fixture()
  const attemptedPages: number[] = []
  let currentUrl = ''
  let pageNumber = 1
  let clock = 0
  const page = {
    async goto(url: string) {
      currentUrl = url
      pageNumber = Number(new URL(url).searchParams.get('page'))
      attemptedPages.push(pageNumber)
      return { status: () => 200 }
    },
    url: () => currentUrl,
    async evaluate() {
      const from = (pageNumber - 1) * 20 + 1
      const to = Math.min(pageNumber * 20, input.values.length)
      const failed = failedNavigations.includes(attemptedPages.length)
      const loginControl = failed && appearance === 'login-control'
      return {
        maintenance: false, signedIn: !loginControl,
        authenticationEvidence: loginControl ? 'login-control' : 'logout-control',
        loginRequired: false, loginRequiredHeading: false,
        conditionsMatch: true, leagueLabelsMatch: true, selectedPage: pageNumber,
        range: { from, to, total: input.values.length }, rankIcons: failed ? 'pending' : 'ready',
        entries: failed ? null : structuredClone(input.values.slice(from - 1, to)),
      }
    },
  }
  const reader = createRankDistributionPageReader(page as unknown as Parameters<typeof createRankDistributionPageReader>[0], {
    totalCountPolicy: 'record', allowReadablePagesAfterSignIn: true,
    minIntervalMs: 250, timeoutMs: 10_000, now: () => clock, wait: async milliseconds => { clock += milliseconds },
  })
  input.deps.launch = async () => {
    input.calls.launch++
    return { ...reader, close: input.transport.close }
  }
  return { ...input, attemptedPages, reader }
}

test('a heading-free login-control page with incomplete rows recovers through one bounded fresh same-page read', async () => {
  const input = incompleteDisplayFixture([3])
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.retryCount, 1)
  assert.equal(report.readFailureCode, 'authentication-unconfirmed')
  assert.equal(report.requestCount, input.attemptedPages.length)
  assert.equal(report.successfulReadCount, report.requestCount - 1)
  assert.deepEqual(input.attemptedPages.slice(0, 4), [1, 4, 1, 1])
  assert.deepEqual(input.waits, [500])
  assert.equal(report.confirmedBoundaryCount, 35)
  assert.equal(report.readableWithoutSignInReadCount, 0)
  assert.equal(input.calls.publish, 1)
  assert.equal(input.calls.close, 1)
})

test('two heading-free login-control pages with incomplete rows stop without publishing or claiming session expiry', async () => {
  const input = incompleteDisplayFixture([3, 4])
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.status, 'failed')
  assert.equal(report.reason, 'authentication-unconfirmed')
  assert.equal(report.readFailureCode, 'authentication-unconfirmed')
  assert.equal(report.requestCount, 4)
  assert.equal(report.successfulReadCount, 2)
  assert.equal(report.retryCount, 1)
  assert.deepEqual(input.attemptedPages, [1, 4, 1, 1])
  assert.deepEqual(input.waits, [500])
  assert.equal(report.lastHttpStatus, 200)
  assert.equal(report.lastAuthenticationEvidence, 'login-control')
  assert.equal(report.lastLoginRequiredHeading, false)
  assert.equal(report.lastRankingReadable, false)
  assert.equal(report.readableWithoutSignInReadCount, 0)
  assert.equal(input.statuses[0].reason, 'authentication-unconfirmed')
  assert.equal(input.calls.save, 0)
  assert.equal(input.calls.publish, 0)
  assert.equal(input.calls.close, 1)
})

test('signed-in first-page rows still loading at the deadline recover through one bounded fresh read', async () => {
  const input = incompleteDisplayFixture([1], 'signed-in-pending')
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.retryCount, 1)
  assert.equal(report.readFailureCode, 'read-failed')
  assert.equal(report.requestCount, input.attemptedPages.length)
  assert.equal(report.successfulReadCount, report.requestCount - 1)
  assert.deepEqual(input.attemptedPages.slice(0, 3), [1, 1, 4])
  assert.deepEqual(input.waits, [500])
  assert.equal(report.confirmedBoundaryCount, 35)
  assert.equal(input.calls.publish, 1)
  assert.equal(input.calls.close, 1)
})

test('two signed-in first-page loading deadlines stop without saving or publishing an incomplete layout', async () => {
  const input = incompleteDisplayFixture([1, 2], 'signed-in-pending')
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.status, 'failed')
  assert.equal(report.stage, 'preflight')
  assert.equal(report.reason, 'read-failed')
  assert.equal(report.readFailureCode, 'read-failed')
  assert.equal(report.requestCount, 2)
  assert.equal(report.successfulReadCount, 0)
  assert.equal(report.retryCount, 1)
  assert.deepEqual(input.attemptedPages, [1, 1])
  assert.deepEqual(input.waits, [500])
  assert.equal(report.lastHttpStatus, 200)
  assert.equal(report.lastAuthenticationEvidence, 'logout-control')
  assert.equal(report.lastLoginRequiredHeading, false)
  assert.equal(report.lastRankingReadable, false)
  assert.equal(input.statuses[0].reason, 'read-failed')
  assert.equal(input.calls.save, 0)
  assert.equal(input.calls.publish, 0)
  assert.equal(input.calls.close, 1)
})

test('a transient server error receives one fresh same-page read after five seconds', async () => {
  const input = fixture()
  let attempts = 0
  const attemptedPages: number[] = []
  input.transport.fetchPage = async (page, url) => {
    attemptedPages.push(page)
    if (++attempts === 3) {
      input.diagnostics.lastHttpStatus = 503
      throw new RankDistributionDomError('server-error')
    }
    return input.fetchPage(page, url)
  }
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.readFailureCode, 'server-error')
  assert.equal(report.retryCount, 1)
  assert.equal(report.requestCount, attempts)
  assert.equal(report.lastHttpStatus, 200)
  assert.deepEqual(input.waits, [5000])
  assert.deepEqual(attemptedPages.slice(2, 4), [1, 1])
  assert.equal(input.calls.publish, 1)
})

test('HTTP 404 is recorded safely and never treated as a transient server failure', async () => {
  const input = fixture()
  let attempts = 0
  input.transport.fetchPage = async (page, url) => {
    if (++attempts === 3) {
      input.diagnostics.lastHttpStatus = 404
      throw new RankDistributionDomError('http-error')
    }
    return input.fetchPage(page, url)
  }
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.reason, 'read-failed')
  assert.equal(report.readFailureCode, 'http-error')
  assert.equal(report.lastHttpStatus, 404)
  assert.equal(report.requestCount, 3)
  assert.equal(report.retryCount, 0)
  assert.deepEqual(input.waits, [])
  assert.equal(input.calls.publish, 0)
})

test('HTTP status diagnostics accept only integer status codes and never copy arbitrary metadata', async () => {
  for (const value of ['private status text', '503', 99, 600, 200.5, null, 200, 503]) {
    const input = fixture()
    const original = input.transport.getDiagnostics
    input.transport.getDiagnostics = () => ({ ...original(), lastHttpStatus: value } as unknown as ReturnType<typeof original>)
    const report = await runRankDistributionCollection(estimateOptions, input.deps)
    assert.equal(report.lastHttpStatus, value === 200 || value === 503 ? value : null)
    assert.ok(!JSON.stringify(report).includes('private'))
    assert.ok(!JSON.stringify(report).includes('privateDOM'))
  }
})

function refreshFixture(triggerAfter = 8) {
  const initial = fixture()
  const fresh = fixture()
  let elapsedMilliseconds = 0
  const launchedStates: unknown[] = []
  initial.deps.elapsedNow = () => elapsedMilliseconds
  initial.transport.fetchPage = async (page, url) => {
    const value = await initial.fetchPage(page, url)
    if (initial.requests.length >= triggerAfter) elapsedMilliseconds = 20 * 60_000
    return value
  }
  initial.deps.launch = async (state, _signal, accuracy) => {
    launchedStates.push(state)
    initial.calls.launch++
    initial.launchAccuracies.push(accuracy)
    if (initial.calls.launch === 1) return initial.transport
    assert.equal(initial.calls.launch, 2)
    return fresh.transport
  }
  return { initial, fresh, launchedStates }
}

test('estimate replaces its owned browser after twenty minutes and continues the same in-memory boundary capture', async () => {
  const baseline = fixture()
  const withoutRefresh = await runRankDistributionCollection(estimateOptions, baseline.deps)
  const { initial, fresh, launchedStates } = refreshFixture()
  const report = await runRankDistributionCollection(estimateOptions, initial.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.sessionRefreshCount, 1)
  assert.equal(report.confirmedBoundaryCount, 35)
  assert.equal(report.requestCount, withoutRefresh.requestCount + 1)
  assert.equal(report.requestCount, initial.requests.length + fresh.requests.length)
  assert.equal(fresh.requests[0], 1)
  assert.equal(initial.calls.load, 1)
  assert.equal(initial.calls.launch, 2)
  assert.equal(launchedStates[0], launchedStates[1])
  assert.deepEqual(initial.waits, [5000])
  assert.equal(initial.calls.close, 1)
  assert.equal(fresh.calls.close, 1)
  assert.equal(report.browserClosed, true)
  assert.equal(initial.calls.save, 1)
  assert.equal(initial.calls.publish, 1)
  assert.equal(initial.saved[0].captureStartedAt, startedAt)
  assert.deepEqual(initial.saved[0].entries, baseline.saved[0].entries)
  assert.deepEqual(report.observedRankIds, Array.from({ length: 36 }, (_, index) => index + 1))
  assert.ok(!JSON.stringify(report).includes('private-auth-value'))
})

test('readable-page counts include each owned reader once across preventive browser replacement', async () => {
  const { initial, fresh } = refreshFixture()
  const oldDiagnostics = initial.transport.getDiagnostics
  const freshDiagnostics = fresh.transport.getDiagnostics
  initial.transport.getDiagnostics = () => ({ ...oldDiagnostics(), readableWithoutSignInReadCount: 2 })
  fresh.transport.getDiagnostics = () => ({ ...freshDiagnostics(), readableWithoutSignInReadCount: 3 })
  const report = await runRankDistributionCollection(estimateOptions, initial.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.sessionRefreshCount, 1)
  assert.equal(report.readableWithoutSignInReadCount, 5)
  assert.equal(initial.reports[0].readableWithoutSignInReadCount, 5)
})

test('the fresh-context verification counts toward the unchanged hard navigation cap', async () => {
  const { initial, fresh } = refreshFixture(3)
  const report = await runRankDistributionCollection({ ...estimateOptions, maxRequests: 4 }, initial.deps)
  assert.equal(report.reason, 'request-limit')
  assert.equal(report.requestCount, 4)
  assert.equal(initial.requests.length, 3)
  assert.deepEqual(fresh.requests, [1])
  assert.equal(report.sessionRefreshCount, 1)
  assert.equal(initial.calls.publish, 0)
  assert.equal(initial.calls.close, 1)
  assert.equal(fresh.calls.close, 1)
})

test('a new context requiring login stops without retrying login or launching another browser', async () => {
  const { initial, fresh } = refreshFixture()
  let freshAttempts = 0
  fresh.transport.fetchPage = async () => { freshAttempts++; throw new RankDistributionDomError('login-required') }
  const report = await runRankDistributionCollection(estimateOptions, initial.deps)
  assert.equal(report.reason, 'authentication-required')
  assert.equal(report.readFailureCode, 'login-required')
  assert.equal(report.sessionRefreshCount, 0)
  assert.equal(report.retryCount, 0)
  assert.equal(freshAttempts, 1)
  assert.equal(initial.calls.launch, 2)
  assert.equal(initial.calls.publish, 0)
  assert.equal(initial.calls.close, 1)
  assert.equal(fresh.calls.close, 1)
})

test('replacement first pages must confirm mapping, labels and displayed conditions again', async () => {
  for (const key of ['rankMappingConfirmed', 'leagueLabelsConfirmed', 'displayedConditionsConfirmed'] as const) {
    const { initial, fresh } = refreshFixture()
    const original = fresh.transport.getDiagnostics
    fresh.transport.getDiagnostics = () => ({ ...original(), [key]: false })
    const report = await runRankDistributionCollection(estimateOptions, initial.deps)
    assert.equal(report.reason, 'evidence-unconfirmed')
    assert.equal(report.sessionRefreshCount, 0)
    assert.equal(initial.calls.publish, 0)
    assert.equal(initial.calls.close, 1)
    assert.equal(fresh.calls.close, 1)
  }
})

test('cancellation while launching a replacement still closes both owned browsers', async () => {
  const { initial, fresh } = refreshFixture()
  const controller = new AbortController()
  initial.deps.signal = controller.signal
  const launch = initial.deps.launch
  initial.deps.launch = async (state, signal, accuracy) => {
    const result = await launch(state, signal, accuracy)
    if (initial.calls.launch === 2) controller.abort()
    return result
  }
  const report = await runRankDistributionCollection(estimateOptions, initial.deps)
  assert.equal(report.reason, 'cancelled')
  assert.equal(report.sessionRefreshCount, 0)
  assert.equal(initial.calls.launch, 2)
  assert.equal(initial.calls.close, 1)
  assert.equal(fresh.calls.close, 1)
  assert.equal(report.browserClosed, true)
  assert.equal(fresh.requests.length, 0)
  assert.equal(initial.calls.publish, 0)
})

test('cancellation during the replacement spacing wait leaves the closed browser retired', async () => {
  const { initial, fresh } = refreshFixture()
  const controller = new AbortController()
  initial.deps.signal = controller.signal
  initial.deps.wait = async (milliseconds, signal) => {
    assert.equal(milliseconds, 5000)
    assert.equal(initial.calls.close, 1)
    assert.equal(initial.calls.launch, 1)
    controller.abort()
    signal.throwIfAborted()
  }
  const report = await runRankDistributionCollection(estimateOptions, initial.deps)
  assert.equal(report.reason, 'cancelled')
  assert.equal(report.sessionRefreshCount, 0)
  assert.equal(initial.calls.launch, 1)
  assert.equal(initial.calls.close, 1)
  assert.equal(fresh.calls.close, 0)
  assert.equal(fresh.requests.length, 0)
  assert.equal(initial.calls.publish, 0)
  assert.equal(report.browserClosed, true)
})

test('a failed old-browser close prevents replacement launch and cannot leak its raw error', async () => {
  const { initial, fresh } = refreshFixture()
  initial.transport.close = async () => { initial.calls.close++; throw new Error('private old-browser close error') }
  const report = await runRankDistributionCollection(estimateOptions, initial.deps)
  assert.equal(report.reason, 'read-failed')
  assert.equal(report.sessionRefreshCount, 0)
  assert.equal(initial.calls.launch, 1)
  assert.equal(initial.calls.close, 1)
  assert.equal(fresh.calls.close, 0)
  assert.equal(report.browserClosed, false)
  assert.equal(initial.calls.publish, 0)
  assert.ok(!JSON.stringify(report).includes('private'))
})

test('strict captures never replace a browser based on the estimate elapsed clock', async () => {
  const input = fixture()
  let clockReads = 0
  input.deps.elapsedNow = () => { clockReads++; return 60 * 60_000 }
  const report = await runRankDistributionCollection(options, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.accuracy, 'strict')
  assert.equal(report.sessionRefreshCount, 0)
  assert.equal(input.calls.launch, 1)
  assert.equal(input.calls.close, 1)
  assert.equal(clockReads, 0)
})

test('two inconclusive authentication reads stop without claiming the saved session expired', async () => {
  const input = fixture()
  let attempts = 0
  input.transport.fetchPage = async (page, url) => {
    if (++attempts >= 3) throw new RankDistributionDomError('authentication-unconfirmed')
    return input.fetchPage(page, url)
  }
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.status, 'failed')
  assert.equal(report.reason, 'authentication-unconfirmed')
  assert.equal(report.readFailureCode, 'authentication-unconfirmed')
  assert.equal(report.requestCount, 4)
  assert.equal(report.retryCount, 1)
  assert.equal(input.calls.save, 0)
  assert.equal(input.calls.publish, 0)
  assert.equal(input.calls.close, 1)
  assert.equal(input.statuses[0].reason, 'authentication-unconfirmed')
})

test('explicit denial, maintenance, login requirements, condition changes and unknown ranks are never retried', async () => {
  for (const [code, reason] of [
    ['http-denied', 'access-denied'], ['maintenance', 'maintenance'], ['login-required', 'authentication-required'],
    ['condition-mismatch', 'source-changed'], ['unsupported-rank-icon', 'unknown-rank'], ['http-error', 'read-failed'],
  ] as const) {
    const input = fixture()
    let attempts = 0
    input.transport.fetchPage = async () => { attempts++; throw new RankDistributionDomError(code) }
    const report = await runRankDistributionCollection(estimateOptions, input.deps)
    assert.equal(report.reason, reason)
    assert.equal(report.requestCount, 1)
    assert.equal(report.retryCount, 0)
    assert.equal(report.readFailureCode, code)
    assert.equal(attempts, 1)
    assert.deepEqual(input.waits, [])
    assert.equal(input.calls.publish, 0)
  }
})

test('the hard navigation budget includes retries and remains request-limit even after core error wrapping', async () => {
  for (const maxRequests of [3, 4]) {
    const input = fixture()
    let attempts = 0
    input.transport.fetchPage = async (page, url) => {
      if (++attempts === 3) throw new RankDistributionDomError('authentication-unconfirmed')
      return input.fetchPage(page, url)
    }
    const report = await runRankDistributionCollection({ ...estimateOptions, maxRequests }, input.deps)
    assert.equal(report.reason, 'request-limit')
    assert.equal(report.requestCount, maxRequests)
    assert.equal(attempts, maxRequests)
    assert.equal(report.retryCount, maxRequests === 3 ? 0 : 1)
    assert.equal(input.waits.length, maxRequests === 3 ? 0 : 1)
    assert.equal(input.calls.publish, 0)
  }
  const input = fixture()
  let attempts = 0
  input.transport.fetchPage = async (page, url) => {
    if (++attempts % 2 === 1) throw new RankDistributionDomError('timeout')
    return input.fetchPage(page, url)
  }
  const report = await runRankDistributionCollection({ ...estimateOptions, maxRequests: 5 }, input.deps)
  assert.equal(report.reason, 'request-limit')
  assert.equal(report.requestCount, 5)
  assert.equal(attempts, 5)
  assert.equal(report.retryCount, 2)
  assert.equal(input.waits.length, 2)
  assert.equal(input.calls.publish, 0)
})

test('cancellation during a failed attempt or its retry delay prevents the second navigation', async () => {
  for (const when of ['attempt', 'delay'] as const) {
    const input = fixture()
    const controller = new AbortController()
    input.deps.signal = controller.signal
    let attempts = 0
    input.transport.fetchPage = async () => {
      attempts++
      if (when === 'attempt') controller.abort()
      throw new RankDistributionDomError('authentication-unconfirmed')
    }
    input.deps.wait = async () => { controller.abort() }
    const report = await runRankDistributionCollection(estimateOptions, input.deps)
    assert.equal(report.reason, 'cancelled')
    assert.equal(report.requestCount, 1)
    assert.equal(report.retryCount, 0)
    assert.equal(attempts, 1)
    assert.equal(input.calls.close, 1)
    assert.equal(input.calls.publish, 0)
  }
})

test('the request budget includes preflight and never switches to full enumeration', async () => {
  for (const maxRequests of [2, 4]) {
    const input = fixture()
    const report = await runRankDistributionCollection({ mode: 'collect', maxRequests }, input.deps)
    assert.equal(report.reason, 'request-limit')
    assert.equal(report.requestCount, maxRequests)
    assert.equal(input.requests.length, maxRequests)
    assert.equal(input.calls.publish, 0)
    assert.equal(input.calls.close, 1)
  }
})

test('dataset-save and import failures are sanitized and retain the previous public history', async () => {
  for (const failure of ['save', 'publish'] as const) {
    const input = fixture()
    if (failure === 'save') input.deps.saveDataset = async () => { throw new Error('private-cookie secret profile/path') }
    else input.deps.publish = async () => { input.calls.publish++; throw new Error('<div>private import failure</div>') }
    const report = await runRankDistributionCollection(options, input.deps)
    assert.equal(report.reason, 'publication-failed')
    assert.equal(report.published, false)
    assert.equal(report.datasetSaved, failure === 'publish')
    assert.equal(input.calls.publish, failure === 'publish' ? 1 : 0)
    assert.equal(report.browserClosed, true)
    assert.ok(!JSON.stringify(report).includes('private'))
    assert.equal(input.statuses[0].reason, 'publication-failed')
  }
})

test('reports and progress contain fixed scalars and rank IDs, never state, profiles, rows or DOM', async () => {
  const input = fixture()
  const report = await runRankDistributionCollection(options, input.deps)
  for (const value of [report, ...input.reports, ...input.progress]) {
    const json = JSON.stringify(value)
    for (const forbidden of ['accountKey', 'private-auth-value', 'private diagnostic', 'privateDOM', 'cookies', '"rows"', 'profile/', 'stack']) {
      assert.ok(!json.includes(forbidden), forbidden)
    }
  }
  assert.deepEqual(report.tailRankIds, [1])
  assert.deepEqual(report.observedRankIds, Array.from({ length: 36 }, (_, index) => index + 1))
})

test('authentication diagnostics distinguish a readable ranking with a login control and reject raw page values', async () => {
  const input = fixture()
  const getDiagnostics = input.transport.getDiagnostics
  input.transport.getDiagnostics = () => ({ ...getDiagnostics(), lastAuthenticationEvidence: 'login-control' as const,
    lastLoginRequiredHeading: false, lastRankingReadable: true })
  input.transport.fetchPage = async (page, url) => {
    if (input.requests.length >= 2) throw new RankDistributionDomError('login-required')
    return input.fetchPage(page, url)
  }
  const report = await runRankDistributionCollection(estimateOptions, input.deps)
  assert.equal(report.reason, 'authentication-unconfirmed')
  assert.equal(report.lastAuthenticationEvidence, 'login-control')
  assert.equal(report.lastLoginRequiredHeading, false)
  assert.equal(report.lastRankingReadable, true)
  const hostile = fixture()
  const rawDiagnostics = hostile.transport.getDiagnostics
  hostile.transport.getDiagnostics = () => ({ ...rawDiagnostics(), lastAuthenticationEvidence: 'private raw header',
    lastLoginRequiredHeading: 'private raw heading', lastRankingReadable: { private: 'raw rows' } } as never)
  const sanitized = await runRankDistributionCollection(options, hostile.deps)
  assert.equal(sanitized.lastAuthenticationEvidence, null)
  assert.equal(sanitized.lastLoginRequiredHeading, null)
  assert.equal(sanitized.lastRankingReadable, null)
  assert.ok(!JSON.stringify(sanitized).includes('private raw'))
})

test('readable-page diagnostics accept only nonnegative safe-integer counts without echoing raw values', async () => {
  for (const value of ['private raw count', '7', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, undefined, 0, 7, Number.MAX_SAFE_INTEGER]) {
    const input = fixture()
    const original = input.transport.getDiagnostics
    input.transport.getDiagnostics = () => ({ ...original(), readableWithoutSignInReadCount: value } as never)
    const report = await runRankDistributionCollection(estimateOptions, input.deps)
    const expected = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
    assert.equal(report.readableWithoutSignInReadCount, expected)
    assert.equal(input.reports[0].readableWithoutSignInReadCount, expected)
    assert.ok(!JSON.stringify(report).includes('private raw count'))
  }
})

test('cancellation closes the owned browser once and never publishes partial results', async () => {
  for (const when of ['before', 'during'] as const) {
    const input = fixture()
    const controller = new AbortController()
    input.deps.signal = controller.signal
    if (when === 'before') controller.abort(new Error('private abort cause'))
    else input.transport.fetchPage = async (page, url) => {
      const value = await input.fetchPage(page, url)
      controller.abort(new Error('private abort cause'))
      return value
    }
    const report = await runRankDistributionCollection(options, input.deps)
    assert.equal(report.reason, 'cancelled')
    assert.equal(input.calls.publish, 0)
    assert.equal(input.calls.close, when === 'before' ? 0 : 1)
    assert.ok(!JSON.stringify(report).includes('private'))
  }
})

test('failure to update availability or save a report cannot expose a raw error', async () => {
  const input = fixture()
  input.deps.loadSession = async () => { throw new Error('private auth') }
  input.deps.recordAvailability = async () => { throw new Error('private availability') }
  input.deps.writeReport = async () => { throw new Error('private report') }
  const report = await runRankDistributionCollection(options, input.deps)
  assert.equal(report.status, 'failed')
  assert.equal(report.availabilityUpdated, false)
  assert.equal(report.reportSaved, false)
  assert.ok(!JSON.stringify(report).includes('private'))
})

test('cancellation between private saving and import retains the local complete capture without publishing', async () => {
  const input = fixture()
  const controller = new AbortController()
  input.deps.signal = controller.signal
  const save = input.deps.saveDataset
  input.deps.saveDataset = async dataset => {
    const path = await save(dataset)
    controller.abort()
    return path
  }
  const report = await runRankDistributionCollection(options, input.deps)
  assert.equal(report.reason, 'cancelled')
  assert.equal(report.datasetSaved, true)
  assert.equal(report.published, false)
  assert.equal(input.calls.publish, 0)
  assert.equal(input.calls.close, 1)
})

test('a report-write failure after successful import does not misreport completed publication as failed', async () => {
  const input = fixture()
  input.deps.writeReport = async () => { throw new Error('private report-write error') }
  const report = await runRankDistributionCollection(options, input.deps)
  assert.equal(report.status, 'succeeded')
  assert.equal(report.published, true)
  assert.equal(report.reportSaved, false)
  assert.equal(input.calls.availability, 0)
  assert.ok(!JSON.stringify(report).includes('private'))
})

function writerFixture() {
  const files = new Map<string, RankDistributionPrivateFileInfo>()
  const writes: Array<{ path: string; text: string; options: { flag: 'wx'; mode: number } }> = []
  for (let current = dirname(dirname(RANK_DISTRIBUTION_CAPTURE_DIRECTORY)); ; current = dirname(current)) {
    files.set(current, { directory: true, file: false, symbolicLink: false })
    if (current === dirname(current)) break
  }
  const io: RankDistributionPrivateWriterIo = {
    inspect: async path => files.get(path) ?? null,
    mkdir: async path => { assert.ok(files.get(dirname(path))?.directory); files.set(path, { directory: true, file: false, symbolicLink: false }) },
    write: async (path, text, options) => {
      assert.equal(files.has(path), false)
      writes.push({ path, text, options })
      files.set(path, { directory: false, file: true, symbolicLink: false })
    },
  }
  return { files, writes, io, writer: createRankDistributionPrivateWriter(io) }
}
const reportName = 'capture-2026-10-15T10-00-00-000Z.json'

test('private writer uses only the fixed directory and exclusive private file creation', async () => {
  const input = writerFixture()
  const path = await input.writer(reportName, { schemaVersion: 1, status: 'failed' })
  assert.equal(path, resolve(RANK_DISTRIBUTION_CAPTURE_DIRECTORY, reportName))
  assert.deepEqual(input.writes[0].options, { flag: 'wx', mode: 0o600 })
  await assert.rejects(input.writer(reportName, {}))
  assert.equal(input.writes.length, 1)
})

test('private writer explicitly permits the estimate prefix alongside strict captures without filename collisions', async () => {
  const input = writerFixture()
  const strictName = 'max-lp-2026-10-15T10-00-00-000Z.json'
  const estimateName = 'max-lp-estimate-2026-10-15T10-00-00-000Z.json'
  const strictPath = await input.writer(strictName, { method: 'boundary-search' })
  const estimatePath = await input.writer(estimateName, { method: 'boundary-search-estimate' })
  assert.equal(strictPath, resolve(RANK_DISTRIBUTION_CAPTURE_DIRECTORY, strictName))
  assert.equal(estimatePath, resolve(RANK_DISTRIBUTION_CAPTURE_DIRECTORY, estimateName))
  assert.notEqual(strictPath, estimatePath)
  assert.equal(input.writes.length, 2)
  for (const name of ['max-lp-other-2026-10-15T10-00-00-000Z.json', 'estimate-2026-10-15T10-00-00-000Z.json',
    '../max-lp-estimate-2026-10-15T10-00-00-000Z.json']) await assert.rejects(input.writer(name, {}))
  assert.equal(input.writes.length, 2)
})

test('private writer rejects parent links, destination links, unsafe names and oversized output', async () => {
  for (const linked of ['parent', 'target'] as const) {
    const input = writerFixture()
    const path = linked === 'parent' ? dirname(RANK_DISTRIBUTION_CAPTURE_DIRECTORY)
      : resolve(RANK_DISTRIBUTION_CAPTURE_DIRECTORY, reportName)
    input.files.set(path, { directory: linked === 'parent', file: linked === 'target', symbolicLink: true })
    await assert.rejects(input.writer(reportName, {}))
    assert.equal(input.writes.length, 0)
  }
  for (const name of ['../escape.json', 'private-session.dpapi', '/absolute.json', 'capture.json']) {
    const input = writerFixture()
    await assert.rejects(input.writer(name, {}))
    assert.equal(input.writes.length, 0)
  }
  const large = writerFixture()
  await assert.rejects(large.writer(reportName, 'x'.repeat(1024 * 1024)))
  assert.equal(large.writes.length, 0)
})

test('diagnostic switches are removed before child browser launch while ordinary environment is retained', () => {
  const env = { DEBUG: 'pw:api', DEBUG_PRIVATE: 'secret', PWDEBUG: '1', NODE_DEBUG: 'net', NODE_OPTIONS: '--inspect',
    PW_TRACE: '1', PLAYWRIGHT_DEBUG: '1', PATH: 'synthetic-path', LANG: 'ja-JP' }
  disableRankDistributionDiagnostics(env)
  assert.deepEqual(env, { PATH: 'synthetic-path', LANG: 'ja-JP' })
})
