import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_ESTIMATE_CHECKS, RANK_DISTRIBUTION_SOURCE } from '../src/lib/rankDistribution.ts'
import type { RankDistributionDataset } from '../src/types/rankDistribution.ts'
import { summarizeRankDistributionCloudCapture } from './collect-rank-distribution-cloud.ts'
import {
  loadWeeklyHistory, writeWeeklyHistoryOutput,
} from './lib/rank-distribution-weekly-history.ts'
import type { RankDistributionWeeklyHistory, RankDistributionWeeklyRunReport } from './lib/rank-distribution-weekly-history.ts'
import { RANK_BOUNDARY_SOURCE_URL } from './lib/rank-distribution-boundaries.ts'
import { main, publishRankDistributionWeekly, RankDistributionWeeklyPublishError } from './publish-rank-distribution-weekly.ts'

const NOW = () => new Date('2026-10-24T00:00:00.000Z')
const START = '2026-10-22T12:00:00.000Z'
const OLD = '2026-10-15T12:00:00.000Z'
const later = (start: string, ms: number) => new Date(Date.parse(start) + ms).toISOString()
function dataset(start = START): RankDistributionDataset {
  return { schemaVersion: 1, id: `max-lp-estimate-${start.replace(/[:.]/g, '-')}`, captureStartedAt: start,
    captureEndedAt: later(start, 60000), generatedAt: later(start, 120000),
    source: { ...RANK_DISTRIBUTION_SOURCE, population: 'synthetic listed accounts', metric: 'synthetic maximum LP', unit: 'fighter-account', notes: ['synthetic fixture'] },
    conditions: { ...RANK_DISTRIBUTION_CONDITIONS }, method: 'boundary-search-estimate', totalCount: 36,
    entries: Array.from({ length: 36 }, (_, i) => ({ rankId: i + 1, count: 1 })),
    validation: { status: 'estimated', coverage: 'all-rank-boundaries', checks: [...RANK_DISTRIBUTION_ESTIMATE_CHECKS], notes: ['synthetic fresh proof'] },
    observation: { totalAtStart: 36, totalAtEnd: 36, minTotal: 36, maxTotal: 36, boundaries: Array.from({ length: 35 }, (_, i) => ({
      rankId: i + 2, countAtOrAbove: 35 - i, totalCount: 36, observedAt: later(start, 30000) })) } }
}
function report(start = START, failed = false): RankDistributionWeeklyRunReport {
  const capturedAt = '2026-10-14T00:00:00.000Z'
  return { schemaVersion: 1, id: start === OLD ? 'run-99-1' : 'run-100-1', startedAt: start, endedAt: later(start, 180000),
    event: 'schedule', status: failed ? 'failed' : 'succeeded', failureReason: failed ? 'collection-failed' : null,
    sessionCapturedAt: capturedAt, sessionUploadedAt: later(capturedAt, 3600000),
    sessionAgeSeconds: (Date.parse(start) - Date.parse(capturedAt)) / 1000, initialSignInConfirmed: true,
    reuseAfterSevenDays: start === OLD ? 'pending' : 'confirmed', datasetId: failed ? null : dataset(start).id,
    capture: summarizeRankDistributionCloudCapture({ status: failed ? 'failed' : 'succeeded', stage: failed ? 'collection' : 'complete',
      reason: failed ? 'read-failed' : null, startedAt: start, endedAt: later(start, 60000), requestCount: 40, successfulReadCount: 40,
      confirmedBoundaryCount: failed ? 10 : 35, datasetSaved: !failed, published: !failed, browserClosed: true,
      totalAtEnd: 36, totalMin: 36, totalMax: 36 }) }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sf6-weekly-publish-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir())))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}
async function output(root: string, name: string, previous: RankDistributionWeeklyHistory, start = START, failed = false) {
  return writeWeeklyHistoryOutput({ previous, run: report(start, failed), ...(failed ? {} : { dataset: dataset(start) }),
    checkpoint: { schemaVersion: 1, method: 'boundary-search-estimate', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
      pageSize: 20, savedAt: later(start, 30000), hints: [{ rankId: 36, countAtOrAbove: 1, totalCount: 36, observedAt: later(start, 30000) }] },
    directory: join(root, name), now: NOW })
}
const rejects = (code: string) => (error: unknown) => error instanceof RankDistributionWeeklyPublishError && error.code === code
const hosted = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  GITHUB_REPOSITORY: 'gonchiman/sf6', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule',
  GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/rank-distribution-weekly.yml@refs/heads/main' })

