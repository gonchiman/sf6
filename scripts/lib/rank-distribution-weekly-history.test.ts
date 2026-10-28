import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_ESTIMATE_CHECKS, RANK_DISTRIBUTION_SOURCE } from '../../src/lib/rankDistribution.ts'
import type { RankDistributionDataset } from '../../src/types/rankDistribution.ts'
import { summarizeRankDistributionCloudCapture } from '../collect-rank-distribution-cloud.ts'
import { RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'
import type { RankDistributionCheckpoint } from './rank-distribution-checkpoint.ts'
import {
  loadWeeklyHistory, parseRankDistributionWeeklyRunReport, RankDistributionWeeklyHistoryError, writeWeeklyHistoryOutput,
} from './rank-distribution-weekly-history.ts'
import type { RankDistributionWeeklyRunReport } from './rank-distribution-weekly-history.ts'

const NOW = () => new Date('2026-10-24T00:00:00.000Z')
const START = '2026-10-22T12:00:00.000Z'
const later = (value: string, milliseconds: number) => new Date(Date.parse(value) + milliseconds).toISOString()
function dataset(start = START): RankDistributionDataset {
  const observedAt = later(start, 30000)
  return { schemaVersion: 1, id: `max-lp-estimate-${start.replace(/[:.]/g, '-')}`, captureStartedAt: start,
    captureEndedAt: later(start, 60000), generatedAt: later(start, 120000),
    source: { ...RANK_DISTRIBUTION_SOURCE, population: 'synthetic listed accounts', metric: 'synthetic ranks', unit: 'fighter-account', notes: ['synthetic aggregate fixture'] },
    conditions: { ...RANK_DISTRIBUTION_CONDITIONS }, method: 'boundary-search-estimate', totalCount: 36,
    entries: Array.from({ length: 36 }, (_, i) => ({ rankId: i + 1, count: 1 })),
    validation: { status: 'estimated', coverage: 'all-rank-boundaries', checks: [...RANK_DISTRIBUTION_ESTIMATE_CHECKS], notes: ['synthetic complete boundary proof'] },
    observation: { totalAtStart: 36, totalAtEnd: 36, minTotal: 36, maxTotal: 36,
      boundaries: Array.from({ length: 35 }, (_, i) => ({ rankId: i + 2, countAtOrAbove: 35 - i, totalCount: 36, observedAt })) } }
}
function checkpoint(start = START, ranks = [2, 36]): RankDistributionCheckpoint {
  return { schemaVersion: 1, method: 'boundary-search-estimate', sourceUrl: RANK_BOUNDARY_SOURCE_URL, pageSize: 20,
    savedAt: later(start, 30000), hints: ranks.map(rankId => ({ rankId, countAtOrAbove: 37 - rankId, totalCount: 36, observedAt: later(start, 30000) })) }
}
function report(options: { start?: string; failed?: boolean; id?: string } = {}): RankDistributionWeeklyRunReport {
  const start = options.start ?? START
  const capturedAt = '2026-10-14T00:00:00.000Z'
  return { schemaVersion: 1, id: options.id ?? 'run-100-1', startedAt: start, endedAt: later(start, 180000), event: 'schedule',
    status: options.failed ? 'failed' : 'succeeded', failureReason: options.failed ? 'collection-failed' : null,
    sessionCapturedAt: capturedAt, sessionUploadedAt: '2026-10-14T01:00:00.000Z',
    sessionAgeSeconds: Math.floor((Date.parse(start) - Date.parse(capturedAt)) / 1000), initialSignInConfirmed: true,
    reuseAfterSevenDays: 'confirmed', datasetId: options.failed ? null : dataset(start).id,
    capture: summarizeRankDistributionCloudCapture({ status: options.failed ? 'failed' : 'succeeded', stage: options.failed ? 'collection' : 'complete',
      reason: options.failed ? 'read-failed' : null, startedAt: start, endedAt: later(start, 60000), requestCount: 40, successfulReadCount: 40,
      confirmedBoundaryCount: options.failed ? 10 : 35, datasetSaved: !options.failed, published: !options.failed, browserClosed: true,
      totalMin: 36, totalMax: 36, totalAtEnd: 36, lastHttpStatus: 200 }) }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sf6-weekly-history-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir())))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}
const rejects = (code: string) => (error: unknown) => error instanceof RankDistributionWeeklyHistoryError && error.code === code

