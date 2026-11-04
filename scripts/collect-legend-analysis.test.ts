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
import { validateLegendDailyBundle } from './lib/legend-analysis-daily-bundle.ts'

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

function withPlayers(transport: LegendAnalysisTransport): void {
  const read = transport.fetchPage
  transport.fetchPage = async (page, url) => {
    const value = await read(page, url)
    value.entries.forEach((entry, index) => Object.assign(entry, {
      playerName: `Synthetic player ${index}`, playerId: String(index + 1).padStart(10, '0'), region: '日本', platform: 'Steam',
    }))
    return value
  }
  transport.fetchPlayerRankedMatches = async (_id, characters) => Object.fromEntries(characters.map(id => [id, 123]))
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

test('explicit player opt-in persists v2 fields with public IDs and a separate profile scope', async t => {
  const data = await fixture(t)
  withPlayers(data.transport)
  let includePlayers: boolean | undefined
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, {
    now, launch: async (_state, _signal, _env, enabled) => { includePlayers = enabled; return data.transport },
  })
  assert.equal(result.succeeded, true)
  assert.equal(includePlayers, true)
  const playerDirectory = resolve(data.output, 'public/players')
  const manifest = JSON.parse(await readFile(resolve(playerDirectory, 'index.json'), 'utf8'))
  const players = JSON.parse(await readFile(resolve(playerDirectory, manifest.datasets[0].path), 'utf8'))
  assert.deepEqual(players.players, [
    { id: 'entry-1', playerName: 'Synthetic player 0', characterId: 'ryu', rank: 1, masterRating: 2400, playerId: '0000000001', region: '日本', platform: 'Steam', rankedMatchCount: 123 },
    { id: 'entry-2', playerName: 'Synthetic player 1', characterId: 'ryu', rank: 2, masterRating: 2399, playerId: '0000000002', region: '日本', platform: 'Steam', rankedMatchCount: 123 },
  ])
  assert.equal(players.schemaVersion, 2)
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(players.rankedMatchScope, { actId: 'act-13', mode: 'ranked', collectionStartedAt: now().toISOString(), collectionEndedAt: now().toISOString() })
  assert.equal(data.calls.act, 2)
  assert.equal(result.report.profileReadCount, 2)
  assert.equal(players.totalCount, 2)
  assert.doesNotMatch(JSON.stringify(players), /accountKey|profile\/|cookies|storageState|synthetic-secret/)
  assert.doesNotMatch(JSON.stringify(result), /Synthetic player|playerName|accountKey/)
  assert.doesNotMatch(await readFile(resolve(data.output, 'public', manifest.datasets[0].path), 'utf8'), /Synthetic player|playerName|entry-1/)
})

test('incomplete player capture writes only failure manifests and no fabricated or partial rows', async t => {
  const data = await fixture(t)
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, { now, launch: async () => data.transport })
  assert.equal(result.succeeded, false)
  assert.equal(result.report.reason, 'source-unconfirmed')
  assert.deepEqual(await readdir(resolve(data.output, 'public')), ['index.json', 'players'])
  assert.deepEqual(await readdir(resolve(data.output, 'public/players')), ['index.json'])
  const manifest = JSON.parse(await readFile(resolve(data.output, 'public/players/index.json'), 'utf8'))
  assert.deepEqual(manifest.datasets, [])
  assert.equal(manifest.availability.status, 'verification-pending')
})

test('player opt-in cannot publish a completed projection when browser closure fails', async t => {
  const data = await fixture(t)
  withPlayers(data.transport)
  data.transport.close = async () => { throw new Error('Synthetic player') }
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, { now, launch: async () => data.transport })
  assert.equal(result.succeeded, false)
  assert.deepEqual(await readdir(resolve(data.output, 'public/players')), ['index.json'])
  assert.doesNotMatch(await readFile(resolve(data.output, 'public/players/index.json'), 'utf8'), /Synthetic player/)
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

test('one profile read covers multiple listed characters of the same account and preserves confirmed zero', async t => {
  const data = await fixture(t)
  withPlayers(data.transport)
  const read = data.transport.fetchPage, profiles: { playerId: string; characterIds: readonly string[] }[] = []
  data.transport.fetchPage = async (page, url) => {
    const value = await read(page, url)
    Object.assign(value.entries[1], { accountKey: value.entries[0].accountKey, playerId: value.entries[0].playerId, characterId: 'arjun' })
    return value
  }
  data.transport.fetchPlayerRankedMatches = async (playerId, characterIds) => {
    profiles.push({ playerId, characterIds }); return { ryu: 0, arjun: 345 }
  }
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, { now, launch: async () => data.transport })
  assert.equal(result.succeeded, true)
  assert.deepEqual(profiles, [{ playerId: '0000000001', characterIds: ['ryu', 'arjun'] }])
  assert.equal(result.report.profileTotalCount, 1)
  assert.equal(result.report.profileReadCount, 1)
  const value = JSON.parse(await readFile(resolve(data.output, 'public/players', `${result.report.datasetId}.json`), 'utf8'))
  assert.deepEqual(value.players.map((row: { rankedMatchCount: number }) => row.rankedMatchCount), [0, 345])
})

