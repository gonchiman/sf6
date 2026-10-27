import test from 'node:test'
import assert from 'node:assert/strict'
import { SAMPLE_SURVEY_RANKS } from '../../src/lib/sampleSurvey.ts'
import type { SampleSurveyPlan, SampleSurveyTarget } from '../../src/types/sampleSurvey.ts'
import { SampleSurveyReadError } from './sample-survey-reader.ts'
import type { SampleSurveyPage, SampleSurveyReader } from './sample-survey-reader.ts'
import { canResumeSampleSurvey, createSampleSurveyCheckpoint, markSampleSurveyInterrupted, parseSampleSurveyCheckpoint, runSampleSurvey, sampleSurveyPositions } from './sample-survey-runner.ts'

const startTime = Date.parse('2026-10-27T00:00:00.000Z')
function plan(overrides: Partial<SampleSurveyPlan['config']> = {}): SampleSurveyPlan {
  return { schemaVersion: 1, id: 'plan-test', seed: 'a'.repeat(32), createdAt: new Date(startTime).toISOString(),
    config: { ranks: [...SAMPLE_SURVEY_RANKS], rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 30, ...overrides } }
}
function fixture(config: { rowsPerStratum?: number; mr?: boolean } = {}) {
  let clock = startTime
  const rowsPerStratum = config.rowsPerStratum ?? 40
  const lp = [36, 31, 26, 21, 16, 11, 6, 1].flatMap((rankId, group) => Array.from({ length: rowsPerStratum }, (_, index) => ({
    accountId: String(100_000 + group * rowsPerStratum + index), value: rankId * 1000 + rowsPerStratum - index, rankId,
  })))
  const mr = [2200, 1900, 1700, 1500, 1300, 1000].flatMap((value, group) => Array.from({ length: rowsPerStratum }, (_, index) => ({
    accountId: String(200_000 + group * rowsPerStratum + index), value: value + rowsPerStratum - index, rankId: null,
  })))
  const calls: { target: SampleSurveyTarget; page: number; at: number }[] = []
  const firstRead = new Set<SampleSurveyTarget>()
  const reader: SampleSurveyReader = {
    async readPage(target, page) {
      if (!firstRead.has(target)) { assert.equal(page, 1); firstRead.add(target) }
      calls.push({ target, page, at: clock }); clock += 100
      const rows = target === 'lp' ? lp : mr
      return { target, page, pageSize: 20, totalCount: rows.length, totalPages: Math.ceil(rows.length / 20),
        observedAt: new Date(clock).toISOString(), entries: rows.slice((page - 1) * 20, page * 20).map(row => ({ ...row })) }
    }, async close() {},
  }
  return { reader, calls, lp, mr, now: () => clock, wait: async (milliseconds: number) => { clock += milliseconds }, resetFirst: () => firstRead.clear() }
}

test('seeded sample uses unique positions without allocating a large population', () => {
  const a = sampleSurveyPositions(100, 3_000_000, 1000, 'seed')
  assert.deepEqual(a, sampleSurveyPositions(100, 3_000_000, 1000, 'seed'))
  assert.notDeepEqual(a, sampleSurveyPositions(100, 3_000_000, 1000, 'other'))
  assert.equal(new Set(a).size, 1000)
  assert.ok(a.every(value => value >= 100 && value < 3_000_000))
  assert.deepEqual(sampleSurveyPositions(5, 9, 4, 'seed'), [5, 6, 7, 8])
  assert.deepEqual(sampleSurveyPositions(5, 5, 0, 'seed'), [])
  assert.throws(() => sampleSurveyPositions(0, 10, 11, 'seed'))
})

test('finds LP and MR boundaries, groups pages and keeps IDs out of public report', async () => {
  const f = fixture(), updates: number[] = []
  const result = await runSampleSurvey(plan({ includeMr: true }), { ...f, signal: new AbortController().signal,
    onUpdate(checkpoint) { updates.push(checkpoint.report.attempts) } })
  assert.equal(result.report.state, 'complete')
  assert.equal(result.slots.length, 140)
  assert.equal(result.report.strata.length, 14)
  assert.ok(result.report.strata.every(row => row.population === 40 && row.selected === 10 && row.succeeded === 10))
  assert.equal(result.report.uniqueAccountCount, 140)
  assert.equal(result.report.successfulPages, result.report.attempts)
  assert.ok(result.report.attempts < 140)
  for (let i = 1; i < f.calls.length; i++) assert.ok(f.calls[i].at - f.calls[i - 1].at >= 10_000)
  const encoded = JSON.stringify(result.report)
  assert.ok(!encoded.includes('accountId'))
  for (const slot of result.slots) assert.ok(!encoded.includes('"' + slot.accountId + '"'))
  assert.ok(updates.length > f.calls.length)
  assert.deepEqual(parseSampleSurveyCheckpoint(result), result)
})

