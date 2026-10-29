import assert from 'node:assert/strict'
import test from 'node:test'
import type { SampleSurveyRun } from '../types/sampleSurvey.ts'
import type { SampleSurveyInsightDataset, SampleSurveyInsightMetrics, SampleSurveyInsights } from '../types/sampleSurveyInsights.ts'
import { parseSampleSurveyInsights, sampleSurveyMetricValue } from './sampleSurveyInsights.ts'
import { createSampleSurveyResultsFeed, parseSampleSurveyResultsRun, SAMPLE_SURVEY_RESULTS_SOURCE } from './sampleSurveyResults.ts'

function run(): SampleSurveyRun {
  return { schemaVersion: 1, id: 'survey-insights', planId: 'plan-insights',
    config: { ranks: ['MASTER'], rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 10 },
    state: 'complete', phase: 'complete', startedAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:05:00.000Z',
    finishedAt: '2026-10-20T01:05:00.000Z', elapsedMs: 300000, attempts: 2, successfulPages: 2, uniqueAccountCount: 3,
    strata: [{ id: 'lp-MASTER', label: 'MASTER', target: 'lp', requested: 10, population: 3, selected: 3,
      processed: 3, succeeded: 3, missing: 0, duplicates: 0, mean: 25000, min: 24900, max: 25100 }],
    frameChanged: false, stopReason: null, resumeAllowed: false }
}
function activity(): SampleSurveyInsightDataset {
  return { theme: 'activity', target: 'lp', period: { kind: 'act', act: 10 }, mode: 'rank',
    capturedAt: { start: '2026-10-20T01:01:00.000Z', end: '2026-10-20T01:04:00.000Z' },
    coverage: [{ stratumId: 'lp-MASTER', attemptedAccounts: 3, validAccounts: 3, failedAccounts: 0 }],
    rows: [{ stratumId: 'lp-MASTER', validAccounts: 3, metrics: {
      activeShare: { kind: 'ratio', n: 3, numerator: 2, denominator: 3 },
      meanBattles: { kind: 'mean', n: 3, total: 12 }, meanCharacters: { kind: 'mean', n: 3, total: 4 },
    } }] }
}
function insights(): SampleSurveyInsights { return { schemaVersion: 1, datasets: [activity()] } }
function recent(): SampleSurveyInsightDataset {
  const value = activity()
  value.theme = 'recent'; value.period = { kind: 'recent-10' }; value.mode = 'all'
  value.rows[0].metrics = {
    records: { kind: 'count', n: 3, count: 25 }, classicRecords: { kind: 'count', n: 3, count: 18 },
    modernRecords: { kind: 'count', n: 3, count: 5 }, unknownRecords: { kind: 'count', n: 3, count: 2 },
    wins: { kind: 'count', n: 3, count: 12 }, losses: { kind: 'count', n: 3, count: 13 },
    modernShare: { kind: 'ratio', n: 3, numerator: 5, denominator: 23 },
  }
  return value
}

test('extended aggregates derive percentages and means from their own denominators', () => {
  const value = insights(), parsed = parseSampleSurveyInsights(value, run())
  assert.deepEqual(parsed, value); assert.notEqual(parsed.datasets[0].rows[0].metrics, value.datasets[0].rows[0].metrics)
  const metrics = parsed.datasets[0].rows[0].metrics
  assert.equal(sampleSurveyMetricValue(metrics.activeShare), 2 / 3 * 100)
  assert.equal(sampleSurveyMetricValue(metrics.meanBattles), 4)
  assert.equal(sampleSurveyMetricValue({ kind: 'count', n: 3, count: 0 }), 0)
  assert.equal(sampleSurveyMetricValue({ kind: 'ratio', n: 3, numerator: 0, denominator: 3 }), 0)
  for (const cell of [undefined, { kind: 'count', n: 0, count: 0 }, { kind: 'mean', n: 0, total: 0 },
    { kind: 'ratio', n: 0, numerator: 0, denominator: 0 }, { kind: 'median', n: 0, value: null }] as const) {
    assert.equal(sampleSurveyMetricValue(cell), null)
  }
})