test('publisher CLI requires the exact trusted weekly workflow and no caller-selected locations', async () => {
  let calls = 0
  const publish = async () => { calls++; return { datasets: 1, entries: 36, runs: 1, checkpointHints: 35 } }
  const messages: string[] = []
  await main([], { env: hosted(), publish, write: value => messages.push(value) })
  await main([], { env: { ...hosted(), GITHUB_EVENT_NAME: 'workflow_dispatch' }, publish, write: () => {} })
  assert.equal(calls, 2)
  assert.deepEqual(JSON.parse(messages[0]), { datasets: 1, entries: 36, runs: 1, checkpointHints: 35 })
  for (const env of [{ ...hosted(), RUNNER_OS: 'Linux' }, { ...hosted(), GITHUB_REF: 'refs/heads/codex/untrusted' },
    { ...hosted(), GITHUB_EVENT_NAME: 'pull_request' }, { ...hosted(), GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/other.yml@refs/heads/main' },
    { ...hosted(), GITHUB_REPOSITORY: 'other/sf6' }, { ...hosted(), RUNNER_ENVIRONMENT: 'self-hosted' }]) {
    await assert.rejects(main([], { env, publish }), rejects('runner'))
  }
  await assert.rejects(main(['--path', 'synthetic-private'], { env: hosted(), publish }), rejects('arguments'))
  assert.equal(calls, 2)
})

test('a validated snapshot is copied into a data-only checkout without reading or copying .git', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const expected = await output(root, 'incoming', empty)
  const target = join(root, 'history')
  await mkdir(join(target, '.git'), { recursive: true })
  await writeFile(join(target, '.git/config'), 'synthetic-config-must-stay-local')
  const result = await publishRankDistributionWeekly({ inputDirectory: join(root, 'incoming'), historyDirectory: target, now: NOW })
  assert.deepEqual(result, { datasets: 1, entries: 36, runs: 1, checkpointHints: 1 })
  assert.deepEqual(await loadWeeklyHistory(target, NOW), expected)
  assert.equal(await readFile(join(target, '.git/config'), 'utf8'), 'synthetic-config-must-stay-local')
  assert.deepEqual(await publishRankDistributionWeekly({ inputDirectory: join(root, 'incoming'), historyDirectory: target, now: NOW }), result)
})

test('a failed week appends its safe run and checkpoint while preserving old verified datasets', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const previous = await output(root, 'old', empty, OLD)
  const target = join(root, 'history')
  await publishRankDistributionWeekly({ inputDirectory: join(root, 'old'), historyDirectory: target, now: NOW })
  const expected = await output(root, 'next', previous, START, true)
  const oldText = await readFile(join(target, 'data', `${dataset(OLD).id}.json`), 'utf8')
  const result = await publishRankDistributionWeekly({ inputDirectory: join(root, 'next'), historyDirectory: target, now: NOW })
  assert.deepEqual(result, { datasets: 1, entries: 36, runs: 2, checkpointHints: 1 })
  assert.equal(await readFile(join(target, 'data', `${dataset(OLD).id}.json`), 'utf8'), oldText)
  assert.deepEqual(await loadWeeklyHistory(target, NOW), expected)
})

test('published CAPTCHA diagnostics preserve normal data and old run bytes, and a later success clears the failure status', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const previous = await output(root, 'old', empty, OLD)
  const target = join(root, 'history')
  await publishRankDistributionWeekly({ inputDirectory: join(root, 'old'), historyDirectory: target, now: NOW })
  const oldDataText = await readFile(join(target, 'data', `${dataset(OLD).id}.json`), 'utf8')
  const oldRunText = await readFile(join(target, 'runs/run-99-1.json'), 'utf8')
  const humanVerification = { wafHeaderChecked: true, wafAction: 'captcha' as const, domDetected: null }
  const failed = report(START, true)
  failed.capture = { ...failed.capture!, reason: 'captcha', readFailureCode: 'human-verification',
    lastHttpStatus: 405, humanVerification }
  await writeWeeklyHistoryOutput({ previous, run: failed, directory: join(root, 'failed'), now: NOW })
  await publishRankDistributionWeekly({ inputDirectory: join(root, 'failed'), historyDirectory: target, now: NOW })
  const failedHistory = await loadWeeklyHistory(target, NOW)
  assert.equal(failedHistory.datasets.length, 1)
  assert.equal(failedHistory.manifest.availability?.status, 'collection-failed')
  assert.equal(failedHistory.manifest.availability?.message, 'BucklerからCAPTCHAを要求されたため、ランク分布の取得を停止しました。')
  assert.equal(failedHistory.runs.find(run => run.id === 'run-100-1')?.capture?.reason, 'captcha')
  assert.deepEqual(failedHistory.runs.find(run => run.id === 'run-100-1')?.capture?.humanVerification, humanVerification)
  assert.equal(await readFile(join(target, 'data', `${dataset(OLD).id}.json`), 'utf8'), oldDataText)
  assert.equal(await readFile(join(target, 'runs/run-99-1.json'), 'utf8'), oldRunText)
  assert.equal(Object.hasOwn(failedHistory.runs.find(run => run.id === 'run-99-1')!.capture!, 'humanVerification'), false)

  const recoveredAt = '2026-10-23T12:00:00.000Z'
  await writeWeeklyHistoryOutput({ previous: failedHistory, run: { ...report(recoveredAt), id: 'run-101-1' },
    dataset: dataset(recoveredAt), directory: join(root, 'recovered'), now: NOW })
  await publishRankDistributionWeekly({ inputDirectory: join(root, 'recovered'), historyDirectory: target, now: NOW })
  const recovered = await loadWeeklyHistory(target, NOW)
  assert.equal(recovered.datasets.length, 2)
  assert.equal(recovered.manifest.availability, undefined)
  assert.deepEqual(recovered.runs.find(run => run.id === 'run-100-1')?.capture?.humanVerification, humanVerification)
})