test('small and empty strata cap selection to the observed population', async () => {
  const f = fixture({ rowsPerStratum: 3 })
  // No IRON rows at all.
  f.lp.splice(f.lp.findIndex(row => row.rankId === 6), 3)
  const result = await runSampleSurvey(plan(), { ...f, signal: new AbortController().signal })
  assert.equal(result.report.state, 'complete')
  const iron = result.report.strata.find(row => row.id === 'lp-IRON')!
  assert.equal(iron.population, 0); assert.equal(iron.selected, 0); assert.equal(iron.mean, null)
  assert.ok(result.report.strata.filter(row => row.id !== 'lp-IRON').every(row => row.selected === 3 && row.requested === 10))
})

test('stopped sample resumes exact target positions and preserves prior observations', async () => {
  const f = fixture(), controller = new AbortController()
  const value = plan()
  const first = await runSampleSurvey(value, { ...f, signal: controller.signal,
    onUpdate(checkpoint) { if (checkpoint.report.uniqueAccountCount >= 10 && !controller.signal.aborted) controller.abort() } })
  assert.equal(first.report.state, 'stopped'); assert.equal(first.report.resumeAllowed, true)
  const positions = first.slots.map(slot => slot.id), collected = first.slots.filter(slot => slot.status === 'collected')
  f.resetFirst()
  const second = await runSampleSurvey(value, { ...f, signal: new AbortController().signal, checkpoint: first })
  assert.equal(second.report.state, 'complete')
  assert.deepEqual(second.slots.map(slot => slot.id), positions)
  for (const slot of collected) assert.deepEqual(second.slots.find(candidate => candidate.id === slot.id), slot)
  assert.ok(second.report.elapsedMs > first.report.elapsedMs)
  assert.equal(second.report.uniqueAccountCount, 80)
})

test('new invocation budget is separate from cumulative elapsed time', async () => {
  const f = fixture(), value = plan({ maxDurationMinutes: 1 })
  const first = await runSampleSurvey(value, { ...f, signal: new AbortController().signal })
  assert.equal(first.report.stopReason, 'limit-reached'); assert.equal(first.report.resumeAllowed, true)
  const oldAttempts = first.report.attempts
  f.resetFirst()
  const second = await runSampleSurvey(value, { ...f, signal: new AbortController().signal, checkpoint: first })
  assert.equal(second.report.stopReason, 'limit-reached')
  assert.ok(second.report.attempts > oldAttempts)
  assert.ok(second.report.elapsedMs > first.report.elapsedMs)
})

test('changed frame on resume stops without substituting targets', async () => {
  const f = fixture(), controller = new AbortController(), value = plan()
  const first = await runSampleSurvey(value, { ...f, signal: controller.signal,
    onUpdate(checkpoint) { if (checkpoint.slots.length && !controller.signal.aborted) controller.abort() } })
  const ids = first.slots.map(slot => slot.id)
  f.lp.push({ accountId: '999999', value: 1, rankId: 1 }); f.resetFirst()
  const second = await runSampleSurvey(value, { ...f, signal: new AbortController().signal, checkpoint: first })
  assert.equal(second.report.stopReason, 'frame-changed'); assert.equal(second.report.resumeAllowed, false)
  assert.deepEqual(second.slots.map(slot => slot.id), ids)
})

test('human verification stops once and never exposes an automatic resume', async () => {
  let calls = 0
  const reader: SampleSurveyReader = { async readPage() { calls++; throw new SampleSurveyReadError('human-verification') }, async close() {} }
  const result = await runSampleSurvey(plan(), { reader, signal: new AbortController().signal })
  assert.equal(calls, 1); assert.equal(result.report.stopReason, 'human-verification'); assert.equal(result.report.resumeAllowed, false)
})

test('duplicate accounts within a series are counted once and retained as missing evidence', async () => {
  const f = fixture({ rowsPerStratum: 10 })
  f.lp[20].accountId = f.lp[0].accountId
  const result = await runSampleSurvey(plan(), { ...f, signal: new AbortController().signal })
  assert.equal(result.report.state, 'complete')
  assert.equal(result.report.uniqueAccountCount, 79)
  assert.equal(result.report.strata.reduce((sum, row) => sum + row.duplicates, 0), 1)
  assert.equal(result.report.strata.reduce((sum, row) => sum + row.succeeded, 0), 79)
  assert.equal(result.report.frameChanged, true)
})

test('LP and MR memberships are separate while their account overlap is deduplicated', async () => {
  const f = fixture({ rowsPerStratum: 10 })
  f.mr[0].accountId = f.lp[0].accountId
  const result = await runSampleSurvey(plan({ includeMr: true }), { ...f, signal: new AbortController().signal })
  assert.equal(result.report.state, 'complete')
  assert.equal(result.report.uniqueAccountCount, 139)
  assert.equal(result.report.strata.reduce((sum, row) => sum + row.succeeded, 0), 140)
  assert.equal(result.report.strata.reduce((sum, row) => sum + row.duplicates, 0), 0)
})

