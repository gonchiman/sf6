import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { runLegendAnalysisCollection } from './collect-legend-analysis.ts'
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
    getDiagnostics: () => ({ requestCount: calls.read }), close: async () => { calls.close++ },
  }
  return { root, output, transport, calls }
}

test('run persists aggregates only after all checks and successful browser closure', async t => {
  const data = await fixture(t)
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => data.transport })
  assert.equal(result.succeeded, true)
  assert.equal(data.calls.act, 1)
  assert.equal(data.calls.close, 1)
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
  failed.transport.getDiagnostics = () => ({ requestCount: failed.calls.read, lastHttpStatus: 405, lastErrorCode: 'http-error', lastStep: 'ranking-navigation' })
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: failed.output }, { now, launch: async () => failed.transport })
  assert.equal(result.succeeded, false)
  assert.equal(result.report.retryCount, 1)
  assert.equal(result.report.requestCount, 3)
  assert.equal(result.report.reason, 'access-unavailable')
  assert.equal(result.report.lastHttpStatus, 405)
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