test('unavailable profile counts stop enrichment and never publish partial rows or substitute zero', async t => {
  for (const count of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const data = await fixture(t)
    withPlayers(data.transport)
    let reads = 0
    data.transport.fetchPlayerRankedMatches = async () => { reads++; return count === undefined ? {} : { ryu: count } }
    const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, { now, launch: async () => data.transport })
    assert.equal(result.succeeded, false)
    assert.equal(result.report.reason, 'source-unconfirmed')
    assert.equal(reads, 1)
    assert.deepEqual(await readdir(resolve(data.output, 'public/players')), ['index.json'])
  }
})

test('profile CAPTCHA denial ends collection immediately and records bounded diagnostics without player IDs', async t => {
  const data = await fixture(t)
  withPlayers(data.transport)
  let reads = 0
  data.transport.fetchPlayerRankedMatches = async () => { reads++; throw new LegendAnalysisDomError('http-denied') }
  data.transport.getDiagnostics = () => ({ requestCount: 8, lastAttemptedPage: 1, successfulReadCount: 3,
    lastStep: 'profile-navigation', lastErrorCode: 'http-denied', lastHttpStatus: 403,
    humanVerification: { wafHeaderChecked: true, wafAction: 'captcha', domDetected: true } })
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, { now, launch: async () => data.transport })
  assert.equal(result.report.reason, 'access-unavailable')
  assert.equal(reads, 1)
  const safe = summarizeLegendAnalysisCaptureReport(result.report)
  assert.equal(safe.lastStep, 'profile-navigation')
  assert.equal(safe.humanVerification.wafAction, 'captcha')
  assert.equal(safe.profileReadCount, 0)
  assert.doesNotMatch(JSON.stringify(safe), /0000000001|Synthetic player/)
  assert.deepEqual(await readdir(resolve(data.output, 'public/players')), ['index.json'])
})

test('Act changes after profile collection invalidate the whole capture', async t => {
  const data = await fixture(t)
  withPlayers(data.transport)
  data.transport.confirmAct = async () => { if (++data.calls.act === 2) throw new LegendAnalysisDomError('act-changed') }
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, { now, launch: async () => data.transport })
  assert.equal(result.report.reason, 'source-changed')
  assert.equal(result.succeeded, false)
  assert.deepEqual(await readdir(resolve(data.output, 'public/players')), ['index.json'])
})

test('aggregate-only collection never calls player profile enrichment', async t => {
  const data = await fixture(t)
  data.transport.fetchPlayerRankedMatches = async () => { assert.fail('Unexpected profile request') }
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => data.transport })
  assert.equal(result.succeeded, true)
  assert.equal((await readdir(resolve(data.output, 'public'))).includes('players'), false)
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
    lastAttemptedPage: 1, successfulReadCount: 2, humanVerification: { wafHeaderChecked: true, wafAction: 'captcha', domDetected: true } })
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
  assert.equal(result.report.collectionErrorCode, null)
  assert.equal(result.report.validationCheck, null)
  assert.equal(result.report.recheckChangeKinds, null)
  assert.deepEqual(result.report.attemptFailures, [{ attempt: 1, phase: 'end-recheck', page: 1,
    code: 'source-changed', validationCheck: 'end-recheck', recheckChangeKinds: ['legend-entries'] }])
  const safe = summarizeLegendAnalysisCaptureReport(result.report)
  assert.deepEqual(safe.attemptFailures, result.report.attemptFailures)
  assert.deepEqual(safe.humanVerification, { wafHeaderChecked: true, wafAction: 'captcha', domDetected: true })
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
    requestCount: 30, successfulReadCount: 31, retryCount: 999, profileRetryCount: SECRET,
    pageRecoveryAttemptCount: SECRET, pageRecoverySuccessCount: 999, captureAttempt: 999, collectionPhase: SECRET,
    lastAttemptedPage: Number.MAX_SAFE_INTEGER, datasetId: `legend-${SECRET}`, lastStep: SECRET, domErrorCode: SECRET,
    lastHttpStatus: 1000, lastSignedIn: SECRET, profileUrl: `https://example.com/${SECRET}`, storageState: { cookies: [SECRET] },
    localPath: `C:/Users/${SECRET}/private`, collectionErrorCode: SECRET, validationCheck: SECRET, recheckChangeKinds: ['legend-entries', SECRET] })
  assert.equal(report.successfulReadCount, 0)
  assert.equal(report.retryCount, 0)
  assert.equal(report.profileRetryCount, 0)
  assert.equal(report.pageRecoveryAttemptCount, 0)
  assert.equal(report.pageRecoverySuccessCount, 0)
  assert.equal(report.captureAttempt, null)
  assert.equal(report.collectionPhase, 'preparation')
  assert.equal(report.lastAttemptedPage, null)
  assert.equal(report.datasetId, null)
  assert.equal(report.lastStep, null)
  assert.equal(report.domErrorCode, null)
  assert.equal(report.lastHttpStatus, null)
  assert.equal(report.collectionErrorCode, null)
  assert.equal(report.validationCheck, null)
  assert.equal(report.recheckChangeKinds, null)
  assert.equal(JSON.stringify(report).includes(SECRET), false)
  assert.equal(JSON.stringify(report).includes('storageState'), false)
  const known = summarizeLegendAnalysisCaptureReport({ collectionErrorCode: 'source-changed', validationCheck: 'end-recheck', recheckChangeKinds: ['non-legend-entries', 'metadata'], profileRetryCount: 2 })
  assert.equal(known.profileRetryCount, 2)
  assert.equal(known.collectionErrorCode, 'source-changed')
  assert.equal(known.validationCheck, 'end-recheck')
  assert.deepEqual(known.recheckChangeKinds, ['non-legend-entries', 'metadata'])
})

