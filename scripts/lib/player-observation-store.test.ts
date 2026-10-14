import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PlayerObservationStore, assertPrivateObservationPath } from './player-observation-store.ts'
import { TEST_GENERATED_AT, testDirectory, testPage, testRun, testTime } from './player-observation-test-fixtures.ts'

async function fixtureStore(t: test.TestContext): Promise<PlayerObservationStore> {
  let store: PlayerObservationStore | undefined
  // Node's after hooks run in registration order: close SQLite before directory cleanup.
  t.after(() => store?.close())
  const root = await testDirectory(t)
  store = new PlayerObservationStore(join(root, 'history.sqlite'))
  return store
}

test('first full baseline counts existing IDs without claiming new accounts; probe cannot establish it', async (t) => {
  const store = await fixtureStore(t)
  store.beginRun(testRun('initial-probe', 0, 'probe'))
  store.recordPage('initial-probe', testPage())
  assert.equal(store.finishRun('initial-probe', testTime(9)).status, 'partial')
  assert.deepEqual(store.snapshotDataset(TEST_GENERATED_AT).baseline, { status: 'preparing', completedAt: null })
  store.beginRun(testRun('initial-full', 10))
  store.recordPage('initial-full', testPage(1, 20, 11))
  const result = store.finishRun('initial-full', testTime(19))
  assert.equal(result.status, 'complete')
  assert.equal(result.observedIdCount, 20)
  assert.equal(result.newObservedCount, null)
  assert.equal(result.newObservedLowerBound, null)
  assert.deepEqual(store.snapshotDataset(TEST_GENERATED_AT).baseline, { status: 'ready', completedAt: testTime(19) })
})

test('partial observations retain original first-seen run and do not disappear into a later complete scan', async (t) => {
  const store = await fixtureStore(t)
  store.beginRun(testRun()); store.recordPage('baseline', testPage()); store.finishRun('baseline', testTime(9))
  store.beginRun(testRun('partial', 10)); store.recordPage('partial', testPage(2, 21, 11, ['9999999999']))
  store.recordFailure('partial', 1)
  const partial = store.finishRun('partial', testTime(19))
  assert.equal(partial.newObservedCount, null)
  assert.equal(partial.newObservedLowerBound, 1)
  store.beginRun(testRun('next-full', 20))
  store.recordPage('next-full', testPage(1, 21, 21))
  store.recordPage('next-full', testPage(2, 21, 22, ['9999999999']))
  const complete = store.finishRun('next-full', testTime(29))
  assert.equal(complete.status, 'complete')
  assert.equal(complete.newObservedCount, 0)
  assert.equal(store.runSummary('partial').newObservedLowerBound, 1)
  const event = store.database.prepare('SELECT first_observed_at,run_id,phase FROM observation_first_seen WHERE cfn_id=?').get('9999999999')
  assert.equal(event?.first_observed_at, testTime(11))
  assert.equal(event?.run_id, 'partial')
  const serialized = JSON.stringify(store.snapshotDataset(TEST_GENERATED_AT))
  assert.equal(serialized.includes('9999999999'), false)
  assert.equal(serialized.includes('cfn_id'), false)
})

test('checkpoint resumes after reopening, and identical finished input is idempotent', async (t) => {
  let store: PlayerObservationStore
  t.after(() => store?.close())
  const path = join(await testDirectory(t), 'history.sqlite')
  store = new PlayerObservationStore(path)
  store.beginRun(testRun('resume'))
  store.recordPage('resume', testPage(1, 40))
  store.close()
  store = new PlayerObservationStore(path)
  store.beginRun(testRun('resume'))
  store.recordPage('resume', testPage(1, 40))
  store.recordPage('resume', testPage(2, 40, 2))
  store.finishRun('resume', testTime(9))
  store.beginRun(testRun('resume'))
  store.recordPage('resume', testPage(1, 40))
  store.recordPage('resume', testPage(2, 40, 2))
  store.finishRun('resume', testTime(9))
  const dataset = store.snapshotDataset(TEST_GENERATED_AT)
  assert.equal(dataset.runs.length, 1)
  assert.equal(dataset.runs[0].pages.succeeded, 2)
  assert.equal(dataset.runs[0].observedIdCount, 40)
})

