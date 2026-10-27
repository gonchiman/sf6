import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import type { SampleSurveyRun } from '../types/sampleSurvey.ts'
import type { SampleSurveyResultsDescriptor, SampleSurveyResultsManifest } from '../types/sampleSurveyResults.ts'
import { createSampleSurveyResultsFeed, parseSampleSurveyResultsDescriptor, parseSampleSurveyResultsManifest,
  parseSampleSurveyResultsRun, SAMPLE_SURVEY_RESULTS_SOURCE, SAMPLE_SURVEY_RESULTS_MAX_DATASETS,
  SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES } from './sampleSurveyResults.ts'
import { createPublishedDataController } from './publishedDataController.ts'

const historyBaseUrl = 'https://history.example/public/data/sample-survey/'
const localBaseUrl = '/sf6/data/sample-survey/'
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function run(day = '20'): SampleSurveyRun {
  return { schemaVersion: 1, id: `survey-${day}`, planId: `plan-${day}`,
    config: { ranks: ['MASTER'], rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 10 },
    state: 'complete', phase: 'complete', startedAt: `2026-10-${day}T01:00:00.000Z`,
    updatedAt: `2026-10-${day}T01:05:00.000Z`, finishedAt: `2026-10-${day}T01:05:00.000Z`,
    elapsedMs: 300000, attempts: 2, successfulPages: 2, uniqueAccountCount: 3,
    strata: [{ id: 'lp-MASTER', label: 'MASTER', target: 'lp', requested: 10, population: 3, selected: 3, processed: 3,
      succeeded: 3, missing: 0, duplicates: 0, mean: 25000, min: 24900, max: 25100 }],
    frameChanged: false, stopReason: null, resumeAllowed: false }
}
function descriptor(value = run()): SampleSurveyResultsDescriptor {
  return { id: value.id, path: `runs/${value.id}.json`, captureStartedAt: value.startedAt, captureEndedAt: value.finishedAt! }
}
function manifest(values: SampleSurveyRun[] = [run()], generatedAt = '2026-10-21T00:00:00.000Z'): SampleSurveyResultsManifest {
  return { schemaVersion: 1, generatedAt, source: { ...SAMPLE_SURVEY_RESULTS_SOURCE }, datasets: values.map(descriptor) }
}
function feed(fetchData: typeof fetch, timeoutMs = 1000) {
  return createSampleSurveyResultsFeed({ fetch: fetchData, historyBaseUrl, localBaseUrl, timeoutMs })
}

test('completed public runs retain frame changes, missing counts and observed zero distinctly', () => {
  assert.deepEqual(parseSampleSurveyResultsRun(run(), descriptor()), run())
  const changed = run()
  Object.assign(changed.strata[0], { succeeded: 1, missing: 1, duplicates: 1, min: 25000, max: 25000 })
  changed.uniqueAccountCount = 1; changed.frameChanged = true
  assert.deepEqual(parseSampleSurveyResultsRun(changed), changed)
  const zero = run()
  Object.assign(zero.strata[0], { population: 0, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null })
  zero.uniqueAccountCount = 0
  assert.equal(parseSampleSurveyResultsRun(zero).strata[0].population, 0)
  for (const state of ['preparing', 'running', 'error', 'stopped']) {
    assert.throws(() => parseSampleSurveyResultsRun({ ...run(), state,
      finishedAt: ['preparing', 'running'].includes(state) ? null : run().finishedAt,
      stopReason: ['error', 'stopped'].includes(state) ? 'read-failed' : null }))
  }
  assert.throws(() => parseSampleSurveyResultsRun({ ...run(), rows: [{ accountId: 'private-account' }] }))
  const privateStratum = { ...run(), strata: [{ ...run().strata[0], accountIds: ['private-account'] }] }
  assert.throws(() => parseSampleSurveyResultsRun(privateStratum))
  assert.throws(() => parseSampleSurveyResultsRun(run(), descriptor(run('19'))))
})