test('a checkpoint persistence failure stops before network access', async () => {
  const f = fixture()
  const result = await runSampleSurvey(plan(), { ...f, signal: new AbortController().signal,
    onUpdate() { throw new Error('secret raw path or browser information') } })
  assert.equal(f.calls.length, 0)
  assert.equal(result.report.stopReason, 'storage-error')
  assert.equal(result.report.resumeAllowed, false)
  assert.ok(!JSON.stringify(result.report).includes('secret'))
})

test('checkpoint factory and interruption preserve an immediate public run', () => {
  const initial = createSampleSurveyCheckpoint(plan(), startTime)
  assert.equal(initial.report.state, 'preparing'); assert.equal(initial.report.strata.length, 8)
  const interrupted = markSampleSurveyInterrupted(initial, startTime + 1000)
  assert.equal(interrupted.report.stopReason, 'interrupted'); assert.equal(interrupted.report.resumeAllowed, true)
  const corrupt = structuredClone(interrupted); corrupt.report.strata[0].population = 300
  assert.throws(() => parseSampleSurveyCheckpoint(corrupt))
})

for (const changedRead of [2, 3]) test(`detects moving boundaries with unchanged totals on read ${changedRead}`, async () => {
  let calls = 0, clock = startTime
  const reader: SampleSurveyReader = { async readPage(target, page) {
    calls++
    return { target, page, pageSize: 20, totalCount: 20, totalPages: 1, observedAt: new Date(clock).toISOString(),
      entries: Array.from({ length: 20 }, (_, index) => ({ accountId: String(100_000 + index),
        rankId: calls < changedRead && index >= 10 ? 31 : 36,
        value: calls < changedRead && index >= 10 ? 20_000 - index : 30_000 - index })) }
  }, async close() {} }
  const result = await runSampleSurvey(plan({ ranks: ['MASTER'] }), { reader, signal: new AbortController().signal,
    now: () => clock, wait: async milliseconds => { clock += milliseconds } })
  assert.equal(result.report.stopReason, 'frame-changed')
  assert.equal(result.report.frameChanged, true)
  assert.equal(result.report.resumeAllowed, false)
  assert.equal(result.report.strata[0].succeeded, 0)
  assert.equal(calls, changedRead)
})

test('a deadline abort during a read is retained as limit-reached', async () => {
  const controller = new AbortController()
  const reader: SampleSurveyReader = { async readPage() {
    controller.abort(new SampleSurveyReadError('limit-reached'))
    throw new SampleSurveyReadError('cancelled')
  }, async close() {} }
  const result = await runSampleSurvey(plan(), { reader, signal: controller.signal })
  assert.equal(result.report.stopReason, 'limit-reached')
  assert.equal(result.report.resumeAllowed, true)
})

test('MR observations disable continuation until a concrete Act identity is available', async () => {
  const f = fixture(), controller = new AbortController(), value = plan({ ranks: [], includeMr: true })
  const result = await runSampleSurvey(value, { ...f, signal: controller.signal,
    onUpdate(checkpoint) { if (checkpoint.report.uniqueAccountCount) controller.abort() } })
  assert.equal(result.report.stopReason, 'cancelled')
  assert.equal(result.report.resumeAllowed, false)
  assert.equal(canResumeSampleSurvey(result), false)
  assert.ok(result.slots.some(slot => slot.target === 'mr' && slot.status === 'collected'))
  const forged = structuredClone(result); forged.report.resumeAllowed = true
  const beforeRejectedResume = f.calls.length
  await assert.rejects(runSampleSurvey(value, { ...f, checkpoint: forged, signal: new AbortController().signal }))
  assert.equal(f.calls.length, beforeRejectedResume)
  const interrupted = structuredClone(result)
  Object.assign(interrupted.report, { state: 'running', stopReason: null, finishedAt: null, resumeAllowed: false })
  assert.equal(markSampleSurveyInterrupted(interrupted).report.resumeAllowed, false)
})

test('MR pending-only positions may resume without carrying observations across Acts', async () => {
  const f = fixture(), controller = new AbortController(), value = plan({ ranks: [], includeMr: true })
  const result = await runSampleSurvey(value, { ...f, signal: controller.signal,
    onUpdate(checkpoint) { if (checkpoint.slots.length) controller.abort() } })
  assert.equal(result.report.stopReason, 'cancelled')
  assert.equal(result.report.resumeAllowed, true)
  assert.equal(canResumeSampleSurvey(result), true)
  assert.ok(result.slots.every(slot => slot.status === 'pending'))
})