test('stdout bounds page recovery success by the single permitted attempt and defaults old reports to zero', () => {
  for (const value of [{}, { pageRecoveryAttemptCount: 0, pageRecoverySuccessCount: 1 },
    { pageRecoveryAttemptCount: 2, pageRecoverySuccessCount: 1 }]) {
    const safe = summarizeLegendAnalysisCaptureReport(value)
    assert.equal(safe.pageRecoveryAttemptCount, 0)
    assert.equal(safe.pageRecoverySuccessCount, 0)
  }
  const safe = summarizeLegendAnalysisCaptureReport({ pageRecoveryAttemptCount: 1, pageRecoverySuccessCount: 1 })
  assert.equal(safe.pageRecoveryAttemptCount, 1)
  assert.equal(safe.pageRecoverySuccessCount, 1)
})

test('adjacent page recovery reports its result and never retries a denied recheck', async t => {
  for (const denied of [false, true]) {
    const data = await fixture(t), pages: number[] = []
    data.transport.fetchPage = async (page, sourceUrl) => {
      pages.push(page); data.calls.read++
      if (denied && pages.length === 3) throw new LegendAnalysisDomError('http-denied')
      const offset = (page - 1) * 20
      const entries = Array.from({ length: 20 }, (_, index) => ({
        accountKey: (offset + index + 1).toString(16).padStart(64, '0'),
        characterId: 'ryu', rank: offset + index + 1, masterRating: 2400 - offset - index,
        isLegend: offset + index < 22,
      }))
      if (pages.length === 2) entries[0].accountKey = (20).toString(16).padStart(64, '0')
      return { sourceUrl, page, pageSize: 20, totalCount: 800000, from: offset + 1, to: offset + 20,
        nextPage: page + 1, actId: 'act-13', conditions: { ...LEGEND_ANALYSIS_CONDITIONS },
        conditionsConfirmed: true, actConfirmed: true, rosterConfirmed: true, entries }
    }
    const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => data.transport })
    const safe = summarizeLegendAnalysisCaptureReport(result.report)
    assert.equal(safe.pageRecoveryAttemptCount, 1)
    assert.equal(safe.pageRecoverySuccessCount, denied ? 0 : 1)
    assert.equal(safe.retryCount, 0)
    assert.equal(result.succeeded, !denied)
    assert.deepEqual(pages, denied ? [1, 2, 1] : [1, 2, 1, 2, 2, 1])
    if (denied) {
      assert.equal(result.report.reason, 'access-unavailable')
      assert.deepEqual(await readdir(resolve(data.output, 'public')), ['index.json'])
    } else {
      assert.deepEqual(await validateLegendAnalysisDirectory(resolve(data.output, 'public')), { datasets: 1, entries: 22 })
    }
  }
})

