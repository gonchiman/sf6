import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SAMPLE_SURVEY_CONFIG, parseSampleSurveyConfig, parseSampleSurveyPlan, parseSampleSurveyRun, parseSampleSurveyStatus,
  SAMPLE_SURVEY_MAX_BOUNDARY_DELTA, SAMPLE_SURVEY_MAX_BOUNDARY_RELATIVE_DELTA,
  sampleSurveyEstimate, sampleSurveyPlannedCount, sampleSurveyResultDefinitions } from './sampleSurvey.ts'
import type { SampleSurveyBoundaryAcceptance, SampleSurveyConfig, SampleSurveyRun } from '../types/sampleSurvey.ts'

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

function tolerantRun(patch: Partial<SampleSurveyBoundaryAcceptance> = {}): SampleSurveyRun {
  const value = observedRun()
  const acceptance: SampleSurveyBoundaryAcceptance = { mode: 'approximate', referenceStart: 100, referenceEnd: 2100,
    referenceCheckedAt: '2026-10-27T00:00:10.000Z', start: 101, end: 2101,
    startObservedAt: '2026-10-27T00:00:20.000Z', endObservedAt: '2026-10-27T00:00:30.000Z', ...patch }
  const population = acceptance.end - acceptance.start, selected = Math.min(10, population)
  value.config.ranks = ['GOLD']; value.frameChanged = acceptance.mode === 'approximate'; value.uniqueAccountCount = selected
  Object.assign(value.strata[0], { id: 'lp-GOLD', label: 'GOLD', population, selected, processed: selected, succeeded: selected,
    mean: selected ? 10000 : null, min: selected ? 9990 : null, max: selected ? 10020 : null })
  Object.assign(value.observation!, { method: 'rank-position-tolerant-v1', changes: [] })
  Object.assign(value.observation!.strata[0], { id: 'lp-GOLD', status: acceptance.mode === 'exact' ? 'checked' : 'review-required',
    totalCountBefore: Math.max(acceptance.referenceEnd, acceptance.end) + 100, totalCountAfter: Math.max(acceptance.referenceEnd, acceptance.end) + 100,
    startBefore: acceptance.start, endBefore: acceptance.end, startAfter: acceptance.start, endAfter: acceptance.end,
    boundaryChanged: acceptance.mode === 'approximate', boundaryAcceptance: acceptance })
  return value
}

test('tolerant acceptance preserves exact and approximate evidence without changing legacy runs', () => {
  assert.equal(SAMPLE_SURVEY_MAX_BOUNDARY_DELTA, 20)
  assert.equal(SAMPLE_SURVEY_MAX_BOUNDARY_RELATIVE_DELTA, 0.001)
  for (const value of [run(), observedRun(), tolerantRun(), tolerantRun({ mode: 'exact', start: 100, end: 2100 })]) {
    assert.deepEqual(parseSampleSurveyRun(value), value)
  }
  const value = tolerantRun(), parsed = parseSampleSurveyRun(value)
  value.observation!.strata[0].boundaryAcceptance!.referenceStart = 0
  assert.equal(parsed.observation!.strata[0].boundaryAcceptance!.referenceStart, 100, 'acceptance objects are reconstructed')
})