test('weekly report derives seven-day evidence from the original capture and rejects fake confirmations and secret fields', () => {
  assert.equal(parseRankDistributionWeeklyRunReport(report(), NOW).reuseAfterSevenDays, 'confirmed')
  const early = report({ start: '2026-10-15T12:00:00.000Z' })
  early.reuseAfterSevenDays = 'pending'
  assert.equal(parseRankDistributionWeeklyRunReport(early, NOW).reuseAfterSevenDays, 'pending')
  for (const value of [
    { ...early, reuseAfterSevenDays: 'confirmed' }, { ...report(), sessionAgeSeconds: 1 },
    { ...report(), sessionUploadedAt: '2026-10-23T00:00:00.000Z' }, { ...report(), id: '../private' },
    { ...report(), storageState: { cookies: ['synthetic-secret'] } },
    { ...report(), capture: { ...report().capture, privateDOM: 'synthetic-secret' } },
    { ...report(), capture: { ...report().capture, confirmedBoundaryCount: 34 } },
  ]) assert.throws(() => parseRankDistributionWeeklyRunReport(value, NOW), rejects('invalid-report'))
  assert.throws(() => parseRankDistributionWeeklyRunReport(report(), () => new Date('2026-10-21T00:00:00.000Z')), rejects('future-record'))
  const missing = { ...report({ failed: true }), sessionCapturedAt: null, sessionUploadedAt: null, sessionAgeSeconds: null,
    initialSignInConfirmed: false, capture: null, reuseAfterSevenDays: 'unconfirmed' }
  assert.equal(parseRankDistributionWeeklyRunReport(missing, NOW).reuseAfterSevenDays, 'unconfirmed')
  assert.throws(() => parseRankDistributionWeeklyRunReport({ ...missing, initialSignInConfirmed: true }, NOW), rejects('invalid-report'))
})

test('synthetic completed week stages one valid dataset, one report and aggregate checkpoint only', async t => {
  const root = await fixture(t)
  const previous = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const output = join(root, 'output')
  const saved = await writeWeeklyHistoryOutput({ previous, run: report(), dataset: dataset(), checkpoint: checkpoint(), directory: output, now: NOW })
  assert.equal(saved.datasets.length, 1)
  assert.equal(saved.runs.length, 1)
  assert.equal(saved.checkpoint!.hints.length, 2)
  assert.deepEqual(await loadWeeklyHistory(output, NOW, { allowGit: false, requirePresent: true }), saved)
  const text = await readFile(join(output, 'runs/run-100-1.json'), 'utf8')
  assert.equal(text.includes('cookies'), false)
  assert.equal(text.includes('accountKey'), false)
  await assert.rejects(writeWeeklyHistoryOutput({ previous, run: report(), dataset: dataset(), directory: output, now: NOW }), rejects('output-exists'))
})

test('failed week keeps every old normal dataset and merges partial new checkpoint positions', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const priorStart = '2026-10-15T12:00:00.000Z'
  const oldReport = report({ start: priorStart, id: 'run-99-1' }); oldReport.reuseAfterSevenDays = 'pending'
  const previous = await writeWeeklyHistoryOutput({ previous: empty, run: oldReport, dataset: dataset(priorStart),
    checkpoint: checkpoint(priorStart, [2, 20]), directory: join(root, 'previous'), now: NOW })
  const saved = await writeWeeklyHistoryOutput({ previous, run: report({ failed: true }), checkpoint: checkpoint(START, [2, 36]),
    directory: join(root, 'next'), now: NOW })
  assert.deepEqual(saved.datasets, previous.datasets)
  assert.equal(saved.runs.length, 2)
  assert.deepEqual(saved.checkpoint!.hints.map(hint => hint.rankId), [2, 20, 36])
  assert.equal(saved.checkpoint!.hints[0].observedAt, checkpoint().hints[0].observedAt)
})

test('a second successful week appends a capture without replacing historical results', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const oldStart = '2026-10-15T12:00:00.000Z'
  const oldReport = report({ start: oldStart, id: 'run-99-1' }); oldReport.reuseAfterSevenDays = 'pending'
  const previous = await writeWeeklyHistoryOutput({ previous: empty, run: oldReport, dataset: dataset(oldStart), directory: join(root, 'previous'), now: NOW })
  const next = await writeWeeklyHistoryOutput({ previous, run: report(), dataset: dataset(), directory: join(root, 'output'), now: NOW })
  assert.equal(next.datasets.length, 2)
  assert.deepEqual(next.datasets.find(item => item.id === previous.datasets[0].id), previous.datasets[0])
})