test('order recovery publishes only the fully verified player list and preserves denied-recovery diagnostics', async t => {
  for (const denied of [false, true]) {
    const data = await fixture(t), pages: number[] = []
    let rechecks = 0, profiles = 0
    data.transport.fetchPage = async (page, sourceUrl) => {
      pages.push(page); data.calls.read++
      if (denied && pages.length === 3) throw new LegendAnalysisDomError('http-denied')
      const offset = (page - 1) * 20
      const entries = Array.from({ length: 20 }, (_, index) => ({
        accountKey: (offset + index + 1).toString(16).padStart(64, '0'), characterId: 'ryu',
        rank: offset + index + 1, masterRating: 2400 - offset - index, isLegend: offset + index < 22,
        playerName: `Synthetic player ${offset + index + 1}`, playerId: String(offset + index + 1), region: '日本', platform: 'Steam',
      }))
      if (pages.length === 2) entries[0].rank = 19
      return { sourceUrl, page, pageSize: 20, totalCount: 800000, from: offset + 1, to: offset + 20,
        nextPage: page + 1, actId: 'act-13', conditions: { ...LEGEND_ANALYSIS_CONDITIONS },
        conditionsConfirmed: true, actConfirmed: true, rosterConfirmed: true, entries }
    }
    data.transport.recheckOrderFailure = async (page, rowIndex) => {
      rechecks++; assert.equal(pages.length, 2); assert.equal(page.page, 2); assert.equal(rowIndex, 1)
      return { status: 'unavailable', elapsedMs: 1000 }
    }
    data.transport.fetchPlayerRankedMatches = async () => { profiles++; return { ryu: 123 } }
    const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, { now, launch: async () => data.transport })
    const safe = summarizeLegendAnalysisCaptureReport(result.report)
    assert.equal(result.succeeded, !denied)
    assert.equal(safe.pageRecoveryAttemptCount, 1); assert.equal(safe.pageRecoverySuccessCount, denied ? 0 : 1)
    assert.equal(safe.retryCount, 0); assert.equal(rechecks, 1); assert.equal(profiles, denied ? 0 : 22)
    assert.deepEqual(pages, denied ? [1, 2, 1] : [1, 2, 1, 2, 2, 1])
    if (denied) {
      assert.equal(safe.reason, 'access-unavailable')
      assert.equal(safe.attemptFailures[0].orderDiagnostic?.current.rank, 19)
      assert.deepEqual(safe.attemptFailures[0].orderRecheck, { status: 'unavailable', elapsedMs: 1000 })
      assert.deepEqual(await readdir(resolve(data.output, 'public/players')), ['index.json'])
    } else {
      assert.deepEqual(safe.attemptFailures, [])
      const players = JSON.parse(await readFile(resolve(data.output, 'public/players', `${result.report.datasetId}.json`), 'utf8'))
      assert.equal(players.totalCount, 22)
      assert.deepEqual(players.players.map((row: { rank: number }) => row.rank), Array.from({ length: 22 }, (_, index) => index + 1))
      assert.equal(new Set(players.players.map((row: { playerId: string }) => row.playerId)).size, 22)
      assert.doesNotMatch(JSON.stringify(players), /orderDiagnostic|orderRecheck|accountKey/)
    }
    assert.doesNotMatch(JSON.stringify(safe), /Synthetic player|playerId|accountKey/)
  }
})

test('collector MR-order failure propagates fixed diagnostics through the CLI and stdout summary', async t => {
  const data = await fixture(t), read = data.transport.fetchPage
  data.transport.fetchPage = async (page, url) => { const value = await read(page, url); value.entries[1].masterRating = 9999; return value }
  const rechecks: { page: number; rowIndex: number }[] = []
  const orderDiagnostic = { boundary: 'within-page', previous: { page: 1, rowIndex: 1, rank: 1, masterRating: 2400 },
    current: { page: 1, rowIndex: 2, rank: 2, masterRating: 9999 }, sameEntry: false,
    duplicateInAccepted: false, duplicateWithinCurrentPage: false }
  const orderRecheck = { status: 'observed' as const, elapsedMs: 1000, page: 1, from: 1, to: 20, totalCount: 800001,
    sameEntries: true, sameRanksAndMr: false, previous: { rank: 1, masterRating: 2400 }, current: { rank: 2, masterRating: 2399 },
    currentSameEntry: true, previousSameEntry: true, rankInversionWithinPage: false, mrInversionWithinPage: false }
  data.transport.recheckOrderFailure = async (page, rowIndex) => {
    rechecks.push({ page: page.page, rowIndex })
    assert.equal(page.entries[rowIndex - 1].masterRating, 9999)
    return { ...orderRecheck, rawEntries: [{ playerName: SECRET, playerId: SECRET }], url: SECRET }
  }
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => data.transport })
  assert.equal(result.report.reason, 'source-changed')
  assert.equal(result.report.collectionErrorCode, 'source-changed')
  assert.equal(result.report.validationCheck, 'mr-order')
  assert.equal(result.report.captureAttempt, 2)
  assert.equal(result.report.retryCount, 1)
  assert.equal(result.report.recheckChangeKinds, null)
  const safe = summarizeLegendAnalysisCaptureReport(result.report)
  assert.equal(safe.collectionErrorCode, 'source-changed')
  assert.equal(safe.validationCheck, 'mr-order')
  assert.equal(safe.attemptFailures.length, 2)
  assert.deepEqual(safe.attemptFailures.map(item => [item.attempt, item.validationCheck]), [[1, 'mr-order'], [2, 'mr-order']])
  assert.deepEqual(rechecks, [{ page: 1, rowIndex: 2 }, { page: 1, rowIndex: 2 }])
  assert.equal(data.calls.read, 2)
  for (const failure of safe.attemptFailures) {
    assert.deepEqual(failure.orderDiagnostic, orderDiagnostic)
    assert.deepEqual(failure.orderRecheck, orderRecheck)
  }
  assert.deepEqual(safe.attemptFailures, result.report.attemptFailures)
  for (const value of ['accountKey', 'playerName', 'playerId', 'rawEntries', SECRET]) assert.equal(JSON.stringify(result).includes(value), false)
  assert.deepEqual(await readdir(resolve(data.output, 'public')), ['index.json'])
  assert.doesNotMatch(await readFile(resolve(data.output, 'public/index.json'), 'utf8'), /orderDiagnostic|orderRecheck|masterRating/)
})

