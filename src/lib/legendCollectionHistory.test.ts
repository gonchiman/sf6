import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGEND_COLLECTION_HISTORY_LIMIT, parseLegendCollectionHistory, type LegendCollectionRun } from './legendCollectionHistory.ts'
import { finalizeLegendCollectionRun } from '../../scripts/lib/legend-collection-run.ts'

const saved: LegendCollectionRun = {
  runId: '42316199947', runAttempt: 1, trigger: 'schedule',
  startedAt: '2026-11-07T00:07:19.000Z', endedAt: '2026-11-07T01:28:41.000Z',
  outcome: 'succeeded', phase: 'complete', reason: null, lastAttemptedPage: null,
  datasetId: 'legend-2026-11-07T00-07-40-858Z', rankingCount: 503, rankedMatchCount: 503,
}
const stopped: LegendCollectionRun = {
  ...saved, runId: '42426148449', startedAt: '2026-11-07T23:38:47.000Z', endedAt: '2026-11-07T23:43:04.000Z',
  outcome: 'stopped', phase: 'listing', reason: 'captcha', lastAttemptedPage: 19,
  datasetId: null, rankingCount: null, rankedMatchCount: null,
}

test('the last execution can have stopped while an older run still identifies the saved data', () => {
  const partial: LegendCollectionRun = { ...saved, runAttempt: 2, outcome: 'partial', phase: 'profiles',
    reason: 'human-verification', rankedMatchCount: 0 }
  assert.deepEqual(parseLegendCollectionHistory({ schemaVersion: 1, runs: [saved, stopped, partial] }).runs,
    [stopped, partial, saved])
})

test('history rejects duplicate attempts, unexpected fields, and counts that imply a failed save published data', () => {
  const parse = (...runs: unknown[]) => parseLegendCollectionHistory({ schemaVersion: 1, runs })
  assert.throws(() => parse(saved, saved))
  assert.throws(() => parse({ ...stopped, responseHeaders: {} }))
  assert.throws(() => parse({ ...saved, outcome: 'save-failed', phase: 'saving' }))
  assert.throws(() => parse({ ...saved, rankedMatchCount: 502 }))
  assert.throws(() => parse({ ...saved, startedAt: '2026-11-31T00:00:00.000Z' }))
  assert.throws(() => parse(...Array.from({ length: LEGEND_COLLECTION_HISTORY_LIMIT + 1 },
    (_, index) => ({ ...saved, runAttempt: index + 1 }))))
})

test('split result keeps the published ranking when profile collection or publication fails', () => {
  const ranking = { ...saved, outcome: 'partial', phase: 'profiles', reason: null, rankedMatchCount: 0 }
  const endedAt = '2026-11-07T01:30:00.000Z'
  const env = {
    GITHUB_RUN_ID: saved.runId, GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: saved.trigger,
    LEGEND_COLLECTION_RESULT: JSON.stringify(ranking), LEGEND_SAVE_JOB_RESULT: 'success',
    LEGEND_MATCH_ENDED_AT: endedAt,
  }
  const success = { LEGEND_MATCH_COLLECTION_RESULT: JSON.stringify({ datasetId: saved.datasetId, reason: null }),
    LEGEND_MATCH_COLLECT_JOB_RESULT: 'success', LEGEND_MATCH_SAVE_JOB_RESULT: 'success' }
  assert.deepEqual(finalizeLegendCollectionRun({ ...env, ...success }, endedAt), { ...saved, endedAt })
  assert.deepEqual(finalizeLegendCollectionRun({ ...env,
    LEGEND_MATCH_COLLECTION_RESULT: JSON.stringify({ datasetId: saved.datasetId, reason: 'captcha' }),
    LEGEND_MATCH_COLLECT_JOB_RESULT: 'failure', LEGEND_MATCH_SAVE_JOB_RESULT: 'success',
  }, endedAt), { ...ranking, endedAt, reason: 'captcha' })
  assert.deepEqual(finalizeLegendCollectionRun({ ...env, ...success, LEGEND_MATCH_SAVE_JOB_RESULT: 'failure' }, endedAt),
    { ...ranking, endedAt, reason: 'output-unavailable' })
  assert.deepEqual(finalizeLegendCollectionRun({ ...env, LEGEND_MATCH_COLLECT_JOB_RESULT: 'cancelled' }, endedAt),
    { ...ranking, endedAt, reason: 'cancelled' })
  assert.equal(finalizeLegendCollectionRun({ ...env, LEGEND_SAVE_JOB_RESULT: 'failure' }, endedAt).datasetId, null)
  assert.throws(() => finalizeLegendCollectionRun({ ...env,
    LEGEND_MATCH_COLLECTION_RESULT: JSON.stringify({ datasetId: 'wrong', reason: null }),
  }, endedAt), /Mismatched match collection result/)
})
