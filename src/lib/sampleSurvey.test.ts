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