test('manifest accepts only a bounded exact source and fixed relative run filenames', () => {
  assert.deepEqual(parseSampleSurveyResultsManifest(manifest()), manifest())
  assert.deepEqual(parseSampleSurveyResultsManifest(manifest([])).datasets, [])
  for (const path of ['https://evil.example/data.json', '//evil.example/run.json', '../run.json', 'runs/../survey-20.json',
    'runs%2fsurvey-20.json', 'runs/survey-20.json?token=private', 'runs/survey-20.json#x', 'runs\\survey-20.json', 'runs/other.json']) {
    assert.throws(() => parseSampleSurveyResultsDescriptor({ ...descriptor(), path }))
  }
  for (const bad of [
    { ...manifest(), schemaVersion: 2 }, { ...manifest(), private: 'private-secret' },
    { ...manifest(), source: { ...SAMPLE_SURVEY_RESULTS_SOURCE, url: 'https://evil.example' } },
    { ...manifest(), source: { ...SAMPLE_SURVEY_RESULTS_SOURCE, extra: 'private-secret' } },
    { ...manifest(), datasets: [descriptor(), descriptor()] },
    { ...manifest(), datasets: [descriptor(), { ...descriptor(), id: 'SURVEY-20', path: 'runs/SURVEY-20.json' }] },
    { ...manifest(), datasets: Array.from({ length: SAMPLE_SURVEY_RESULTS_MAX_DATASETS + 1 }, (_, index) => ({ ...descriptor(), id: `run-${index}`, path: `runs/run-${index}.json` })) },
    { ...manifest(), generatedAt: '2026-10-19T00:00:00.000Z' },
    { ...manifest(), generatedAt: '2026-10-21T00:00:00Z' },
    { ...manifest(), datasets: [{ ...descriptor(), captureEndedAt: '2026-10-19T00:00:00.000Z' }] },
  ]) assert.throws(() => parseSampleSurveyResultsManifest(bad))
})

test('bundled initial manifest is a valid uncollected publication', async () => {
  const value = JSON.parse(await readFile(new URL('../../public/data/sample-survey/index.json', import.meta.url), 'utf8'))
  assert.equal(parseSampleSurveyResultsManifest(value).datasets.length, 0)
})

test('history and the latest body load once; older bodies load only on explicit selection', async () => {
  const latest = run(), previous = run('19'), requests: { url: string; options?: RequestInit }[] = []
  const source = feed(async (input, options) => {
    const url = String(input); requests.push({ url, options })
    return json(url.endsWith('index.json') ? manifest([previous, latest]) : url.includes(previous.id) ? previous : latest)
  })
  const first = source.loadPublication(), concurrent = source.loadPublication()
  assert.equal(first, concurrent)
  const publication = await first
  assert.equal(publication.source, 'history'); assert.equal(requests.length, 2)
  assert.ok(requests[1].url.includes(`runs/${latest.id}.json`))
  assert.deepEqual(await source.loadDataset(publication, descriptor(latest)), latest)
  assert.equal(requests.length, 2)
  assert.deepEqual(await source.loadDataset(publication, descriptor(previous)), previous)
  assert.equal(requests.length, 3)
  assert.equal(requests[0].options?.cache, 'no-store')
  for (const request of requests) {
    assert.equal(request.options?.credentials, 'omit'); assert.equal(request.options?.redirect, 'error')
    assert.ok(request.url.startsWith(historyBaseUrl))
  }
  await assert.rejects(source.loadDataset(publication, { ...descriptor(latest), captureEndedAt: '2026-10-20T02:00:00.000Z' }))
  assert.equal(requests.length, 3)
})

