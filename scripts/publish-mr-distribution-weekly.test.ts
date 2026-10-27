import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMrDistributionDataset, parseMrDistributionManifest } from '../src/lib/mrDistribution.ts'
import { main, publishMrWeekly } from './publish-mr-distribution-weekly.ts'

const seedDirectory = fileURLToPath(new URL('../public/data/mr-distribution', import.meta.url))
const seedManifest = parseMrDistributionManifest(JSON.parse(await readFile(resolve(seedDirectory, 'index.json'), 'utf8')))
const original = parseMrDistributionDataset(JSON.parse(await readFile(resolve(seedDirectory, seedManifest.datasets[0].path), 'utf8')))
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'gonchiman/sf6',
  GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/mr-distribution-weekly.yml@refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' }
const now = () => new Date('2026-11-02T00:00:00.000Z')
async function writeJson(path: string, value: unknown) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`) }

function fixture(day = '27', success = true, runId = '42') {
  const startedAt = `2026-10-${day}T10:00:00.000Z`
  const endedAt = `2026-10-${day}T10:20:00.000Z`
  const captureStartedAt = `2026-10-${day}T10:01:00.000Z`
  const captureEndedAt = `2026-10-${day}T10:19:00.000Z`
  const dataset = parseMrDistributionDataset({ ...structuredClone(original),
    id: `max-mr-estimate-2026-10-${day}T10-01-00-000Z`, captureStartedAt, captureEndedAt, generatedAt: captureEndedAt,
    observation: { ...structuredClone(original.observation), boundaries: original.observation.boundaries.map(item => ({ ...item, observedAt: captureStartedAt })) },
  })
  const capture = { schemaVersion: 1, status: success ? 'succeeded' : 'failed', startedAt, endedAt,
    stage: success ? 'complete' : 'collection', reason: success ? null : 'collection-failed', readFailureCode: success ? null : 'human-verification',
    requestCount: success ? 106 : 10, successfulReadCount: success ? 106 : 9, retryCount: 0,
    confirmedBoundaryCount: success ? 25 : 3, datasetSaved: success, imported: false, browserClosed: true,
    initialSignInConfirmed: true, readableWithoutSignInReadCount: 0 }
  const run = { schemaVersion: 1, id: `run-${runId}-1`, startedAt, endedAt, event: 'manual', status: success ? 'succeeded' : 'failed',
    failureReason: success ? null : 'collection-failed', datasetId: success ? dataset.id : null, capture }
  const manifest = { schemaVersion: 1, generatedAt: endedAt, source: seedManifest.source,
    datasets: success ? [{ id: dataset.id, path: `${dataset.id}.json`, captureStartedAt, captureEndedAt, totalCount: dataset.totalCount }] : [],
    ...(!success ? { availability: { status: 'collection-failed', message: '取得失敗', checkedAt: endedAt } } : {}),
  }
  return { dataset, run, manifest, success }
}
async function incoming(path: string, value: ReturnType<typeof fixture>) {
  await mkdir(resolve(path, 'public'), { recursive: true })
  await mkdir(resolve(path, 'runs'), { recursive: true })
  await writeJson(resolve(path, 'public/index.json'), value.manifest)
  if (value.success) await writeJson(resolve(path, 'public', `${value.dataset.id}.json`), value.dataset)
  await writeJson(resolve(path, 'runs', `${value.run.id}.json`), value.run)
}
async function setup(t: test.TestContext, value = fixture()) {
  const root = await mkdtemp(resolve(tmpdir(), 'sf6-mr-publish-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inputDirectory = resolve(root, 'incoming'), historyDirectory = resolve(root, 'history')
  await incoming(inputDirectory, value)
  await mkdir(resolve(historyDirectory, '.git'), { recursive: true })
  await writeFile(resolve(historyDirectory, '.git/keep'), 'git metadata is untouched')
  return { root, inputDirectory, historyDirectory, options: { inputDirectory, historyDirectory, seedDirectory, now }, value }
}
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function visit(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`
      if (entry.isDirectory()) await visit(resolve(path, entry.name), `${key}/`)
      else result[key] = await readFile(resolve(path, entry.name), 'utf8')
    }
  }
  await visit(root, '')
  return result
}

