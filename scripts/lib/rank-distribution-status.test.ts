import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_SOURCE, RANK_DISTRIBUTION_VALIDATION_CHECKS } from '../../src/lib/rankDistribution.ts'
import type { RankDistributionDataset, RankDistributionManifest } from '../../src/types/rankDistribution.ts'
import { rankDistributionPathWithin, validateRankDistributionDirectory } from '../validate-rank-distribution-data.ts'
import { recordRankDistributionAvailability } from './rank-distribution-status.ts'
import type { RankDistributionAvailabilityReason, RecordRankDistributionAvailabilityOptions } from './rank-distribution-status.ts'

const previousAt = '2026-10-15T07:00:00Z'
const checkedAt = '2026-10-15T08:00:00Z'

async function fixture(t: test.TestContext, withDataset = true) {
  const parent = resolve('.cache', 'rank-status-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'sf6-rank-status-tests-'))
  t.after(async () => {
    if (rankDistributionPathWithin(parent, root) && basename(root).startsWith('sf6-rank-status-tests-')) await rm(root, { recursive: true, force: true })
  })
  const directory = join(root, 'rank-distribution')
  await mkdir(directory)
  const dataset: RankDistributionDataset = {
    schemaVersion: 1, id: 'synthetic-capture', captureStartedAt: previousAt, captureEndedAt: previousAt, generatedAt: previousAt,
    source: { ...RANK_DISTRIBUTION_SOURCE, population: '人工テスト', metric: '人工テスト', unit: 'fighter-account', notes: [] },
    conditions: { ...RANK_DISTRIBUTION_CONDITIONS }, method: 'boundary-search', totalCount: 36,
    entries: Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, count: 1 })),
    validation: { status: 'verified', coverage: 'all-listed-accounts', checks: [...RANK_DISTRIBUTION_VALIDATION_CHECKS], notes: ['人工テスト。実人口ではない。'] },
  }
  const manifest: RankDistributionManifest = {
    schemaVersion: 1, generatedAt: previousAt, source: { ...RANK_DISTRIBUTION_SOURCE },
    datasets: withDataset ? [{ id: dataset.id, path: `${dataset.id}.json`, captureStartedAt: previousAt, captureEndedAt: previousAt, totalCount: dataset.totalCount }] : [],
  }
  await writeFile(join(directory, 'index.json'), JSON.stringify(manifest))
  if (withDataset) await writeFile(join(directory, `${dataset.id}.json`), JSON.stringify(dataset))
  return { root, directory, manifest, dataset }
}

async function snapshot(directory: string) {
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name), 'utf8')])) )
}

test('records fixed failure text while retaining verified history and source', async t => {
  const paths = await fixture(t)
  const before = await snapshot(paths.directory)
  const result = await recordRankDistributionAvailability({ status: 'collection-failed', reason: 'observation-changed', checkedAt, directory: paths.directory })
  assert.deepEqual(result.datasets, paths.manifest.datasets)
  assert.deepEqual(result.source, paths.manifest.source)
  assert.equal(result.generatedAt, checkedAt)
  assert.deepEqual(result.availability, { status: 'collection-failed', checkedAt, message: '取得中に総件数または確認したページ内容が変化したため、ランク分布を更新していません。' })
  assert.equal((await snapshot(paths.directory))[`${paths.dataset.id}.json`], before[`${paths.dataset.id}.json`])
  assert.deepEqual(await validateRankDistributionDirectory(paths.directory), { datasets: 1, entries: 36 })
  assert.deepEqual(await readdir(paths.root), ['rank-distribution'])
})

test('a pending capture with no previous data stays empty, rather than inventing zero counts', async t => {
  const paths = await fixture(t, false)
  const result = await recordRankDistributionAvailability({ status: 'verification-pending', reason: 'evidence-unconfirmed', checkedAt, directory: paths.directory })
  assert.deepEqual(result.datasets, [])
  assert.equal(result.availability?.status, 'verification-pending')
  assert.deepEqual(await validateRankDistributionDirectory(paths.directory), { datasets: 0, entries: 0 })
  assert.deepEqual(await readdir(paths.directory), ['index.json'])
})