test('a recovery range exceeding the page limit retains its conflict through retries and CAPTCHA without partial publication', async t => {
  for (const denied of [true, false]) {
    const data = await fixture(t), pages: number[] = []
    let rechecks = 0, profiles = 0
    data.transport.fetchPage = async (page, sourceUrl) => {
      pages.push(page); data.calls.read++
      if (denied && pages.length === 8) throw new LegendAnalysisDomError('http-denied')
      const offset = (page - 1) * 20
      const entries = Array.from({ length: 20 }, (_, index) => ({
        accountKey: (offset + index + 1).toString(16).padStart(64, '0'), characterId: 'ryu',
        rank: offset + index + 1, masterRating: 2400 - offset - index, isLegend: offset + index < 122,
        playerName: `Synthetic player ${offset + index + 1}`, playerId: String(offset + index + 1), region: '日本', platform: 'Steam',
      }))
      if (pages.length === 7) {
        entries[0].rank = 119 // Boundary reversal: previous page ended at rank 120.
        // The later duplicate requires seven pages, exceeding the bounded recovery range.
        entries[1].accountKey = (10).toString(16).padStart(64, '0')
        entries[1].playerId = '10'; entries[1].playerName = 'Synthetic player 10'
      }
      return { sourceUrl, page, pageSize: 20, totalCount: 800000, from: offset + 1, to: offset + 20,
        nextPage: page + 1, actId: 'act-13', conditions: { ...LEGEND_ANALYSIS_CONDITIONS },
        conditionsConfirmed: true, actConfirmed: true, rosterConfirmed: true, entries }
    }
    data.transport.recheckOrderFailure = async () => { rechecks++; return { status: 'unavailable', elapsedMs: 1000 } }
    data.transport.fetchPlayerRankedMatches = async () => { profiles++; return { ryu: 123 } }
    data.transport.getDiagnostics = () => ({ requestCount: data.calls.read, lastAttemptedPage: pages.at(-1) ?? null,
      successfulReadCount: data.calls.read - (denied ? 1 : 0), lastStep: denied ? 'ranking-navigation' : 'complete',
      lastHttpStatus: denied ? 405 : 200, lastErrorCode: denied ? 'http-denied' : null,
      humanVerification: { wafHeaderChecked: true, wafAction: denied ? 'captcha' : null, domDetected: denied } })
    const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, { now, launch: async () => data.transport })
    const safe = summarizeLegendAnalysisCaptureReport(result.report)
    const expected = { trigger: 'rank-order', eligible: false, reason: 'recovery-range-too-wide', page: 7, previousPage: 6, recoveryUsed: false,
      conflict: { previous: { page: 1, rowIndex: 10, rank: 10, masterRating: 2391 },
        current: { page: 7, rowIndex: 2, rank: 122, masterRating: 2279 } } }
    assert.equal(result.succeeded, !denied)
    assert.equal(safe.pageRecoveryAttemptCount, 0); assert.equal(safe.pageRecoverySuccessCount, 0)
    assert.equal(safe.retryCount, 1); assert.equal(rechecks, 1); assert.equal(profiles, denied ? 0 : 122)
    assert.deepEqual(pages, denied ? [1, 2, 3, 4, 5, 6, 7, 1] : [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7, 7, 1])
    assert.equal(Object.hasOwn(safe, 'pageRecoveryRange'), false)
    assert.equal(safe.attemptFailures.length, 1)
    assert.equal(safe.attemptFailures[0].validationCheck, 'rank-order')
    assert.deepEqual(safe.attemptFailures[0].pageRecoveryDecision, expected)
    assert.deepEqual(result.report.attemptFailures, safe.attemptFailures)
    assert.deepEqual(summarizeLegendAnalysisCaptureReport(safe).attemptFailures, safe.attemptFailures)
    assert.doesNotMatch(JSON.stringify(safe), /Synthetic player|accountKey|playerId|playerName|profileUrl|synthetic-secret/)
    if (denied) {
      assert.equal(safe.reason, 'access-unavailable')
      assert.equal(safe.humanVerification.wafAction, 'captcha')
      assert.equal(safe.captureAttempt, 2)
      assert.deepEqual(await readdir(resolve(data.output, 'public/players')), ['index.json'])
    }
    for (const directory of ['public', 'public/players']) for (const filename of (await readdir(resolve(data.output, directory))).filter(name => name.endsWith('.json'))) {
      assert.doesNotMatch(await readFile(resolve(data.output, directory, filename), 'utf8'), /pageRecoveryRange|pageRecoveryDecision|orderDiagnostic|orderRecheck|attemptFailures|recovery-range-too-wide/)
    }
  }
})