test('all six additional themes accept only their domain conditions and aggregate dimensions', () => {
  const character = activity(); character.theme = 'character'; character.rows[0].characterId = 'ryu'
  character.rows[0].metrics = { userShare: { kind: 'ratio', n: 3, numerator: 2, denominator: 3 },
    wins: { kind: 'count', n: 2, count: 8 }, battles: { kind: 'count', n: 2, count: 10 },
    winRate: { kind: 'ratio', n: 2, numerator: 8, denominator: 10 } }
  const status = structuredClone(character); status.period = { kind: 'capture' }; status.mode = null
  status.rows[0].metrics = { medianLp: { kind: 'median', n: 2, value: 26000 }, medianMr: { kind: 'median', n: 1, value: 1510 } }
  const matchup = structuredClone(character); matchup.theme = 'matchup'; matchup.rows[0].opponentCharacterId = 'ken'
  matchup.rows[0].metrics = { battles: { kind: 'count', n: 2, count: 20 }, medianWinRate: { kind: 'median', n: 2, value: 55 } }
  const battle = activity(); battle.theme = 'battle'; battle.period = { kind: 'last-100' }; battle.mode = null
  battle.rows[0].metrics = { driveParryShare: { kind: 'mean', n: 3, total: 90 }, throwMean: { kind: 'mean', n: 2, total: 7.5 } }
  const attributes = activity(); attributes.theme = 'attributes'; attributes.period = { kind: 'capture' }; attributes.mode = null
  attributes.rows[0].metrics = { meanPlayPoints: { kind: 'mean', n: 3, total: 1000 }, clubShare: { kind: 'ratio', n: 3, numerator: 1, denominator: 3 } }
  attributes.rows.push({ stratumId: 'lp-MASTER', validAccounts: 3, category: 'region-jp',
    metrics: { categoryShare: { kind: 'ratio', n: 3, numerator: 2, denominator: 3 } } })
  const value: SampleSurveyInsights = { schemaVersion: 1, datasets: [activity(), character, status, matchup, battle, recent(), attributes] }
  assert.deepEqual(parseSampleSurveyInsights(value, run()), value)
})

test('unknown or private fields are rejected at every published object level', () => {
  const mutations: Array<(value: SampleSurveyInsights) => void> = [
    value => { Object.assign(value, { accountId: 'private' }) },
    value => { Object.assign(value.datasets[0], { profileUrl: 'https://private.example' }) },
    value => { Object.assign(value.datasets[0].period, { accountName: 'private' }) },
    value => { Object.assign(value.datasets[0].capturedAt, { cookie: 'private' }) },
    value => { Object.assign(value.datasets[0].coverage[0], { ids: ['private'] }) },
    value => { Object.assign(value.datasets[0].rows[0], { playerName: 'private' }) },
    value => { Object.assign(value.datasets[0].rows[0].metrics, { playerId: 'private' }) },
    value => { Object.assign(value.datasets[0].rows[0].metrics.activeShare!, { ids: ['private'] }) },
    value => { value.datasets[0].rows[0].stratumId = 'private-account' },
    value => { value.datasets[0].rows[0].characterId = 'private-account' },
  ]
  for (const mutate of mutations) { const value = insights(); mutate(value); assert.throws(() => parseSampleSurveyInsights(value, run())) }
})

