import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SAMPLE_SURVEY_CONFIG, parseSampleSurveyConfig, parseSampleSurveyPlan, parseSampleSurveyRun, parseSampleSurveyStatus,
  sampleSurveyEstimate, sampleSurveyPlannedCount, sampleSurveyResultDefinitions } from './sampleSurvey.ts'
import type { SampleSurveyConfig, SampleSurveyRun } from '../types/sampleSurvey.ts'

const config = (): SampleSurveyConfig => ({ ...DEFAULT_SAMPLE_SURVEY_CONFIG, ranks: ['MASTER'], includeMr: false, rankSampleSize: 10 })
function run(): SampleSurveyRun {
  const value = config()
  return { schemaVersion: 1, id: 'run-1', planId: 'plan-1', config: value, state: 'complete', phase: 'complete',
    startedAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:01:00.000Z', finishedAt: '2026-10-27T00:01:00.000Z',
    elapsedMs: 60000, attempts: 3, successfulPages: 3, uniqueAccountCount: 2, frameChanged: false, stopReason: null, resumeAllowed: false,
    strata: [{ ...sampleSurveyResultDefinitions(value)[0], population: 2, selected: 2, processed: 2, succeeded: 2, missing: 0, duplicates: 0, mean: 25010, min: 25000, max: 25020 }] }
}
test('config supports independent LP/MR frames and bounded initial planning', () => {
  assert.equal(sampleSurveyPlannedCount(DEFAULT_SAMPLE_SURVEY_CONFIG), 2200)
  assert.deepEqual(sampleSurveyEstimate(DEFAULT_SAMPLE_SURVEY_CONFIG), { pages: 2200, minimumMs: 11000000, maximumMs: 22000000 })
  assert.equal(sampleSurveyPlannedCount(parseSampleSurveyConfig({ ...config(), ranks: [], includeMr: true })), 600)
  assert.deepEqual(parseSampleSurveyConfig({ ...config(), ranks: ['MASTER', 'ROOKIE'] }).ranks, ['ROOKIE', 'MASTER'])
  for (const invalid of [{ ranks: [] }, { ranks: ['MASTER', 'MASTER'] }, { rankSampleSize: 9 }, { rankSampleSize: 11 },
    { rankSampleSize: 1010 }, { maxDurationMinutes: 0 }, { maxDurationMinutes: 481 }, { cookie: 'private' }]) {
    assert.throws(() => parseSampleSurveyConfig({ ...config(), ...invalid }))
  }
})
test('plans are immutable reconstructions without arbitrary payloads', () => {
  const plan = { schemaVersion: 1, id: 'plan-1', createdAt: '2026-10-27T00:00:00.000Z', seed: 'a'.repeat(32), config: config() }
  const parsed = parseSampleSurveyPlan(plan)
  plan.config.ranks[0] = 'ROOKIE' as 'MASTER'
  assert.deepEqual(parsed.config.ranks, ['MASTER'])
  assert.throws(() => parseSampleSurveyPlan({ ...plan, accountIds: ['123'] }))
  assert.throws(() => parseSampleSurveyPlan({ ...plan, createdAt: '2026-02-30T00:00:00.000Z' }))
})
test('aggregate imports reject individual data and inconsistent denominators', () => {
  assert.deepEqual(parseSampleSurveyRun(run()), run())
  for (const invalid of [{ accountId: '1234' }, { slots: [] }, { uniqueAccountCount: 3 }, { successfulPages: 4 },
    { phase: 'sampling' }, { finishedAt: null }, { resumeAllowed: true }]) assert.throws(() => parseSampleSurveyRun({ ...run(), ...invalid }))
  for (const invalid of [{ processed: 1 }, { duplicates: 1 }, { selected: 3 }, { mean: 0 }, { min: null }, { id: 'other' },
    { profileUrl: 'https://www.streetfighter.com/6/buckler/ja-jp/profile/123' }]) {
    assert.throws(() => parseSampleSurveyRun({ ...run(), strata: [{ ...run().strata[0], ...invalid }] }))
  }
})
test('zero results and unknown or missing values remain distinguishable', () => {
  const empty = { ...run(), uniqueAccountCount: 0, strata: [{ ...run().strata[0], population: 0, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null }] }
  assert.equal(parseSampleSurveyRun(empty).strata[0].mean, null)
  const zero = { ...run(), strata: [{ ...run().strata[0], mean: 0, min: 0, max: 0 }] }
  assert.equal(parseSampleSurveyRun(zero).strata[0].mean, 0)
  assert.throws(() => parseSampleSurveyRun({ ...empty, strata: [{ ...empty.strata[0], mean: 0 }] }))
  assert.throws(() => parseSampleSurveyRun({ ...empty, strata: [{ ...empty.strata[0], population: 100 }] }))
})
test('authentication stops cannot be offered as resumable and statuses reference a real active run', () => {
  const stopped = { ...run(), state: 'stopped', phase: 'sampling', stopReason: 'human-verification', resumeAllowed: false }
  assert.equal(parseSampleSurveyRun(stopped).resumeAllowed, false)
  assert.throws(() => parseSampleSurveyRun({ ...stopped, resumeAllowed: true }))
  const status = { available: true, sessionAvailable: false, token: 'a'.repeat(64), plans: [], runs: [stopped], activeRunId: null }
  assert.equal(parseSampleSurveyStatus(status).runs.length, 1)
  assert.throws(() => parseSampleSurveyStatus({ ...status, activeRunId: 'run-1' }))
  assert.throws(() => parseSampleSurveyStatus({ ...status, cookie: 'private' }))
})