test('each supported reason produces fixed public text', async t => {
  const paths = await fixture(t, false)
  const reasons: RankDistributionAvailabilityReason[] = ['source-changed', 'unknown-rank', 'evidence-unconfirmed', 'authentication-required', 'authentication-unconfirmed', 'access-denied', 'maintenance', 'read-failed', 'publication-failed', 'configuration-invalid', 'checkpoint-unavailable', 'cancelled', 'request-limit', 'observation-changed']
  const messages = new Set<string>()
  for (const reason of reasons) {
    const result = await recordRankDistributionAvailability({ status: 'collection-failed', reason, checkedAt, directory: paths.directory })
    assert.equal(result.availability?.checkedAt, checkedAt)
    assert.ok(result.availability?.message)
    messages.add(result.availability!.message)
  }
  assert.equal(messages.size, reasons.length)
})

test('rejects unknown reasons, arbitrary text, unsupported status, and invalid or stale dates without mutation', async t => {
  const paths = await fixture(t)
  const before = await snapshot(paths.directory)
  const base = { status: 'collection-failed', reason: 'read-failed', checkedAt, directory: paths.directory }
  const invalid = [
    { ...base, reason: 'player-supplied-error' }, { ...base, reason: '__proto__' }, { ...base, message: 'private raw text' },
    { ...base, error: new Error('private error') }, { ...base, status: 'not-collected' }, { ...base, status: 'verified' },
    { ...base, checkedAt: '2026-02-30T08:00:00Z' }, { ...base, checkedAt: '2026-10-15' },
    { ...base, checkedAt: '2026-10-15T06:59:59Z' }, { ...base, directory: '' },
  ]
  for (const options of invalid) {
    await assert.rejects(recordRankDistributionAvailability(options as RecordRankDistributionAvailabilityOptions))
    assert.deepEqual(await snapshot(paths.directory), before)
    assert.deepEqual(await readdir(paths.root), ['rank-distribution'])
  }
})

test('shares the importer lock and never removes an existing lock', async t => {
  const paths = await fixture(t)
  const before = await snapshot(paths.directory)
  const lock = join(paths.root, '.rank-distribution-import.lock')
  await writeFile(lock, 'another importer')
  await assert.rejects(recordRankDistributionAvailability({ status: 'collection-failed', reason: 'read-failed', checkedAt, directory: paths.directory }), /ロック/)
  assert.equal(await readFile(lock, 'utf8'), 'another importer')
  assert.deepEqual(await snapshot(paths.directory), before)
})

test('rejects an invalid previous manifest or snapshot without changing it', async t => {
  const paths = await fixture(t)
  const index = join(paths.directory, 'index.json')
  await writeFile(index, JSON.stringify({ ...paths.manifest, privateIdentity: 'test' }))
  let before = await snapshot(paths.directory)
  await assert.rejects(recordRankDistributionAvailability({ status: 'collection-failed', reason: 'read-failed', checkedAt, directory: paths.directory }))
  assert.deepEqual(await snapshot(paths.directory), before)
  await writeFile(index, JSON.stringify(paths.manifest))
  await writeFile(join(paths.directory, `${paths.dataset.id}.json`), '{}')
  before = await snapshot(paths.directory)
  await assert.rejects(recordRankDistributionAvailability({ status: 'collection-failed', reason: 'read-failed', checkedAt, directory: paths.directory }))
  assert.deepEqual(await snapshot(paths.directory), before)
  assert.deepEqual(await readdir(paths.root), ['rank-distribution'])
})

test('rejects directory junctions, file links, and linked ancestors', async t => {
  const paths = await fixture(t)
  const before = await snapshot(paths.directory)
  const linked = join(paths.root, 'linked')
  await symlink(paths.directory, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(recordRankDistributionAvailability({ status: 'collection-failed', reason: 'read-failed', checkedAt, directory: linked }), /リンク/)
  const ancestor = join(paths.root, 'ancestor')
  await mkdir(ancestor)
  const ancestorLink = join(paths.root, 'linked-ancestor')
  await symlink(paths.root, ancestorLink, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(recordRankDistributionAvailability({ status: 'collection-failed', reason: 'read-failed', checkedAt, directory: join(ancestorLink, 'rank-distribution') }), /リンク/)
  // A directory at index.json is also refused without replacing it or touching its target.
  const index = join(paths.directory, 'index.json')
  await unlink(index)
  await symlink(ancestor, index, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(recordRankDistributionAvailability({ status: 'collection-failed', reason: 'read-failed', checkedAt, directory: paths.directory }), /リンク/)
  await unlink(index)
  await writeFile(index, before['index.json'])
  assert.deepEqual(await snapshot(paths.directory), before)
})
