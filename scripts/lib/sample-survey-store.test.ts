import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { SampleSurveyPlan } from '../../src/types/sampleSurvey.ts'
import { createSampleSurveyCheckpoint, markSampleSurveyInterrupted } from './sample-survey-runner.ts'
import { createSampleSurveyStore } from './sample-survey-store.ts'

const plan: SampleSurveyPlan = { schemaVersion: 1, id: 'plan-1', createdAt: '2026-10-27T00:00:00.000Z', seed: 'b'.repeat(32),
  config: { ranks: ['GOLD'], rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 120 } }
function cleanup(path: string) {
  const absolute = resolve(path), temporary = resolve(tmpdir())
  assert.equal(dirname(absolute), temporary)
  assert.ok(absolute.startsWith(join(temporary, 'sf6-sampling-')))
  rmSync(absolute, { recursive: true, force: true })
}

test('private SQLite survives close, returns aggregates only, and protects plan identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf6-sampling-'))
  try {
    const store = createSampleSurveyStore(root)
    assert.throws(() => createSampleSurveyStore(root), 'a second live owner cannot mutate the same checkpoint store')
    store.savePlan(plan); store.savePlan(plan)
    assert.equal(store.listPlans().length, 1)
    assert.throws(() => store.savePlan({ ...plan, seed: 'c'.repeat(32) }))
    const checkpoint = createSampleSurveyCheckpoint(plan, Date.parse(plan.createdAt))
    store.saveRun(checkpoint)
    const interrupted = markSampleSurveyInterrupted(checkpoint, Date.parse(plan.createdAt) + 1000)
    store.saveRun(interrupted); store.saveRun(interrupted)
    assert.equal(store.listRuns().length, 1)
    assert.deepEqual(Object.keys(store.listRuns()[0]).sort(), Object.keys(interrupted.report).sort())
    assert.throws(() => store.saveRun(checkpoint))
    store.close()
    const reopened = createSampleSurveyStore(root)
    assert.deepEqual(reopened.loadRun(checkpoint.report.id), interrupted)
    assert.deepEqual(reopened.listPlans(), [plan])
    assert.equal(reopened.loadRun('not-found'), null)
    assert.throws(() => reopened.loadRun('../outside'))
    reopened.close()
  } finally { cleanup(root) }
})

test('public destinations and linked private directories are rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'sf6-sampling-'))
  try {
    mkdirSync(join(root, 'public'))
    assert.throws(() => createSampleSurveyStore(join(root, 'public')))
    const outside = join(root, 'outside'); mkdirSync(outside)
    try { symlinkSync(outside, join(root, '.local'), process.platform === 'win32' ? 'junction' : 'dir') }
    catch { t.diagnostic('Symbolic links unavailable; public-directory guard was verified.'); return }
    assert.throws(() => createSampleSurveyStore(root))
  } finally { cleanup(root) }
})