test('range recovery reports validated pages and survives later failures without publishing partial player data', async t => {
  for (const stop of ['none', 'range', 'after-recovery', 'next-attempt'] as const) {
    const data = await fixture(t), pages: number[] = []
    let denied = false, profiles = 0
    data.transport.fetchPage = async (page, sourceUrl) => {
      pages.push(page); data.calls.read++
      if ((stop === 'range' && pages.length === 7) || (stop === 'after-recovery' && pages.length === 10)
        || (stop === 'next-attempt' && pages.length === 11)) {
        denied = true
        throw new LegendAnalysisDomError('http-denied')
      }
      const offset = (page - 1) * 20
      const entries = Array.from({ length: 20 }, (_, index) => ({
        accountKey: (offset + index + 1).toString(16).padStart(64, '0'), characterId: 'ryu',
        rank: offset + index + 1, masterRating: 2400 - offset - index, isLegend: offset + index < 82,
        playerName: `Synthetic player ${offset + index + 1}`, playerId: String(offset + index + 1), region: '日本', platform: 'Steam',
      }))
      if (pages.length === 5) {
        entries[0].accountKey = (50).toString(16).padStart(64, '0')
        entries[0].playerId = '50'; entries[0].playerName = 'Synthetic player 50'
      }
      if (stop === 'next-attempt' && pages.length === 10) entries[19].masterRating--
      return { sourceUrl, page, pageSize: 20, totalCount: 800000, from: offset + 1, to: offset + 20,
        nextPage: page + 1, actId: 'act-13', conditions: { ...LEGEND_ANALYSIS_CONDITIONS },
        conditionsConfirmed: true, actConfirmed: true, rosterConfirmed: true, entries }
    }
    data.transport.fetchPlayerRankedMatches = async () => { profiles++; return { ryu: 123 } }
    data.transport.getDiagnostics = () => ({ requestCount: data.calls.read, lastAttemptedPage: pages.at(-1) ?? null,
      successfulReadCount: data.calls.read - (denied ? 1 : 0), lastStep: denied ? 'ranking-navigation' : 'complete',
      lastHttpStatus: denied ? 405 : 200, lastErrorCode: denied ? 'http-denied' : null,
      humanVerification: { wafHeaderChecked: true, wafAction: denied ? 'captcha' : null, domDetected: denied } })
    const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output, includePlayers: true }, { now, launch: async () => data.transport })
    const safe = summarizeLegendAnalysisCaptureReport(result.report)
    const expectedRange = { attempt: 1, fromPage: 3, toPage: 5,
      lastValidatedPage: stop === 'range' ? 3 : 5, status: stop === 'range' ? 'failed' : 'succeeded' }
    assert.deepEqual(result.report.pageRecoveryRange, expectedRange)
    assert.deepEqual(safe.pageRecoveryRange, expectedRange)
    assert.deepEqual(summarizeLegendAnalysisCaptureReport(safe).pageRecoveryRange, expectedRange)
    assert.equal(safe.pageRecoveryAttemptCount, 1)
    assert.equal(safe.pageRecoverySuccessCount, stop === 'range' ? 0 : 1)
    assert.equal(safe.retryCount, stop === 'next-attempt' ? 1 : 0)
    assert.equal(result.succeeded, stop === 'none')
    assert.equal(profiles, stop === 'none' ? 82 : 0)
    const prefix = [1, 2, 3, 4, 5, 3, 4]
    const expectedPages = stop === 'range' ? prefix
      : stop === 'after-recovery' ? [...prefix, 5, 2, 5] : [...prefix, 5, 2, 5, 1]
    assert.deepEqual(pages, expectedPages)
    assert.equal(safe.requestCount, expectedPages.length)
    assert.equal(safe.successfulReadCount, expectedPages.length - (denied ? 1 : 0))
    assert.doesNotMatch(JSON.stringify(safe), /Synthetic player|accountKey|playerId|playerName|profileUrl|synthetic-secret/)
    if (denied) {
      assert.equal(safe.reason, 'access-unavailable')
      assert.equal(safe.humanVerification.wafAction, 'captcha')
      assert.equal(safe.captureAttempt, stop === 'next-attempt' ? 2 : 1)
      assert.deepEqual(await readdir(resolve(data.output, 'public')), ['index.json', 'players'])
      assert.deepEqual(await readdir(resolve(data.output, 'public/players')), ['index.json'])
    } else {
      assert.deepEqual(await validateLegendDailyBundle(resolve(data.output, 'public'), true), { datasets: 1, entries: 82 })
      const players = JSON.parse(await readFile(resolve(data.output, 'public/players', `${safe.datasetId}.json`), 'utf8'))
      assert.equal(players.players.length, 82)
      assert.equal(new Set(players.players.map((row: { playerId: string }) => row.playerId)).size, 82)
    }
    for (const directory of ['public', 'public/players']) for (const filename of (await readdir(resolve(data.output, directory))).filter(name => name.endsWith('.json'))) {
      assert.doesNotMatch(await readFile(resolve(data.output, directory, filename), 'utf8'), /pageRecoveryRange|lastValidatedPage|pageRecoveryDecision|orderDiagnostic|orderRecheck|attemptFailures/)
    }
  }
})