test('coverage cannot invent samples, targets, duplicate rows or collection outside the run', () => {
  const mutations: Array<(value: SampleSurveyInsights) => void> = [
    value => { value.datasets[0].target = 'mr' },
    value => { value.datasets[0].coverage[0].stratumId = 'lp-IRON' },
    value => { value.datasets[0].coverage[0].attemptedAccounts = 4; value.datasets[0].coverage[0].failedAccounts = 1 },
    value => { value.datasets[0].coverage[0].validAccounts = 2 },
    value => { value.datasets[0].rows[0].validAccounts = 4 },
    value => { value.datasets[0].coverage.push(value.datasets[0].coverage[0]) },
    value => { value.datasets[0].rows.push(value.datasets[0].rows[0]) },
    value => { value.datasets.push(value.datasets[0]) },
    value => { value.datasets[0].capturedAt.start = '2026-10-20T00:59:00.000Z' },
    value => { value.datasets[0].capturedAt.end = '2026-10-20T01:06:00.000Z' },
    value => { value.datasets[0].capturedAt.start = '2026-10-20T01:04:30.000Z' },
    value => { value.datasets[0].mode = null },
    value => { value.datasets[0].period = { kind: 'capture' } },
    value => { value.datasets[0].period = { kind: 'lifetime', act: 1 } as never },
  ]
  for (const mutate of mutations) { const value = insights(); mutate(value); assert.throws(() => parseSampleSurveyInsights(value, run())) }
})

test('no attempt, failed attempt, zero observations and partially available metrics remain distinct', () => {
  assert.deepEqual(parseSampleSurveyInsights({ schemaVersion: 1, datasets: [] }, run()), { schemaVersion: 1, datasets: [] })
  for (const attempted of [0, 3]) {
    const value = insights(), dataset = value.datasets[0]
    dataset.coverage[0] = { stratumId: 'lp-MASTER', attemptedAccounts: attempted, validAccounts: 0, failedAccounts: attempted }
    dataset.rows = []
    assert.equal(parseSampleSurveyInsights(value, run()).datasets[0].coverage[0].attemptedAccounts, attempted)
  }
  const value = insights()
  value.datasets[0].rows[0].metrics = { meanBattles: { kind: 'mean', n: 0, total: 0 }, activeShare: { kind: 'ratio', n: 3, numerator: 0, denominator: 3 } }
  const metrics = parseSampleSurveyInsights(value, run()).datasets[0].rows[0].metrics
  assert.equal(sampleSurveyMetricValue(metrics.meanBattles), null)
  assert.equal(sampleSurveyMetricValue(metrics.activeShare), 0)
  assert.equal(metrics.meanCharacters, undefined)
})

test('metrics reject impossible denominators, values and inconsistent recent-match totals', () => {
  const badMetrics: SampleSurveyInsightMetrics[] = [
    { activeShare: { kind: 'ratio', n: 3, numerator: 4, denominator: 3 } },
    { activeShare: { kind: 'ratio', n: 3, numerator: 1, denominator: 2 } },
    { meanBattles: { kind: 'mean', n: 4, total: 8 } },
    { meanBattles: { kind: 'mean', n: 0, total: 8 } },
    { meanBattles: { kind: 'mean', n: 3, total: Infinity } },
    { meanCharacters: { kind: 'mean', n: 3, total: -1 } },
    { meanCharacters: { kind: 'mean', n: 3, total: 0.5 } },
    { activeShare: { kind: 'mean', n: 3, total: 30 } },
    { modernShare: { kind: 'ratio', n: 3, numerator: 1, denominator: 3 } },
  ]
  for (const metrics of badMetrics) {
    const value = insights(); value.datasets[0].rows[0].metrics = metrics
    assert.throws(() => parseSampleSurveyInsights(value, run()))
  }
  for (const [id, cell] of Object.entries({
    records: { kind: 'count', n: 3, count: 31 }, unknownRecords: { kind: 'count', n: 3, count: 3 },
    losses: { kind: 'count', n: 3, count: 14 }, modernShare: { kind: 'ratio', n: 3, numerator: 5, denominator: 25 },
  })) {
    const dataset = recent(); Object.assign(dataset.rows[0].metrics, { [id]: cell })
    assert.throws(() => parseSampleSurveyInsights({ schemaVersion: 1, datasets: [dataset] }, run()))
  }
})