test('first MR publication seeds the bundled capture and preserves the Git checkout', async t => {
  const f = await setup(t)
  assert.deepEqual(await publishMrWeekly(f.options), { datasets: 2, entries: 52, runs: 1 })
  const manifest = parseMrDistributionManifest(JSON.parse(await readFile(resolve(f.historyDirectory, 'public/index.json'), 'utf8')))
  assert.deepEqual(manifest.datasets.map(item => item.id), [f.value.dataset.id, original.id])
  assert.equal(await readFile(resolve(f.historyDirectory, '.git/keep'), 'utf8'), 'git metadata is untouched')
  assert.deepEqual(JSON.parse(await readFile(resolve(f.historyDirectory, 'public', `${original.id}.json`), 'utf8')), original)
})

test('new MR captures append to immutable history and an identical rerun makes no changes', async t => {
  const f = await setup(t)
  await publishMrWeekly(f.options)
  const beforeRetry = await tree(f.historyDirectory)
  await publishMrWeekly(f.options)
  assert.deepEqual(await tree(f.historyDirectory), beforeRetry)
  const secondInput = resolve(f.root, 'incoming-second')
  await incoming(secondInput, fixture('28', true, '43'))
  assert.deepEqual(await publishMrWeekly({ ...f.options, inputDirectory: secondInput }), { datasets: 3, entries: 78, runs: 2 })
  const after = await tree(f.historyDirectory)
  for (const [name, content] of Object.entries(beforeRetry)) if (name !== 'public/index.json') assert.equal(after[name], content)
})

test('a failed collection retains complete captures and records failure without exposing arbitrary input text', async t => {
  const f = await setup(t)
  await publishMrWeekly(f.options)
  const before = await tree(f.historyDirectory)
  const failureInput = resolve(f.root, 'incoming-failure')
  const failed = fixture('28', false, '43')
  failed.manifest.availability!.message = 'untrusted private exception details'
  await incoming(failureInput, failed)
  assert.deepEqual(await publishMrWeekly({ ...f.options, inputDirectory: failureInput }), { datasets: 2, entries: 52, runs: 2 })
  const after = await tree(f.historyDirectory)
  for (const [name, content] of Object.entries(before)) if (name !== 'public/index.json') assert.equal(after[name], content)
  const manifest = JSON.parse(after['public/index.json'])
  assert.equal(manifest.availability.status, 'collection-failed')
  assert.equal(manifest.availability.checkedAt, failed.run.endedAt)
  assert.doesNotMatch(after['public/index.json'], /untrusted private/)
  const recoveredInput = resolve(f.root, 'incoming-recovered')
  await incoming(recoveredInput, fixture('29', true, '44'))
  await publishMrWeekly({ ...f.options, inputDirectory: recoveredInput })
  const recovered = JSON.parse(await readFile(resolve(f.historyDirectory, 'public/index.json'), 'utf8'))
  assert.equal(recovered.availability, undefined)
})

test('first failed attempt publishes the bundled history rather than zeroing the distribution', async t => {
  const f = await setup(t, fixture('27', false))
  assert.deepEqual(await publishMrWeekly(f.options), { datasets: 1, entries: 26, runs: 1 })
  const manifest = JSON.parse(await readFile(resolve(f.historyDirectory, 'public/index.json'), 'utf8'))
  assert.equal(manifest.datasets[0].id, original.id)
  assert.equal(manifest.availability.status, 'collection-failed')
})