test('unfinished gaps and failure markers prevent false complete baselines', async (t) => {
  const store = await fixtureStore(t)
  store.beginRun(testRun('gap'))
  store.recordPage('gap', testPage(1, 60))
  store.recordPage('gap', testPage(3, 60, 2))
  const gap = store.finishRun('gap', testTime(9))
  assert.equal(gap.status, 'partial')
  assert.equal(gap.coverage, 'incomplete')
  assert.equal(gap.pages.expectedAtEnd, 3)
  assert.equal(store.snapshotDataset(TEST_GENERATED_AT).baseline.status, 'preparing')
  store.beginRun(testRun('failure', 10))
  store.recordFailure('failure', 1)
  const failure = store.finishRun('failure', testTime(19))
  assert.equal(failure.status, 'failed')
  assert.equal(failure.observedIdCount, null)
  assert.equal(failure.newObservedCount, null)
  assert.equal(failure.coverage, 'none')
})

test('changing totals and overlapping page IDs are recorded without assuming one frozen population', async (t) => {
  const store = await fixtureStore(t)
  store.beginRun(testRun('live-changes'))
  store.recordPage('live-changes', testPage(1, 40))
  const duplicatePage = testPage(2, 39, 2)
  duplicatePage.rows[0].cfnId = testPage().rows[0].cfnId
  store.recordPage('live-changes', duplicatePage)
  const result = store.finishRun('live-changes', testTime(9))
  assert.equal(result.status, 'complete')
  assert.equal(result.observedIdCount, 38)
  assert.equal(result.reportedTotalAtStart, 40)
  assert.equal(result.reportedTotalAtEnd, 39)
  assert.equal(result.warnings.length, 2)
})

test('missing baseline history stays missing after readiness; missing and failure never become zero', async (t) => {
  const store = await fixtureStore(t)
  const missing = store.recordMissingRun('missed-before', testTime(0))
  assert.equal(missing.newObservedCount, null)
  assert.equal(missing.observedIdCount, null)
  store.beginRun(testRun('baseline', 10))
  store.recordPage('baseline', testPage(1, 20, 11))
  store.finishRun('baseline', testTime(19))
  const after = store.recordMissingRun('missed-after', testTime(20))
  assert.equal(after.phase, 'observation')
  assert.equal(after.newObservedCount, null)
  const dataset = store.snapshotDataset(TEST_GENERATED_AT)
  assert.equal(dataset.runs[0].status, 'missing')
  assert.equal(dataset.runs[0].phase, 'baseline')
})

test('active runs, changed checkpoints, and historical backfill cannot silently rewrite first-seen events', async (t) => {
  const store = await fixtureStore(t)
  store.beginRun(testRun('active'))
  assert.throws(() => store.beginRun(testRun('other', 10)), /終了していない/)
  store.recordPage('active', testPage())
  const changed = testPage(); changed.rows[0].lp = 2
  assert.throws(() => store.recordPage('active', changed), /内容が変わって/)
  assert.throws(() => store.recordFailure('active', 1), /取得済み/)
  store.finishRun('active', testTime(9))
  assert.throws(() => store.beginRun(testRun('past', 0)), /過去の走査/)
  assert.throws(() => store.beginRun(testRun('active', 10)), /同じ走査ID/)
})

test('rejects public DB paths before exposing account IDs', () => {
  assert.throws(() => assertPrivateObservationPath('public/data/player-observations/history.sqlite'), /非公開/)
})

test('repository public DB paths remain rejected when CLI runs from a different working directory', async (t) => {
  const otherDirectory = await testDirectory(t)
  const originalDirectory = process.cwd()
  const repositoryPublicDb = fileURLToPath(new URL('../../public/data/player-observations/history.sqlite', import.meta.url))
  try {
    process.chdir(otherDirectory)
    assert.throws(() => assertPrivateObservationPath(repositoryPublicDb), /非公開/)
    assert.throws(() => assertPrivateObservationPath('public/history.sqlite'), /非公開/)
    assert.equal(assertPrivateObservationPath(join(otherDirectory, 'private.sqlite')), join(otherDirectory, 'private.sqlite'))
  } finally { process.chdir(originalDirectory) }
})