function observedRun(): SampleSurveyRun {
  const value = run()
  return { ...value, schemaVersion: 2, observation: { method: 'rank-position-interval-v1', omittedChanges: 0,
    strata: [{ id: 'lp-MASTER', status: 'checked', startedAt: value.startedAt, finishedAt: value.finishedAt,
      totalCountBefore: 100, totalCountAfter: 101, startBefore: 0, endBefore: 2, startAfter: 0, endAfter: 2, boundaryChanged: false }],
    changes: [{ kind: 'total-count', target: 'lp', stratumId: 'lp-MASTER', at: value.updatedAt, before: 100, after: 101 }] } }
}

test('v2 distinguishes an observed total-count change from unchanged stratum boundaries', () => {
  const value = observedRun(), parsed = parseSampleSurveyRun(value)
  assert.deepEqual(parsed, value)
  assert.equal(parsed.frameChanged, false)
  assert.equal(parsed.observation!.strata[0].status, 'checked')
  assert.deepEqual(parseSampleSurveyRun(run()), run())
  assert.throws(() => parseSampleSurveyRun({ ...value, schemaVersion: 1 }))
  const absent = { ...value }; delete absent.observation
  assert.throws(() => parseSampleSurveyRun(absent))
})

test('v2 retains missing, duplicate and shifted-boundary results as review-required', () => {
  const value = observedRun()
  Object.assign(value.strata[0], { succeeded: 0, missing: 1, duplicates: 1, mean: null, min: null, max: null })
  value.uniqueAccountCount = 0; value.frameChanged = true
  Object.assign(value.observation!.strata[0], { status: 'review-required', endAfter: 3, boundaryChanged: true })
  assert.deepEqual(parseSampleSurveyRun(value), value)
  assert.throws(() => parseSampleSurveyRun({ ...value, frameChanged: false }))
  const unchecked = structuredClone(value); unchecked.observation!.strata[0].status = 'checked'
  assert.throws(() => parseSampleSurveyRun(unchecked))
  const hiddenChange = structuredClone(value); hiddenChange.observation!.strata[0].boundaryChanged = false
  assert.throws(() => parseSampleSurveyRun(hiddenChange))
})

