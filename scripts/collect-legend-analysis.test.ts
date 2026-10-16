import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { runLegendAnalysisCollection, summarizeLegendAnalysisCaptureReport } from './collect-legend-analysis.ts'
import type { LegendAnalysisTransport } from './collect-legend-analysis.ts'
import { LEGEND_ANALYSIS_CONDITIONS, LegendAnalysisDomError } from './lib/legend-analysis-dom.ts'
import { legendAnalysisPathWithin } from './lib/legend-analysis-files.ts'
import { validateLegendAnalysisDirectory } from './validate-legend-analysis-data.ts'
import { publishLegendAnalysisData } from './import-legend-analysis-data.ts'

const SECRET = 'synthetic-secret-never-output'
const state = { cookies: [{ name: 'synthetic', value: SECRET, domain: 'www.streetfighter.com', path: '/', expires: -1,
  httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }
const now = () => new Date('2026-10-16T01:00:00.000Z')
async function fixture(t: test.TestContext) {
  const parent = resolve('.cache/legend-capture-tests'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, 'case-'))
  t.after(async () => { if (legendAnalysisPathWithin(parent, root)) await rm(root, { recursive: true, force: true }) })
  const output = resolve(root, 'output'), calls = { read: 0, close: 0, act: 0 }
  const transport: LegendAnalysisTransport = {
    initialize: async () => ({ act: { id: 'act-13', label: 'Act 13' }, characterIds: ['ryu', 'arjun'], characterNames: { ryu: 'リュウ', arjun: 'アージュン' } }),
    confirmAct: async () => { calls.act++ },
    fetchPage: async (page, sourceUrl) => { calls.read++; return { sourceUrl, page, pageSize: 20, totalCount: 800000 + calls.read,
      from: 1, to: 20, nextPage: 2, actId: 'act-13', conditions: { ...LEGEND_ANALYSIS_CONDITIONS }, conditionsConfirmed: true,
      actConfirmed: true, rosterConfirmed: true, entries: Array.from({ length: 20 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
        characterId: 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: index < 2 })) } },
    getDiagnostics: () => ({ requestCount: calls.read, lastAttemptedPage: calls.read ? 1 : null, successfulReadCount: calls.read }), close: async () => { calls.close++ },
  }
  return { root, output, transport, calls }
}

test('run persists aggregates only after all checks and successful browser closure', async t => {
  const data = await fixture(t)
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => data.transport })
  assert.equal(result.succeeded, true)
  assert.equal(data.calls.act, 1)
  assert.equal(data.calls.close, 1)
  assert.equal(result.report.collectionPhase, 'complete')
  assert.equal(result.report.captureAttempt, 1)
  assert.equal(result.report.lastAttemptedPage, 1)
  assert.equal(result.report.successfulReadCount, 3)
  assert.equal(summarizeLegendAnalysisCaptureReport(result.report).datasetId, result.report.datasetId)
  const publicDirectory = resolve(data.output, 'public')
  assert.deepEqual(await validateLegendAnalysisDirectory(publicDirectory), { datasets: 1, entries: 2 })
  const files = await readdir(publicDirectory)
  assert.equal(files.length, 2)
  const all = JSON.stringify(result) + (await Promise.all(files.map(name => readFile(resolve(publicDirectory, name), 'utf8')))).join('')
  for (const value of [SECRET, 'accountKey', 'profile/', 'cookies', 'storageState']) assert.equal(all.includes(value), false)
})

test('raw browser failures produce only a safe failure manifest, with no fabricated zero capture', async t => {
  const data = await fixture(t)
  data.transport.initialize = async () => { throw new Error(`${SECRET} private-page-source`) }
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => data.transport })
  assert.equal(result.succeeded, false)
  assert.equal(result.report.browserClosed, true)
  const files = await readdir(resolve(data.output, 'public'))
  assert.deepEqual(files, ['index.json'])
  const text = await readFile(resolve(data.output, 'public/index.json'), 'utf8')
  const manifest = JSON.parse(text)
  assert.equal(manifest.datasets.length, 0)
  assert.equal(manifest.availability.status, 'collection-failed')
  assert.equal((JSON.stringify(result) + text).includes(SECRET), false)
})

test('failed close suppresses completed dataset; an existing staging root is refused', async t => {
  const data = await fixture(t)
  data.transport.close = async () => { throw new Error(SECRET) }
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => data.transport })
  assert.equal(result.succeeded, false)
  assert.deepEqual(await readdir(resolve(data.output, 'public')), ['index.json'])
  await assert.rejects(runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => { throw new Error('must not launch') } }), /既に存在/)
})