test('tolerant acceptance requires a complete adopted range and rejects metadata on legacy or unadopted rows', () => {
  const noEvidence = tolerantRun(); delete noEvidence.observation!.strata[0].boundaryAcceptance
  assert.throws(() => parseSampleSurveyRun(noEvidence))
  const legacy = observedRun()
  legacy.observation!.strata[0].boundaryAcceptance = tolerantRun().observation!.strata[0].boundaryAcceptance
  assert.throws(() => parseSampleSurveyRun(legacy))
  const pending = tolerantRun()
  Object.assign(pending, { state: 'preparing', phase: 'boundaries', finishedAt: null, uniqueAccountCount: 0, frameChanged: false })
  Object.assign(pending.strata[0], { population: null, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null })
  Object.assign(pending.observation!.strata[0], { status: 'pending', startedAt: null, finishedAt: null,
    totalCountBefore: null, totalCountAfter: null, startBefore: null, endBefore: null, startAfter: null, endAfter: null, boundaryChanged: false })
  delete pending.observation!.strata[0].boundaryAcceptance
  assert.deepEqual(parseSampleSurveyRun(pending), pending)
  pending.observation!.strata[0].boundaryAcceptance = tolerantRun().observation!.strata[0].boundaryAcceptance
  assert.throws(() => parseSampleSurveyRun(pending))
  delete pending.observation!.strata[0].boundaryAcceptance
  Object.assign(pending, { state: 'complete', phase: 'complete', finishedAt: pending.updatedAt, frameChanged: true })
  Object.assign(pending.observation!.strata[0], { status: 'review-required', startedAt: pending.startedAt,
    finishedAt: pending.updatedAt, boundaryChanged: true })
  assert.deepEqual(parseSampleSurveyRun(pending), pending, 'a skipped stratum does not invent acceptance evidence')
})

test('tolerant acceptance applies per-cut and combined limits against the original range', () => {
  assert.doesNotThrow(() => parseSampleSurveyRun(tolerantRun({ referenceEnd: 40100, start: 120, end: 40120 })))
  assert.doesNotThrow(() => parseSampleSurveyRun(tolerantRun({ referenceEnd: 40100, start: 80, end: 40080 })))
  assert.doesNotThrow(() => parseSampleSurveyRun(tolerantRun({ referenceEnd: 1100, start: 100, end: 1101 })))
  for (const patch of [
    { referenceEnd: 100100, start: 121, end: 100100 }, // Relative allowance cannot waive the 20-position start limit.
    { referenceEnd: 100100, start: 100, end: 100121 },
    { start: 102, end: 2101 }, // Each cut is small, but their sum exceeds floor(2000 / 1000).
    { referenceEnd: 2099, start: 101, end: 2100 }, // Floor, not rounding to the nearest whole position.
    { referenceEnd: 1099, start: 100, end: 1100 }, // A population below 1000 has zero integer allowance.
  ]) assert.throws(() => parseSampleSurveyRun(tolerantRun(patch)))
})

test('tolerant exact zero-width frames remain distinct from unmeasured or shifted zero candidates', () => {
  const empty = tolerantRun({ mode: 'exact', referenceStart: 100, referenceEnd: 100, start: 100, end: 100 })
  assert.deepEqual(parseSampleSurveyRun(empty), empty)
  assert.equal(empty.strata[0].population, 0)
  for (const patch of [{ start: 101, end: 101 }, { start: 100, end: 101 }, { start: 99, end: 100 }]) {
    assert.throws(() => parseSampleSurveyRun(tolerantRun({ referenceStart: 100, referenceEnd: 100, ...patch })))
  }
  assert.throws(() => parseSampleSurveyRun(tolerantRun({ referenceStart: 100, referenceEnd: 100, start: 100, end: 100 })),
    'an unchanged empty candidate cannot claim approximate acceptance')
})

test('tolerant modes cannot hide actual adoption differences or manufacture checked status', () => {
  assert.throws(() => parseSampleSurveyRun(tolerantRun({ mode: 'exact' })))
  assert.throws(() => parseSampleSurveyRun(tolerantRun({ start: 100, end: 2100 })))
  for (const patch of [{ boundaryChanged: false }, { status: 'checked' }]) {
    const value = tolerantRun(); Object.assign(value.observation!.strata[0], patch)
    assert.throws(() => parseSampleSurveyRun(value))
  }
  const laterMovement = tolerantRun({ mode: 'exact', start: 100, end: 2100 })
  laterMovement.frameChanged = true
  Object.assign(laterMovement.observation!.strata[0], { status: 'review-required', endAfter: 2101, boundaryChanged: true })
  assert.deepEqual(parseSampleSurveyRun(laterMovement), laterMovement, 'exact adoption does not deny later observed movement')
  const collecting = tolerantRun()
  Object.assign(collecting, { state: 'running', phase: 'sampling', finishedAt: null, uniqueAccountCount: 0 })
  Object.assign(collecting.strata[0], { processed: 0, succeeded: 0, mean: null, min: null, max: null })
  Object.assign(collecting.observation!.strata[0], { status: 'collecting', finishedAt: null, totalCountAfter: null, startAfter: null, endAfter: null })
  assert.deepEqual(parseSampleSurveyRun(collecting), collecting)
  delete collecting.observation!.strata[0].boundaryAcceptance
  assert.throws(() => parseSampleSurveyRun(collecting))
})