test('v2 keeps a failed frame distinct from a checked empty population', () => {
  const value = observedRun()
  Object.assign(value.strata[0], { population: null, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null })
  value.uniqueAccountCount = 0; value.frameChanged = true
  Object.assign(value.observation!.strata[0], { status: 'review-required', totalCountAfter: null,
    startBefore: null, endBefore: null, startAfter: null, endAfter: null, boundaryChanged: true })
  assert.equal(parseSampleSurveyRun(value).strata[0].population, null)
  const empty = structuredClone(value)
  empty.frameChanged = false; empty.strata[0].population = 0
  Object.assign(empty.observation!.strata[0], { status: 'checked', totalCountAfter: 101,
    startBefore: 0, endBefore: 0, startAfter: 0, endAfter: 0, boundaryChanged: false })
  assert.equal(parseSampleSurveyRun(empty).strata[0].population, 0)
  const invalid = structuredClone(value); invalid.observation!.strata[0].status = 'checked'
  assert.throws(() => parseSampleSurveyRun(invalid))
})

test('v2 sequential collection permits later pending strata and interrupted collecting observations', () => {
  const value = observedRun()
  value.config.ranks = ['DIAMOND', 'MASTER']; value.state = 'running'; value.phase = 'sampling'; value.finishedAt = null
  value.strata = [{ ...value.strata[0], id: 'lp-DIAMOND', label: 'DIAMOND' },
    { ...value.strata[0], population: null, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null }]
  value.observation!.strata = [{ ...value.observation!.strata[0], id: 'lp-DIAMOND' },
    { id: 'lp-MASTER', status: 'pending', startedAt: null, finishedAt: null, totalCountBefore: null, totalCountAfter: null,
      startBefore: null, endBefore: null, startAfter: null, endAfter: null, boundaryChanged: false }]
  value.observation!.changes[0].stratumId = 'lp-DIAMOND'
  assert.deepEqual(parseSampleSurveyRun(value), value)
  value.state = 'stopped'; value.finishedAt = value.updatedAt; value.stopReason = 'limit-reached'; value.resumeAllowed = true
  Object.assign(value.observation!.strata[1], { status: 'collecting', startedAt: value.updatedAt })
  assert.deepEqual(parseSampleSurveyRun(value), value)
  assert.throws(() => parseSampleSurveyRun({ ...value, state: 'complete', phase: 'complete', stopReason: null, resumeAllowed: false }))
})

test('v2 completion never hides pending slots or a reduced selection count', () => {
  for (const patch of [{ selected: 2, processed: 1, succeeded: 1 }, { selected: 1, processed: 1, succeeded: 1 }]) {
    const value = observedRun()
    Object.assign(value.strata[0], patch); value.uniqueAccountCount = 1
    value.observation!.strata[0].status = 'review-required'
    assert.throws(() => parseSampleSurveyRun(value))
  }
})

test('v2 checked boundaries must fit both corresponding observed totals', () => {
  for (const key of ['totalCountBefore', 'totalCountAfter'] as const) {
    const value = observedRun()
    value.observation!.strata[0][key] = 1
    assert.throws(() => parseSampleSurveyRun(value))
    value.observation!.strata[0].status = 'review-required'
    assert.deepEqual(parseSampleSurveyRun(value), value)
  }
})

test('v2 observations reject private fields, invalid targets, timestamps and unbounded changes', () => {
  for (const patch of [{ accountId: 'private' }, { method: 'other' }, { omittedChanges: -1 },
    { changes: Array.from({ length: 65 }, () => observedRun().observation!.changes[0]) }]) {
    assert.throws(() => parseSampleSurveyRun({ ...observedRun(), observation: { ...observedRun().observation, ...patch } }))
  }
  for (const patch of [{ token: 'private' }, { kind: 'cookie' }, { before: 'secret' }, { after: -1 },
    { stratumId: 'private-account' }, { target: 'mr' }, { at: '2026-10-26T00:00:00.000Z' }]) {
    const value = observedRun()
    Object.assign(value.observation!.changes[0], patch)
    assert.throws(() => parseSampleSurveyRun(value))
  }
  for (const patch of [{ accountId: 'private' }, { id: 'lp-OTHER' }, { startBefore: 3 }, { endBefore: 3 },
    { startedAt: null }, { finishedAt: null }, { finishedAt: '2026-10-27T00:02:00.000Z' }]) {
    const value = observedRun()
    Object.assign(value.observation!.strata[0], patch)
    assert.throws(() => parseSampleSurveyRun(value))
  }
})