test('a whole-capture retry followed by HTTP 405 retains its retry count and public failure status without replacing history', async t => {
  const previous = await fixture(t)
  await runLegendAnalysisCollection({ storageState: state, outputDirectory: previous.output }, { now, launch: async () => previous.transport })
  const publicDirectory = resolve(previous.output, 'public')
  const previousDatasetName = (await readdir(publicDirectory)).find(name => name !== 'index.json')!
  const previousDataset = await readFile(resolve(publicDirectory, previousDatasetName), 'utf8')
  const failed = await fixture(t), originalRead = failed.transport.fetchPage
  failed.transport.fetchPage = async (page, url) => {
    if (failed.calls.read === 2) { failed.calls.read++; throw new LegendAnalysisDomError('http-error') }
    const result = await originalRead(page, url)
    if (failed.calls.read === 2) result.entries[0].masterRating++
    return result
  }
  failed.transport.getDiagnostics = () => ({ requestCount: failed.calls.read, lastHttpStatus: 405, lastErrorCode: 'http-error', lastStep: 'ranking-navigation',
    lastAttemptedPage: 1, successfulReadCount: 2 })
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: failed.output }, { now, launch: async () => failed.transport })
  assert.equal(result.succeeded, false)
  assert.equal(result.report.retryCount, 1)
  assert.equal(result.report.requestCount, 3)
  assert.equal(result.report.reason, 'access-unavailable')
  assert.equal(result.report.lastHttpStatus, 405)
  assert.equal(result.report.captureAttempt, 2)
  assert.equal(result.report.collectionPhase, 'listing')
  assert.equal(result.report.lastAttemptedPage, 1)
  assert.equal(result.report.successfulReadCount, 2)
  const incoming = resolve(failed.output, 'public')
  const failureManifest = JSON.parse(await readFile(resolve(incoming, 'index.json'), 'utf8'))
  assert.deepEqual(failureManifest.datasets, [])
  assert.equal(failureManifest.availability.status, 'collection-failed')
  assert.equal(failureManifest.availability.checkedAt, now().toISOString())
  assert.match(failureManifest.availability.message, /取得元が今回のアクセスを受け付けなかった/)
  assert.equal(failureManifest.availability.message.includes('過去'), false)
  assert.deepEqual(await publishLegendAnalysisData(incoming, publicDirectory, now().toISOString()), { datasets: 1, entries: 2 })
  const published = JSON.parse(await readFile(resolve(publicDirectory, 'index.json'), 'utf8'))
  assert.deepEqual(published.availability, failureManifest.availability)
  assert.equal(await readFile(resolve(publicDirectory, previousDatasetName), 'utf8'), previousDataset)
})

test('failure diagnostics distinguish end recheck, start recheck and Act recheck without serializing rows or URLs', async t => {
  for (const [readFailure, phase] of [[2, 'end-recheck'], [3, 'start-recheck']] as const) {
    const data = await fixture(t), original = data.transport.fetchPage
    data.transport.fetchPage = async (page, url) => {
      if (data.calls.read + 1 === readFailure) { data.calls.read++; throw new LegendAnalysisDomError('http-error') }
      return original(page, url)
    }
    data.transport.getDiagnostics = () => ({ requestCount: data.calls.read, lastAttemptedPage: 1, successfulReadCount: data.calls.read - 1,
      lastHttpStatus: 405, lastErrorCode: 'http-error', lastStep: 'ranking-navigation' })
    const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => data.transport })
    assert.equal(result.report.collectionPhase, phase)
    assert.equal(result.report.captureAttempt, 1)
    assert.equal(result.report.lastAttemptedPage, 1)
    assert.equal(result.report.successfulReadCount, readFailure - 1)
  }
  const act = await fixture(t)
  act.transport.confirmAct = async () => { throw new LegendAnalysisDomError('http-error') }
  act.transport.getDiagnostics = () => ({ requestCount: 2, lastAttemptedPage: null, successfulReadCount: 1, lastStep: 'act-navigation', lastErrorCode: 'http-error', lastHttpStatus: 405 })
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: act.output }, { now, launch: async () => act.transport })
  assert.equal(result.report.collectionPhase, 'act-recheck')
  assert.equal(result.report.lastAttemptedPage, null)
  assert.equal(result.report.captureAttempt, 1)
})

test('stdout report boundary accepts fixed enums and bounded integers and drops arbitrary identities and paths', () => {
  const report = summarizeLegendAnalysisCaptureReport({ status: 'failed', reason: SECRET, startedAt: SECRET, endedAt: SECRET,
    requestCount: 30, successfulReadCount: 31, retryCount: 999, captureAttempt: 999, collectionPhase: SECRET,
    lastAttemptedPage: Number.MAX_SAFE_INTEGER, datasetId: `legend-${SECRET}`, lastStep: SECRET, domErrorCode: SECRET,
    lastHttpStatus: 1000, lastSignedIn: SECRET, profileUrl: `https://example.com/${SECRET}`, storageState: { cookies: [SECRET] },
    localPath: `C:/Users/${SECRET}/private` })
  assert.equal(report.successfulReadCount, 0)
  assert.equal(report.retryCount, 0)
  assert.equal(report.captureAttempt, null)
  assert.equal(report.collectionPhase, 'preparation')
  assert.equal(report.lastAttemptedPage, null)
  assert.equal(report.datasetId, null)
  assert.equal(report.lastStep, null)
  assert.equal(report.domErrorCode, null)
  assert.equal(report.lastHttpStatus, null)
  assert.equal(JSON.stringify(report).includes(SECRET), false)
  assert.equal(JSON.stringify(report).includes('storageState'), false)
})