test('tolerant acceptance validates range, total, field whitelist and numeric types', () => {
  for (const patch of [{ referenceStart: -1 }, { referenceEnd: 99 }, { referenceStart: 100.5 }, { referenceEnd: '2100' },
    { start: null }, { end: Number.MAX_SAFE_INTEGER + 1 }, { start: 102 }, { end: 2102 }, { mode: 'other' },
    { accountId: 'private' }, { token: 'private' }, { observedPage: { entries: [] } }]) {
    const value = tolerantRun(); Object.assign(value.observation!.strata[0].boundaryAcceptance!, patch)
    assert.throws(() => parseSampleSurveyRun(value))
  }
  for (const field of Object.keys(tolerantRun().observation!.strata[0].boundaryAcceptance!)) {
    const value = tolerantRun()
    delete (value.observation!.strata[0].boundaryAcceptance as unknown as Record<string, unknown>)[field]
    assert.throws(() => parseSampleSurveyRun(value))
  }
  for (const evidence of [undefined, null, [], 'accepted']) {
    const value = tolerantRun()
    Object.assign(value.observation!.strata[0], { boundaryAcceptance: evidence })
    assert.throws(() => parseSampleSurveyRun(value))
  }
  for (const patch of [{ startBefore: null }, { endBefore: null }, { totalCountBefore: null }, { totalCountBefore: 2100 }]) {
    const value = tolerantRun(); Object.assign(value.observation!.strata[0], patch)
    assert.throws(() => parseSampleSurveyRun(value))
  }
  const wrongPopulation = tolerantRun(); wrongPopulation.strata[0].population = wrongPopulation.strata[0].population! + 1
  assert.throws(() => parseSampleSurveyRun(wrongPopulation))
})

test('tolerant acceptance timestamps stay within the stratum and preserve reference/start/end order', () => {
  for (const patch of [{ referenceCheckedAt: '2026-10-26T23:59:59.000Z' },
    { referenceCheckedAt: '2026-10-27T00:00:21.000Z' }, { startObservedAt: '2026-10-27T00:00:31.000Z' },
    { endObservedAt: '2026-10-27T00:01:00.001Z' }, { endObservedAt: '2026-10-27T00:00:30Z' },
    { startObservedAt: '2026-02-30T00:00:00.000Z' }]) {
    const value = tolerantRun(); Object.assign(value.observation!.strata[0].boundaryAcceptance!, patch)
    assert.throws(() => parseSampleSurveyRun(value))
  }
  for (const patch of [{ startedAt: '2026-10-27T00:00:11.000Z' }, { finishedAt: '2026-10-27T00:00:29.999Z' }]) {
    const value = tolerantRun(); Object.assign(value.observation!.strata[0], patch)
    assert.throws(() => parseSampleSurveyRun(value))
  }
  assert.doesNotThrow(() => parseSampleSurveyRun(tolerantRun({ referenceCheckedAt: '2026-10-27T00:00:20.000Z',
    startObservedAt: '2026-10-27T00:00:20.000Z', endObservedAt: '2026-10-27T00:00:20.000Z' })), 'one fresh page may establish both boundaries')
})