test('stdout range records allow only bounded progress and fixed states while preserving old reports', () => {
  const base = { attempt: 1, fromPage: 3, toPage: 5, lastValidatedPage: 5, status: 'succeeded' }
  for (const range of [base, { ...base, status: 'started', lastValidatedPage: null },
    { ...base, status: 'failed', lastValidatedPage: 4 }]) {
    const safe = summarizeLegendAnalysisCaptureReport({ pageRecoveryRange: { ...range,
      playerId: SECRET, playerName: SECRET, accountKey: SECRET, raw: [SECRET], toJSON: () => SECRET } })
    assert.deepEqual(safe.pageRecoveryRange, range)
    assert.deepEqual(summarizeLegendAnalysisCaptureReport(safe).pageRecoveryRange, range)
    assert.doesNotMatch(JSON.stringify(safe), /playerId|playerName|accountKey|raw|toJSON|synthetic-secret/)
  }
  for (const range of [undefined, null, { ...base, attempt: 0 }, { ...base, fromPage: 0 },
    { ...base, toPage: 2 }, { ...base, toPage: 9 }, { ...base, lastValidatedPage: 6 },
    { ...base, lastValidatedPage: null }, { ...base, status: SECRET }]) {
    const safe = summarizeLegendAnalysisCaptureReport(range === undefined ? {} : { pageRecoveryRange: range })
    assert.equal(Object.hasOwn(safe, 'pageRecoveryRange'), false)
  }
})

test('stdout allowlists recovery decisions and preserves legacy failures without optional decision records', () => {
  const decision = { trigger: 'rank-order', eligible: false, reason: 'earlier-page-duplicate', page: 3, previousPage: 2, recoveryUsed: false,
    conflict: { previous: { page: 1, rowIndex: 10, rank: 10, masterRating: 2391 },
      current: { page: 3, rowIndex: 2, rank: 42, masterRating: 2359 } } }
  const failure = { attempt: 1, phase: 'listing', page: 3, code: 'source-changed', validationCheck: 'rank-order', recheckChangeKinds: null }
  const safe = summarizeLegendAnalysisCaptureReport({ attemptFailures: [
    { ...failure, pageRecoveryDecision: { ...decision, message: SECRET, url: SECRET, playerId: SECRET,
      conflict: { ...decision.conflict, accountKey: SECRET,
        previous: { ...decision.conflict.previous, playerName: SECRET }, current: { ...decision.conflict.current, profileUrl: SECRET } } } },
    { ...failure, attempt: 2, pageRecoveryDecision: { ...decision, reason: SECRET, rawEntries: [SECRET] } },
    { ...failure, attempt: 3 },
  ] })
  assert.deepEqual(safe.attemptFailures, [{ ...failure, pageRecoveryDecision: decision }, { ...failure, attempt: 2 }, { ...failure, attempt: 3 }])
  for (const value of [SECRET, 'accountKey', 'playerName', 'playerId', 'profileUrl', 'message', 'rawEntries', 'url']) assert.equal(JSON.stringify(safe).includes(value), false)
  assert.deepEqual(summarizeLegendAnalysisCaptureReport(safe).attemptFailures, safe.attemptFailures)
})