test('matchup win-rate medians require contributing accounts with observed matches', () => {
  const value = activity(); value.theme = 'matchup'
  Object.assign(value.rows[0], { characterId: 'ryu', opponentCharacterId: 'ken' })
  for (const [matches, accounts] of [[0, 1], [1, 2], [10, 3]]) {
    value.rows[0].metrics = { battles: { kind: 'count', n: 2, count: matches }, medianWinRate: { kind: 'median', n: accounts, value: 50 } }
    assert.throws(() => parseSampleSurveyInsights({ schemaVersion: 1, datasets: [value] }, run()))
  }
  value.rows[0].metrics = { battles: { kind: 'count', n: 2, count: 0 }, medianWinRate: { kind: 'median', n: 0, value: null } }
  assert.doesNotThrow(() => parseSampleSurveyInsights({ schemaVersion: 1, datasets: [value] }, run()))
})

test('percentage means, medians and character dimensions have explicit ranges and missing-value rules', () => {
  const battle = activity(); battle.theme = 'battle'; battle.period = { kind: 'last-100' }; battle.mode = null
  for (const total of [301, NaN, -1]) {
    battle.rows[0].metrics = { driveParryShare: { kind: 'mean', n: 3, total } }
    assert.throws(() => parseSampleSurveyInsights({ schemaVersion: 1, datasets: [battle] }, run()))
  }
  const character = activity(); character.theme = 'character'; character.period = { kind: 'capture' }; character.mode = null
  character.rows[0].characterId = 'ryu'
  for (const cell of [{ kind: 'median', n: 0, value: 0 }, { kind: 'median', n: 1, value: null },
    { kind: 'median', n: 1, value: -1 }] as const) {
    character.rows[0].metrics = { medianLp: cell }
    assert.throws(() => parseSampleSurveyInsights({ schemaVersion: 1, datasets: [character] }, run()))
  }
  character.rows[0].metrics = { medianLp: { kind: 'median', n: 0, value: null } }
  assert.doesNotThrow(() => parseSampleSurveyInsights({ schemaVersion: 1, datasets: [character] }, run()))
  character.rows[0].characterId = 'player-123'
  assert.throws(() => parseSampleSurveyInsights({ schemaVersion: 1, datasets: [character] }, run()))
})

test('public run and history feed preserve extensions without changing legacy schema semantics', async () => {
  const legacy = run(), extended = { ...run(), insights: insights() }
  assert.equal(parseSampleSurveyResultsRun(legacy).insights, undefined)
  assert.deepEqual(parseSampleSurveyResultsRun(extended), extended)
  const interval: SampleSurveyRun = { ...extended, schemaVersion: 2, observation: { method: 'rank-position-interval-v1',
    strata: [{ id: 'lp-MASTER', status: 'checked', startedAt: extended.startedAt, finishedAt: extended.finishedAt,
      totalCountBefore: 3, totalCountAfter: 3, startBefore: 0, endBefore: 3, startAfter: 0, endAfter: 3, boundaryChanged: false }],
    changes: [], omittedChanges: 0 } }
  assert.deepEqual(parseSampleSurveyResultsRun(interval), interval)
  const value = { ...extended, updatedAt: '2026-10-20T01:07:00.000Z', insights: insights() }
  value.insights.datasets[0].capturedAt.end = '2026-10-20T01:06:00.000Z'
  assert.throws(() => parseSampleSurveyResultsRun(value))
  const descriptor = { id: extended.id, path: `runs/${extended.id}.json`, captureStartedAt: extended.startedAt, captureEndedAt: extended.finishedAt! }
  const manifest = { schemaVersion: 1, generatedAt: extended.updatedAt, source: SAMPLE_SURVEY_RESULTS_SOURCE, datasets: [descriptor] }
  const feed = createSampleSurveyResultsFeed({ localBaseUrl: '/test/', historyBaseUrl: 'https://history.example/',
    fetch: async input => new Response(JSON.stringify(String(input).endsWith('index.json') ? manifest : extended)) })
  const publication = await feed.loadPublication()
  assert.deepEqual(await feed.loadDataset(publication, descriptor), extended)
})
