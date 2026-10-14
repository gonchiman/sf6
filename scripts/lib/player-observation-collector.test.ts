import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { collectPlayerObservationInput, markPlayerObservationMissingRun, parsePlayerObservationInput, parsePlayerObservationPageCapture } from './player-observation-collector.ts'
import { PlayerObservationStore } from './player-observation-store.ts'
import { TEST_GENERATED_AT, testDirectory, testInput, testPage, testRun, testTime } from './player-observation-test-fixtures.ts'

test('accepts normal-page records with same-rank ties and validates row positions separately', () => {
  const input = testInput(testRun('last-page', 0, 'probe'), [testPage(152760, 3055188)])
  const parsed = parsePlayerObservationInput(input)
  assert.equal(parsed.captures[0].range.from, 3055181)
  assert.equal(parsed.captures[0].rows.length, 8)
  assert.equal(parsed.captures[0].rows[0].rank, 1)
})

test('rejects Rookie/character records, stale selections, other sources, and hidden response flags', () => {
  const cases = [
    (input: any) => { input.captures[0].conditions.league = 'rookie1' },
    (input: any) => { input.captures[0].url = input.captures[0].url.replace('character_filter=2', 'character_filter=1') },
    (input: any) => { input.captures[0].url = input.captures[0].url.replace('page=1', 'page=2') },
    (input: any) => { input.captures[0].url = input.captures[0].url.replace('www.streetfighter.com', 'example.com') },
    (input: any) => { input.captures[0].httpStatus = 200 },
    (input: any) => { input.captures[0].url += '&cookie=private' },
    (input: any) => { input.captures[0].rows[0].name = 'Player name' },
  ]
  for (const change of cases) { const input = testInput(); change(input); assert.throws(() => parsePlayerObservationInput(input)) }
})

test('rejects truncated pages, mismatched totals, numeric IDs, duplicate IDs and unsafe timestamps', () => {
  const cases = [
    (page: any) => page.rows.pop(),
    (page: any) => { page.range.from = 2 },
    (page: any) => { page.range.total = 19 },
    (page: any) => { page.rows[0].cfnId = 9000000001 },
    (page: any) => { page.rows[1].cfnId = page.rows[0].cfnId },
    (page: any) => { page.capturedAt = '2026-02-30T00:00:00Z' },
    (page: any) => { page.rows[0].lp = -1 },
  ]
  for (const change of cases) { const page = testPage(); change(page); assert.throws(() => parsePlayerObservationPageCapture(page)) }
  const outside = testInput(); outside.captures[0].capturedAt = testTime(20)
  assert.throws(() => parsePlayerObservationInput(outside), /走査区間/)
})

test('conflicting repeated pages are not converted into completed coverage, and errors are sanitized', () => {
  const duplicate = testInput(); duplicate.captures.push(testPage())
  assert.throws(() => parsePlayerObservationInput(duplicate), /同ページ/)
  const failure = testInput(); failure.failures = [{ page: 1, reason: 'Cookie: secret' }]
  assert.throws(() => parsePlayerObservationInput(failure), /成功ページ/)
  const safe = testInput(testRun('failed'), []); safe.failures = [{ page: 1, reason: 'Cookie: secret' }]
  assert.equal(JSON.stringify(parsePlayerObservationInput(safe)).includes('secret'), false)
})

test('inbox adapter imports a saved file without network access and preserves replay idempotency', async (t) => {
  const root = await testDirectory(t), input = join(root, 'input.json'), database = join(root, 'private.sqlite')
  await writeFile(input, JSON.stringify(testInput(testRun('probe', 0, 'probe'))))
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network must not be used') })
  assert.equal((await collectPlayerObservationInput(input, database)).status, 'partial')
  assert.equal((await collectPlayerObservationInput(input, database)).observedIdCount, 20)
  const store = new PlayerObservationStore(database)
  try {
    const snapshot = store.snapshotDataset(TEST_GENERATED_AT)
    assert.equal(snapshot.runs.length, 1)
    assert.equal(snapshot.baseline.status, 'preparing')
    assert.equal(snapshot.runs[0].newObservedCount, null)
  } finally { store.close() }
})

test('missing-run boundary is idempotent before and after baseline, and rejects future dates without creating DB', async (t) => {
  const root = await testDirectory(t), database = join(root, 'private.sqlite')
  const first = markPlayerObservationMissingRun('missing-before', testTime(0), database)
  assert.equal(first.phase, 'baseline')
  assert.equal(first.observedIdCount, null)
  assert.equal(first.newObservedCount, null)
  assert.deepEqual(markPlayerObservationMissingRun('missing-before', testTime(0), database), first)
  const store = new PlayerObservationStore(database)
  try {
    store.beginRun(testRun('baseline', 10))
    store.recordPage('baseline', testPage(1, 20, 11))
    store.finishRun('baseline', testTime(19))
  } finally { store.close() }
  const after = markPlayerObservationMissingRun('missing-after', testTime(20), database)
  assert.equal(after.phase, 'observation')
  assert.equal(after.observedIdCount, null)
  assert.equal(after.newObservedCount, null)
  assert.equal(after.newObservedLowerBound, null)
  assert.deepEqual(markPlayerObservationMissingRun('missing-after', testTime(20), database), after)
  const futureDatabase = join(root, 'future-missing.sqlite')
  assert.throws(() => markPlayerObservationMissingRun('future', new Date(Date.now() + 60_000).toISOString(), futureDatabase), /未来/)
  await assert.rejects(stat(futureDatabase), { code: 'ENOENT' })
})

test('future inbox record is rejected at ingestion boundary before creating private history', async (t) => {
  const root = await testDirectory(t), inputPath = join(root, 'future.json'), database = join(root, 'future.sqlite')
  const input = testInput()
  input.run.endedAt = new Date(Date.now() + 60_000).toISOString()
  // Structural parsing remains useful for independent fixtures; only ingestion uses the current clock.
  assert.doesNotThrow(() => parsePlayerObservationInput(input))
  await writeFile(inputPath, JSON.stringify(input))
  await assert.rejects(collectPlayerObservationInput(inputPath, database), /未来/)
  await assert.rejects(stat(database), { code: 'ENOENT' })
})