test('legacy transports retain numeric order diagnostics without requiring a DOM recheck method', async t => {
  const data = await fixture(t), read = data.transport.fetchPage
  data.transport.fetchPage = async (page, url) => { const value = await read(page, url); value.entries[2].rank = 1; return value }
  const result = await runLegendAnalysisCollection({ storageState: state, outputDirectory: data.output }, { now, launch: async () => data.transport })
  const safe = summarizeLegendAnalysisCaptureReport(result.report)
  assert.equal(result.succeeded, false)
  assert.equal(safe.validationCheck, 'rank-order')
  assert.equal(safe.attemptFailures.length, 2)
  for (const failure of safe.attemptFailures) {
    assert.deepEqual(failure.orderDiagnostic?.previous, { page: 1, rowIndex: 2, rank: 2, masterRating: 2399 })
    assert.deepEqual(failure.orderDiagnostic?.current, { page: 1, rowIndex: 3, rank: 1, masterRating: 2398 })
    assert.equal(Object.hasOwn(failure, 'orderRecheck'), false)
  }
  assert.equal(data.calls.read, 2)
})

test('stdout sanitizes bounded attempt history and distinguishes unobserved challenge evidence', () => {
  const failure = { attempt: 1, phase: 'listing', page: 19, code: 'duplicate-entry', validationCheck: 'duplicate-entry',
    recheckChangeKinds: null, message: SECRET, playerName: SECRET, profileUrl: SECRET }
  const safe = summarizeLegendAnalysisCaptureReport({ attemptFailures: [failure, { ...failure, attempt: SECRET },
    { ...failure, attempt: 2, page: SECRET, validationCheck: SECRET, recheckChangeKinds: [SECRET] }, failure],
    humanVerification: { wafHeaderChecked: false, wafAction: 'captcha', domDetected: SECRET, body: SECRET } })
  assert.deepEqual(safe.attemptFailures, [
    { attempt: 1, phase: 'listing', page: 19, code: 'duplicate-entry', validationCheck: 'duplicate-entry', recheckChangeKinds: null },
    { attempt: 2, phase: 'listing', page: null, code: 'duplicate-entry', validationCheck: 'unclassified', recheckChangeKinds: null },
  ])
  assert.deepEqual(safe.humanVerification, { wafHeaderChecked: false, wafAction: null, domDetected: null })
  assert.equal(JSON.stringify(safe).includes(SECRET), false)
  assert.deepEqual(summarizeLegendAnalysisCaptureReport({ humanVerification: { wafHeaderChecked: true, wafAction: null, domDetected: false } }).humanVerification,
    { wafHeaderChecked: true, wafAction: null, domDetected: false })
})

test('stdout retains only allowlisted order values and drops malicious nested diagnostics', () => {
  const orderDiagnostic = { boundary: 'between-pages', previous: { page: 1, rowIndex: 20, rank: 20, masterRating: 2381 },
    current: { page: 2, rowIndex: 1, rank: 21, masterRating: 2382 }, sameEntry: false,
    duplicateInAccepted: false, duplicateWithinCurrentPage: false }
  const orderRecheck = { status: 'observed', elapsedMs: 1000, page: 2, from: 21, to: 40, totalCount: 800000,
    sameEntries: false, sameRanksAndMr: true, previous: null, current: { rank: 21, masterRating: 2382 },
    currentSameEntry: false, previousSameEntry: null, rankInversionWithinPage: false, mrInversionWithinPage: false }
  const failure = { attempt: 1, phase: 'listing', page: 2, code: 'source-changed', validationCheck: 'mr-order', recheckChangeKinds: null }
  const safe = summarizeLegendAnalysisCaptureReport({ attemptFailures: [
    { ...failure,
      orderDiagnostic: { ...orderDiagnostic, previous: { ...orderDiagnostic.previous, accountKey: SECRET },
        current: { ...orderDiagnostic.current, playerName: SECRET, playerId: SECRET }, message: SECRET },
      orderRecheck: { ...orderRecheck, current: { ...orderRecheck.current, profileUrl: SECRET }, body: SECRET, entries: [SECRET] } },
    { ...failure, attempt: 2, orderDiagnostic: { ...orderDiagnostic, previous: { ...orderDiagnostic.previous, rank: SECRET } },
      orderRecheck: { ...orderRecheck, sameEntries: SECRET } },
    { ...failure, attempt: 3, orderDiagnostic: { ...orderDiagnostic, boundary: SECRET },
      orderRecheck: { status: 'failed', message: SECRET, url: SECRET, elapsedMs: SECRET } },
  ] })
  assert.deepEqual(safe.attemptFailures, [
    { ...failure, orderDiagnostic, orderRecheck },
    { ...failure, attempt: 2 },
    { ...failure, attempt: 3, orderRecheck: { status: 'failed' } },
  ])
  for (const value of [SECRET, 'accountKey', 'playerName', 'playerId', 'profileUrl', 'message', 'body', 'entries']) assert.equal(JSON.stringify(safe).includes(value), false)
  assert.deepEqual(summarizeLegendAnalysisCaptureReport(safe).attemptFailures, safe.attemptFailures)
})