test('invalid or unavailable latest history bodies fall back as one publication without mixing sources', async t => {
  for (const failure of ['network', 'http', 'invalid-json', 'private-field', 'unfinished', 'descriptor', 'publication-time']) await t.test(failure, async () => {
    const local = run('19'), requests: string[] = []
    const source = feed(async input => {
      const url = String(input); requests.push(url)
      if (url.startsWith(localBaseUrl)) return json(url.endsWith('index.json') ? manifest([local]) : local)
      if (url.endsWith('index.json')) return json(manifest())
      if (failure === 'network') throw new Error('private transport details')
      if (failure === 'http') return new Response('', { status: 503 })
      if (failure === 'invalid-json') return new Response('{')
      if (failure === 'private-field') return json({ ...run(), accountId: 'private-account' })
      if (failure === 'unfinished') return json({ ...run(), state: 'stopped', stopReason: 'cancelled', resumeAllowed: true })
      if (failure === 'descriptor') return json(run('18'))
      return json({ ...run(), updatedAt: '2026-10-22T00:00:00.000Z' })
    })
    const publication = await source.loadPublication()
    assert.equal(publication.source, 'bundled')
    assert.deepEqual(await source.loadDataset(publication, descriptor(local)), local)
    assert.equal(requests.length, 4)
    assert.ok(requests[3].startsWith(localBaseUrl))
  })
})

test('invalid manifest filenames are rejected before any outside or dataset request', async () => {
  const requests: string[] = []
  const source = feed(async input => {
    const url = String(input); requests.push(url)
    return json(url.startsWith(historyBaseUrl)
      ? { ...manifest(), datasets: [{ ...descriptor(), path: 'https://evil.example/private.json' }] } : manifest([]))
  })
  assert.equal((await source.loadPublication()).manifest.datasets.length, 0)
  assert.deepEqual(requests, [`${historyBaseUrl}index.json`, `${localBaseUrl}index.json`])
})

test('decoded body size, declared size and malformed UTF-8 are bounded before JSON acceptance', async t => {
  for (const failure of ['declared', 'actual', 'utf8']) await t.test(failure, async () => {
    let cancelled = false
    const source = feed(async input => {
      if (String(input).startsWith(localBaseUrl)) return json(manifest([]))
      if (failure === 'declared') return new Response('', { headers: { 'Content-Length': String(SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES + 1) } })
      if (failure === 'utf8') return new Response(new Uint8Array([0xff, 0xfe]))
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES / 2 + 1)) },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 }))
    })
    assert.equal((await source.loadPublication()).source, 'bundled')
    if (failure === 'actual') assert.equal(cancelled, true)
  })
})

test('stalled decoded bodies time out and cancel, then recover on a later refresh', async () => {
  let stalled = true, cancelled = false
  const source = feed(async input => {
    const url = String(input)
    if (url.startsWith(localBaseUrl)) return json(manifest([]))
    if (url.endsWith('index.json')) return json(manifest())
    return stalled ? new Response(new ReadableStream({ pull() { return new Promise<void>(() => {}) }, cancel() { cancelled = true } })) : json(run())
  }, 15)
  assert.equal((await source.loadPublication()).source, 'bundled')
  assert.equal(cancelled, true)
  stalled = false
  assert.equal((await source.loadPublication()).source, 'history')
})

test('existing published-data controller keeps displayed history when refresh can only read empty bundled data', async () => {
  let online = true
  const source = feed(async input => {
    const url = String(input)
    if (url.startsWith(localBaseUrl)) return json(manifest([]))
    if (!online) return new Response('', { status: 503 })
    return json(url.endsWith('index.json') ? manifest() : run())
  })
  const controller = createPublishedDataController(source, () => {})
  await controller.refresh()
  const previous = controller.getState().publication
  assert.equal(previous?.source, 'history')
  online = false; await controller.refresh()
  assert.equal(controller.getState().publication, previous)
  assert.equal(controller.getState().refreshError, true)
  online = true; await controller.refresh()
  assert.equal(controller.getState().refreshError, false)
  controller.dispose()
})

test('both unavailable sources fail distinctly from an empty valid publication', async () => {
  let available = false
  const source = feed(async () => available ? json(manifest([])) : new Response('', { status: 404 }))
  await assert.rejects(source.loadPublication(), /標本調査データを読み込めません/)
  available = true
  assert.equal((await source.loadPublication()).manifest.datasets.length, 0)
})