for (const [name, alter] of [
  ['extra authentication field in run', async (f: Awaited<ReturnType<typeof setup>>) => {
    await writeJson(resolve(f.inputDirectory, 'runs', `${f.value.run.id}.json`), { ...f.value.run, cookies: ['secret'] })
  }],
  ['descriptor and body mismatch', async (f: Awaited<ReturnType<typeof setup>>) => {
    f.value.manifest.datasets[0].totalCount++
    await writeJson(resolve(f.inputDirectory, 'public/index.json'), f.value.manifest)
  }],
  ['unlisted aggregate file', async (f: Awaited<ReturnType<typeof setup>>) => {
    await writeJson(resolve(f.inputDirectory, 'public/secret.json'), { secret: 'value' })
  }],
  ['unapproved incoming root folder', async (f: Awaited<ReturnType<typeof setup>>) => {
    await mkdir(resolve(f.inputDirectory, 'private'))
  }],
  ['dataset not linked to run', async (f: Awaited<ReturnType<typeof setup>>) => {
    await writeJson(resolve(f.inputDirectory, 'runs', `${f.value.run.id}.json`), { ...f.value.run, datasetId: original.id })
  }],
] as const) test(`invalid ${name} leaves existing history unchanged`, async t => {
  const f = await setup(t)
  await publishMrWeekly(f.options)
  const before = await tree(f.historyDirectory)
  await alter(f)
  await assert.rejects(publishMrWeekly(f.options))
  assert.deepEqual(await tree(f.historyDirectory), before)
})

test('existing captures and run records cannot be rewritten', async t => {
  const f = await setup(t)
  await publishMrWeekly(f.options)
  const before = await tree(f.historyDirectory)
  const altered = structuredClone(f.value.dataset)
  altered.validation.notes.push('changed aggregate under existing id')
  await writeJson(resolve(f.inputDirectory, 'public', `${altered.id}.json`), altered)
  await assert.rejects(publishMrWeekly(f.options))
  assert.deepEqual(await tree(f.historyDirectory), before)
  await writeJson(resolve(f.inputDirectory, 'public', `${altered.id}.json`), f.value.dataset)
  await writeJson(resolve(f.inputDirectory, 'runs', `${f.value.run.id}.json`), { ...f.value.run, event: 'schedule' })
  await assert.rejects(publishMrWeekly(f.options))
  assert.deepEqual(await tree(f.historyDirectory), before)
})

test('junction input and unknown history content are rejected before replacing normal data', async t => {
  const f = await setup(t)
  await publishMrWeekly(f.options)
  const before = await tree(f.historyDirectory)
  const linked = resolve(f.root, 'linked-input')
  await symlink(f.inputDirectory, linked, 'junction')
  await assert.rejects(publishMrWeekly({ ...f.options, inputDirectory: linked }))
  assert.deepEqual(await tree(f.historyDirectory), before)
  await writeFile(resolve(f.historyDirectory, 'unknown.txt'), 'keep')
  const withUnknown = await tree(f.historyDirectory)
  await assert.rejects(publishMrWeekly(f.options))
  assert.deepEqual(await tree(f.historyDirectory), withUnknown)
})

test('publication rejects a run belonging to another workflow invocation', async t => {
  const f = await setup(t)
  await assert.rejects(publishMrWeekly({ ...f.options, expectedRunId: 'run-999-1' }))
  assert.deepEqual(await tree(f.historyDirectory), { '.git/keep': 'git metadata is untouched' })
})

test('publisher entry point requires fixed workflow and passes the current run identity', async () => {
  const calls: unknown[] = []
  await main([], { env, publish: async options => { calls.push(options); return { datasets: 1, entries: 26, runs: 1 } }, log: () => {} })
  assert.deepEqual(calls, [{ expectedRunId: 'run-42-1' }])
  await assert.rejects(main([], { env: { ...env, GITHUB_REF: 'refs/heads/untrusted' }, publish: async () => { throw new Error('must not run') } }))
  await assert.rejects(main(['input'], { env }))
})