test('a later ordinary failure does not retain a stale CAPTCHA status or reinterpret its own HTTP 405', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const complete = await writeWeeklyHistoryOutput({ previous: empty, run: report(), dataset: dataset(),
    directory: join(root, 'complete'), now: NOW })
  const challenged = report({ start: later(START, 240000), id: 'run-101-1', failed: true })
  challenged.capture = { ...challenged.capture!, reason: 'captcha', readFailureCode: 'human-verification', lastHttpStatus: 405,
    humanVerification: { wafHeaderChecked: true, wafAction: 'captcha', domDetected: null } }
  const stopped = await writeWeeklyHistoryOutput({ previous: complete, run: challenged, directory: join(root, 'challenged'), now: NOW })
  assert.match(stopped.manifest.availability!.message, /CAPTCHA/)
  const ordinary = report({ start: later(START, 480000), id: 'run-102-1', failed: true })
  ordinary.capture = { ...ordinary.capture!, readFailureCode: 'http-error', lastHttpStatus: 405 }
  const next = await writeWeeklyHistoryOutput({ previous: stopped, run: ordinary, directory: join(root, 'ordinary'), now: NOW })
  assert.equal(next.manifest.availability, undefined)
  assert.deepEqual(next.datasets, complete.datasets)
  assert.deepEqual(next.runs.find(run => run.id === challenged.id), challenged)
  const savedOrdinary = next.runs.find(run => run.id === ordinary.id)!
  assert.deepEqual(savedOrdinary, ordinary)
  assert.equal(Object.hasOwn(savedOrdinary.capture!, 'humanVerification'), false)
})

test('Git metadata is skipped, initial history needs no runs directory, and extra sensitive files are refused', async t => {
  const root = await fixture(t)
  const previous = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const path = join(root, 'history')
  await writeWeeklyHistoryOutput({ previous, run: report(), dataset: dataset(), directory: path, now: NOW })
  await rm(join(path, 'runs'), { recursive: true })
  await mkdir(join(path, '.git'))
  await writeFile(join(path, '.git', 'config'), 'synthetic-not-for-upload')
  assert.equal((await loadWeeklyHistory(path, NOW)).datasets.length, 1)
  await assert.rejects(loadWeeklyHistory(path, NOW, { allowGit: false }), rejects('invalid-history'))
  await writeFile(join(path, 'storage-state.json'), '{"cookies":["synthetic-secret"]}')
  await assert.rejects(loadWeeklyHistory(path, NOW), rejects('invalid-history'))
})

test('unknown dataset fields, extra data files, hard links and linked directories never become a snapshot', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  await assert.rejects(writeWeeklyHistoryOutput({ previous: empty, run: report(),
    dataset: { ...dataset(), accountRows: ['synthetic-secret'] } as RankDistributionDataset,
    directory: join(root, 'invalid'), now: NOW }), error => error instanceof RankDistributionWeeklyHistoryError && !error.message.includes('synthetic-secret'))
  const path = join(root, 'history')
  await writeWeeklyHistoryOutput({ previous: empty, run: report(), dataset: dataset(), directory: path, now: NOW })
  await writeFile(join(path, 'data', 'raw.json'), '{}')
  await assert.rejects(loadWeeklyHistory(path, NOW), rejects('invalid-history'))
  await rm(join(path, 'data', 'raw.json'))
  const runPath = join(path, 'runs', 'run-100-1.json')
  await t.test('hard-linked aggregate files are refused when the host permits creating links', async subtest => {
    try { await link(runPath, join(root, 'linked-report.json')) } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) { subtest.skip('host does not permit creating hard links'); return }
      throw error
    }
    await assert.rejects(loadWeeklyHistory(path, NOW), rejects('unsafe-path'))
    await rm(join(root, 'linked-report.json'))
  })
  await t.test('linked roots are refused when the host permits creating links', async subtest => {
    const linked = join(root, 'junction')
    try { await symlink(path, linked, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) { subtest.skip('host does not permit creating directory links'); return }
      throw error
    }
    await assert.rejects(loadWeeklyHistory(linked, NOW), rejects('unsafe-path'))
  })
})

test('partial data on failed runs, conflicting run IDs, future checkpoints and history loss are refused before output', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  await assert.rejects(writeWeeklyHistoryOutput({ previous: empty, run: report({ failed: true }), dataset: dataset(),
    directory: join(root, 'partial'), now: NOW }), rejects('invalid-history'))
  const future = checkpoint('2026-10-25T00:00:00.000Z')
  await assert.rejects(writeWeeklyHistoryOutput({ previous: empty, run: report(), dataset: dataset(), checkpoint: future,
    directory: join(root, 'future'), now: NOW }), rejects('future-record'))
  const previous = await writeWeeklyHistoryOutput({ previous: empty, run: report(), dataset: dataset(), directory: join(root, 'previous'), now: NOW })
  await assert.rejects(writeWeeklyHistoryOutput({ previous, run: report({ failed: true }),
    directory: join(root, 'conflict'), now: NOW }), rejects('conflict'))
  const broken = structuredClone(previous); broken.manifest.datasets = []
  await assert.rejects(writeWeeklyHistoryOutput({ previous: broken, run: report({ id: 'run-101-1', failed: true }),
    directory: join(root, 'broken'), now: NOW }), rejects('invalid-history'))
})