test('malformed nested protection diagnostics reject an artifact without altering published history', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const previous = await output(root, 'old', empty, OLD)
  const target = join(root, 'history')
  await publishRankDistributionWeekly({ inputDirectory: join(root, 'old'), historyDirectory: target, now: NOW })
  const before = await readFile(join(target, 'data/index.json'), 'utf8')
  const invalid = [
    { wafHeaderChecked: true, wafAction: 'captcha', domDetected: null, cookie: 'synthetic-private-captcha' },
    { wafHeaderChecked: false, wafAction: 'captcha', domDetected: null },
    { wafHeaderChecked: true, wafAction: 'synthetic-private-captcha', domDetected: false },
    { wafHeaderChecked: true, wafAction: null, domDetected: 'synthetic-private-captcha' },
    null,
  ]
  for (const [index, humanVerification] of invalid.entries()) {
    const incoming = join(root, `invalid-${index}`)
    await output(root, `invalid-${index}`, previous, START, true)
    const run = report(START, true)
    await writeFile(join(incoming, 'runs/run-100-1.json'), JSON.stringify({ ...run, capture: {
      ...run.capture!, reason: 'captcha', readFailureCode: 'human-verification', humanVerification,
    } }))
    await assert.rejects(publishRankDistributionWeekly({ inputDirectory: incoming, historyDirectory: target, now: NOW }), error =>
      error instanceof RankDistributionWeeklyPublishError && error.code === 'input' && !error.message.includes('synthetic-private-captcha'))
    assert.equal(await readFile(join(target, 'data/index.json'), 'utf8'), before)
  }
})

test('history loss and mutation of an old dataset are rejected before any checkout write', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  const previous = await output(root, 'old', empty, OLD)
  const target = join(root, 'history')
  await publishRankDistributionWeekly({ inputDirectory: join(root, 'old'), historyDirectory: target, now: NOW })
  const before = await readFile(join(target, 'data/index.json'), 'utf8')
  await output(root, 'lost', empty)
  await assert.rejects(publishRankDistributionWeekly({ inputDirectory: join(root, 'lost'), historyDirectory: target, now: NOW }), rejects('conflict'))
  const mutated = structuredClone(previous)
  mutated.datasets[0].source.notes = ['different synthetic notes']
  await output(root, 'mutated', mutated, START, true)
  await assert.rejects(publishRankDistributionWeekly({ inputDirectory: join(root, 'mutated'), historyDirectory: target, now: NOW }), rejects('conflict'))
  assert.equal(await readFile(join(target, 'data/index.json'), 'utf8'), before)
})

test('extra sensitive files and unknown report fields prevent the entire artifact from being copied', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  await output(root, 'extra', empty)
  await writeFile(join(root, 'extra', 'storage-state.json'), '{"cookies":["synthetic-secret"]}')
  const target = join(root, 'history')
  await assert.rejects(publishRankDistributionWeekly({ inputDirectory: join(root, 'extra'), historyDirectory: target, now: NOW }), error =>
    error instanceof RankDistributionWeeklyPublishError && error.code === 'input' && !error.message.includes('synthetic-secret'))
  await output(root, 'report', empty)
  await writeFile(join(root, 'report/runs/run-100-1.json'), JSON.stringify({ ...report(), privateDOM: 'synthetic-secret' }))
  await assert.rejects(publishRankDistributionWeekly({ inputDirectory: join(root, 'report'), historyDirectory: target, now: NOW }), rejects('input'))
  assert.equal((await loadWeeklyHistory(target, NOW)).datasets.length, 0)
})

test('a valid dataset without a successful run cannot be added by an artifact', async t => {
  const root = await fixture(t)
  const empty = await loadWeeklyHistory(join(root, 'absent'), NOW)
  await output(root, 'incoming', empty)
  await rm(join(root, 'incoming/runs/run-100-1.json'))
  await assert.rejects(publishRankDistributionWeekly({ inputDirectory: join(root, 'incoming'), historyDirectory: join(root, 'history'), now: NOW }), rejects('conflict'))
})
