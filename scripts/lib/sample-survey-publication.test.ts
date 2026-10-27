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
