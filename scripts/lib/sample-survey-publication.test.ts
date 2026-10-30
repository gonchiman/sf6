import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SampleSurveyRun } from '../../src/types/sampleSurvey.ts'
import { publishableSampleSurveyRun, publishSampleSurveyResults, validateSampleSurveyResultsDirectory, writeSampleSurveyResults } from './sample-survey-publication.ts'

const generatedAt = '2026-10-27T01:00:00.000Z'
function result(id = 'run-1', minute = 0): SampleSurveyRun {
  const time = new Date(Date.parse('2026-10-27T00:00:00.000Z') + minute * 60000).toISOString()
  return { schemaVersion: 1, id, planId: 'plan-1', config: { ranks: ['MASTER'], rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 10 },
    state: 'complete', phase: 'complete', startedAt: time, updatedAt: time, finishedAt: time, elapsedMs: 0,
    attempts: 3, successfulPages: 3, uniqueAccountCount: 10, frameChanged: false, stopReason: null, resumeAllowed: false,
    strata: [{ id: 'lp-MASTER', label: 'MASTER', target: 'lp', requested: 10, population: 20, selected: 10, processed: 10,
      succeeded: 10, missing: 0, duplicates: 0, mean: 30000, min: 30000, max: 30000 }] }
}
function intervalResult(id = 'interval-run', review = false): SampleSurveyRun {
  const value = result(id, 1), observedAt = value.startedAt
  value.schemaVersion = 2
  value.observation = { method: 'rank-position-interval-v1', omittedChanges: 0,
    strata: [{ id: 'lp-MASTER', status: review ? 'review-required' : 'checked', startedAt: observedAt, finishedAt: observedAt,
      totalCountBefore: 20, totalCountAfter: 21, startBefore: 0, endBefore: 20, startAfter: 0, endAfter: 20, boundaryChanged: false }],
    changes: [{ kind: 'total-count', target: 'lp', stratumId: 'lp-MASTER', at: observedAt, before: 20, after: 21 }] }
  if (review) {
    value.frameChanged = true; value.uniqueAccountCount = 8
    Object.assign(value.strata[0], { succeeded: 8, missing: 1, duplicates: 1 })
    value.observation.changes.push(
      { kind: 'row-outside-stratum', target: 'lp', stratumId: 'lp-MASTER', at: observedAt, before: 0, after: 1 },
      { kind: 'duplicate', target: 'lp', stratumId: 'lp-MASTER', at: observedAt, before: 0, after: 1 })
  }
  return value
}
async function temporary(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'sample-survey-publication-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
test('publication merges immutable aggregate reports and contains only manifest plus run JSON', async t => {
  const root = await temporary(t), input = join(root, 'input'), output = join(root, 'history')
  await writeSampleSurveyResults([result()], output, generatedAt)
  await writeSampleSurveyResults([result('run-2', 1)], input, generatedAt)
  assert.deepEqual(await publishSampleSurveyResults(input, output, generatedAt), { datasets: 2 })
  const manifest = JSON.parse(await readFile(join(output, 'index.json'), 'utf8'))
  assert.deepEqual(manifest.datasets.map((row: { id: string }) => row.id), ['run-2', 'run-1'])
  assert.deepEqual((await readdir(output)).sort(), ['index.json', 'runs'])
  assert.deepEqual((await readdir(join(output, 'runs'))).sort(), ['run-1.json', 'run-2.json'])
  const report = JSON.parse(await readFile(join(output, 'runs/run-1.json'), 'utf8'))
  assert.deepEqual(report, result()); assert.equal('slots' in report, false)
  assert.deepEqual(await validateSampleSurveyResultsDirectory(output), { datasets: 2 })
})
test('invalid, partial, changed and private augmented reports cannot modify existing history', async t => {
  const root = await temporary(t), output = join(root, 'history')
  await writeSampleSurveyResults([result()], output, generatedAt)
  const before = await readFile(join(output, 'index.json'), 'utf8')
  const partial = result('partial'); Object.assign(partial, { state: 'stopped', phase: 'sampling', stopReason: 'limit-reached' })
  const changed = result('changed'); changed.frameChanged = true
  const missing = result('missing'); missing.strata[0].missing = 1; missing.strata[0].succeeded = 9; missing.uniqueAccountCount = 9
  const duplicate = result('duplicate'); duplicate.strata[0].duplicates = 1; duplicate.strata[0].succeeded = 9; duplicate.uniqueAccountCount = 9
  for (const value of [partial, changed, missing, duplicate, { ...result(), accountId: 'private-id' }, { ...result(), id: '../escape' }]) {
    assert.throws(() => publishableSampleSurveyRun(value))
    await assert.rejects(writeSampleSurveyResults([value], output, generatedAt))
    assert.equal(await readFile(join(output, 'index.json'), 'utf8'), before)
  }
})

test('completed interval observations preserve quality evidence alongside immutable legacy history', async t => {
  const root = await temporary(t), input = join(root, 'input'), output = join(root, 'history')
  await writeSampleSurveyResults([result()], output, generatedAt)
  const oldBytes = await readFile(join(output, 'runs/run-1.json'), 'utf8')
  const reviewed = intervalResult('reviewed', true)
  assert.deepEqual(publishableSampleSurveyRun(reviewed), reviewed)
  await writeSampleSurveyResults([reviewed], input, generatedAt)
  assert.deepEqual(await publishSampleSurveyResults(input, output, generatedAt), { datasets: 2 })
  assert.equal(await readFile(join(output, 'runs/run-1.json'), 'utf8'), oldBytes)
  assert.deepEqual(JSON.parse(await readFile(join(output, 'runs/reviewed.json'), 'utf8')), reviewed)
  const manifest = JSON.parse(await readFile(join(output, 'index.json'), 'utf8'))
  assert.equal(manifest.datasets[0].id, 'reviewed')
  const changed = structuredClone(reviewed); changed.observation!.omittedChanges = 1
  await assert.rejects(writeSampleSurveyResults([changed], output, generatedAt))
  assert.deepEqual(await validateSampleSurveyResultsDirectory(output), { datasets: 2 })
})

test('an unestablished interval frame is not published as zero, but a checked empty frame is', () => {
  const unknown = intervalResult('unknown'), observed = unknown.observation!.strata[0]
  unknown.uniqueAccountCount = 0; unknown.frameChanged = true
  Object.assign(unknown.strata[0], { population: null, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null })
  Object.assign(observed, { status: 'review-required', totalCountBefore: null, totalCountAfter: null,
    startBefore: null, endBefore: null, startAfter: null, endAfter: null })
  unknown.observation!.changes = []
  assert.throws(() => publishableSampleSurveyRun(unknown))
  const empty = intervalResult('empty-v2')
  empty.uniqueAccountCount = 0
  Object.assign(empty.strata[0], { population: 0, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null })
  Object.assign(empty.observation!.strata[0], { totalCountBefore: 0, totalCountAfter: 0, startBefore: 0, endBefore: 0, startAfter: 0, endAfter: 0 })
  empty.observation!.changes = []
  assert.deepEqual(publishableSampleSurveyRun(empty), empty)
})

test('tolerant boundary evidence survives publication beside legacy reports without exposing private rows', async t => {
  const root = await temporary(t), input = join(root, 'input'), output = join(root, 'history')
  const legacy = result(), report = intervalResult('tolerant-run')
  report.observation!.method = 'rank-position-tolerant-v1'
  report.frameChanged = true
  report.strata[0].population = 50001
  const observed = report.observation!.strata[0]
  Object.assign(observed, { status: 'review-required', totalCountBefore: 50001, totalCountAfter: 50001,
    startBefore: 0, endBefore: 50001, startAfter: 0, endAfter: 50001, boundaryChanged: true })
  observed.boundaryAcceptance = { mode: 'approximate', referenceStart: 0, referenceEnd: 50000,
    referenceCheckedAt: report.startedAt, start: 0, end: 50001,
    startObservedAt: report.startedAt, endObservedAt: report.startedAt }
  report.observation!.changes = [{ kind: 'boundary-end', target: 'lp', stratumId: 'lp-MASTER',
    at: report.startedAt, before: 50000, after: 50001 }]
  await writeSampleSurveyResults([legacy], output, generatedAt)
  const legacyBytes = await readFile(join(output, 'runs/run-1.json'), 'utf8')
  await writeSampleSurveyResults([report], input, generatedAt)
  assert.deepEqual(await publishSampleSurveyResults(input, output, generatedAt), { datasets: 2 })
  const published = JSON.parse(await readFile(join(output, 'runs/tolerant-run.json'), 'utf8'))
  assert.deepEqual(published, report)
  assert.equal(await readFile(join(output, 'runs/run-1.json'), 'utf8'), legacyBytes)
  assert.equal('slots' in published, false)
  assert.deepEqual(await validateSampleSurveyResultsDirectory(output), { datasets: 2 })

  const manifestBefore = await readFile(join(output, 'index.json'), 'utf8')
  const privateEvidence = { ...report, observation: { ...report.observation!, strata: [{ ...observed,
    boundaryAcceptance: { ...observed.boundaryAcceptance, accountId: 'must-not-be-published' } }] } }
  await assert.rejects(writeSampleSurveyResults([privateEvidence], output, generatedAt))
  const missingEvidence = structuredClone(report)
  delete missingEvidence.observation!.strata[0].boundaryAcceptance
  await assert.rejects(writeSampleSurveyResults([missingEvidence], output, generatedAt))
  assert.equal(await readFile(join(output, 'index.json'), 'utf8'), manifestBefore)
})

test('unfinished and augmented interval evidence cannot change published history', async t => {
  const root = await temporary(t), output = join(root, 'history')
  await writeSampleSurveyResults([result()], output, generatedAt)
  const before = await readFile(join(output, 'index.json'), 'utf8')
  const stopped = intervalResult('stopped')
  Object.assign(stopped, { state: 'stopped', phase: 'sampling', stopReason: 'limit-reached' })
  const pending = intervalResult('pending'); pending.observation!.strata[0].status = 'pending'
  const privateValue = intervalResult('private')
  const injected = { ...privateValue, observation: { ...privateValue.observation, accountIds: ['private-id'] } }
  for (const value of [stopped, pending, injected]) {
    await assert.rejects(writeSampleSurveyResults([value], output, generatedAt))
    assert.equal(await readFile(join(output, 'index.json'), 'utf8'), before)
  }
})
test('same ID content changes, unexpected files and oversized input preserve the old manifest', async t => {
  const root = await temporary(t), input = join(root, 'input'), output = join(root, 'history')
  await writeSampleSurveyResults([result()], output, generatedAt)
  const before = await readFile(join(output, 'index.json'), 'utf8')
  const conflict = result(); conflict.elapsedMs = 1
  await writeSampleSurveyResults([conflict], input, generatedAt)
  await assert.rejects(publishSampleSurveyResults(input, output, generatedAt))
  assert.equal(await readFile(join(output, 'index.json'), 'utf8'), before)
  await writeFile(join(input, 'private.json'), '{}')
  await assert.rejects(publishSampleSurveyResults(input, output, generatedAt))
  await rm(join(input, 'private.json'))
  await writeFile(join(input, 'runs/run-1.json'), ' '.repeat(256 * 1024 + 1))
  await assert.rejects(publishSampleSurveyResults(input, output, generatedAt))
  assert.equal(await readFile(join(output, 'index.json'), 'utf8'), before)
})
test('link ancestors and unexpected run files are rejected before reading or writing', async t => {
  const root = await temporary(t), outside = join(root, 'outside'), linked = join(root, 'linked')
  await mkdir(outside); await symlink(outside, linked, 'junction')
  await assert.rejects(writeSampleSurveyResults([result()], join(linked, 'history'), generatedAt))
  assert.deepEqual(await readdir(outside), [])
  const input = join(root, 'input')
  await writeSampleSurveyResults([result()], input, generatedAt)
  await writeFile(join(input, 'runs/unlisted.json'), '{}')
  await assert.rejects(validateSampleSurveyResultsDirectory(input))
})
test('history retains the most recent 100 successful reports and accepts an empty-stratum census', async t => {
  const root = await temporary(t), output = join(root, 'history')
  const time = '2026-10-27T03:00:00.000Z'
  await writeSampleSurveyResults(Array.from({ length: 100 }, (_, index) => result(`run-${index}`, index)), output, time)
  await writeSampleSurveyResults([result('run-100', 100)], output, time)
  const manifest = JSON.parse(await readFile(join(output, 'index.json'), 'utf8'))
  assert.equal(manifest.datasets.length, 100); assert.equal(manifest.datasets[0].id, 'run-100')
  assert.equal(manifest.datasets.some((row: { id: string }) => row.id === 'run-0'), false)
  assert.equal((await readdir(join(output, 'runs'))).length, 100)
  const empty = result('empty'); empty.uniqueAccountCount = 0
  Object.assign(empty.strata[0], { population: 0, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null })
  assert.deepEqual(publishableSampleSurveyRun(empty), empty)
})
