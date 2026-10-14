import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { RankDistributionDataset } from '../../src/types/rankDistribution.ts'
import { RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_SOURCE, RANK_DISTRIBUTION_VALIDATION_CHECKS } from '../../src/lib/rankDistribution.ts'
import { importRankDistributionData } from '../import-rank-distribution-data.ts'
import { rankDistributionPathWithin, validateRankDistributionDirectory } from '../validate-rank-distribution-data.ts'

const generatedAt = '2026-10-13T09:00:00Z'
function dataset(day = '13'): RankDistributionDataset {
  return {
    schemaVersion: 1, id: `2026-10-${day}-max-lp`,
    captureStartedAt: `2026-10-${day}T07:00:00Z`, captureEndedAt: `2026-10-${day}T08:00:00Z`, generatedAt,
    source: { ...RANK_DISTRIBUTION_SOURCE, population: '最大LP条件の掲載アカウント', metric: 'LPランク分布', unit: 'fighter-account', notes: ['人工テスト。実人口ではない。'] },
    conditions: { ...RANK_DISTRIBUTION_CONDITIONS }, method: 'boundary-search', totalCount: 36,
    entries: Array.from({ length: 36 }, (_, index) => ({ rankId: index + 1, count: 1 })),
    validation: { status: 'verified', coverage: 'all-listed-accounts', checks: [...RANK_DISTRIBUTION_VALIDATION_CHECKS], notes: ['人工テストの全条件を検証。'] },
  }
}

async function fixture(t: test.TestContext) {
  const parent = resolve('.cache', 'rank-import-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'case-'))
  t.after(async () => { if (rankDistributionPathWithin(parent, root)) await rm(root, { recursive: true, force: true }) })
  return { root, input: join(root, 'input.json'), output: join(root, 'public') }
}

async function writeInput(path: string, values: unknown[]) {
  await writeFile(path, JSON.stringify({ schemaVersion: 1, datasets: values }))
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async (name) => [name, await readFile(join(directory, name), 'utf8')])))
}

test('imports only verified complete distributions and preserves genuine zeros', async (t) => {
  const paths = await fixture(t)
  const value = dataset()
  value.entries[0].count = 0
  value.entries[35].count = 2
  await writeInput(paths.input, [value])
  assert.deepEqual(await importRankDistributionData(paths.input, paths.output, generatedAt), { datasets: 1, entries: 36 })
  assert.deepEqual(await validateRankDistributionDirectory(paths.output), { datasets: 1, entries: 36 })
  const stored = JSON.parse(await readFile(join(paths.output, `${value.id}.json`), 'utf8'))
  assert.equal(stored.entries[0].count, 0)
  assert.equal(stored.entries[35].count, 2)
})

test('supports an empty failed-collection manifest without inventing a zero snapshot', async (t) => {
  const paths = await fixture(t)
  await mkdir(paths.output)
  await writeFile(join(paths.output, 'index.json'), JSON.stringify({
    schemaVersion: 1, generatedAt, source: RANK_DISTRIBUTION_SOURCE, datasets: [],
    availability: { status: 'collection-failed', message: 'メンテナンスで取得できない。', checkedAt: generatedAt },
  }))
  assert.deepEqual(await validateRankDistributionDirectory(paths.output), { datasets: 0, entries: 0 })
  const before = await snapshot(paths.output)
  await writeInput(paths.input, [])
  await assert.rejects(importRankDistributionData(paths.input, paths.output, generatedAt), /未取得を0件/)
  assert.deepEqual(await snapshot(paths.output), before)
  await writeInput(paths.input, [dataset()])
  await importRankDistributionData(paths.input, paths.output, generatedAt)
  assert.equal(JSON.parse(await readFile(join(paths.output, 'index.json'), 'utf8')).availability, undefined)
})

test('replaces a matching capture interval while retaining other snapshots byte for byte', async (t) => {
  const paths = await fixture(t)
  await writeInput(paths.input, [dataset('12'), dataset()])
  await importRankDistributionData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  const changed = dataset()
  changed.id = 'corrected-capture'
  changed.entries[0].count = 0
  changed.entries[35].count = 2
  await writeInput(paths.input, [changed])
  assert.deepEqual(await importRankDistributionData(paths.input, paths.output, generatedAt), { datasets: 2, entries: 72 })
  const after = await snapshot(paths.output)
  assert.equal(after[`${dataset('12').id}.json`], before[`${dataset('12').id}.json`])
  assert.equal(after[`${dataset().id}.json`], undefined)
  assert.equal(JSON.parse(after['corrected-capture.json']).entries[0].count, 0)
})

test('rejects partial, unverified, miscounted, unsafe, private, or duplicate batches without changing previous data', async (t) => {
  const paths = await fixture(t)
  await writeInput(paths.input, [dataset()])
  await importRankDistributionData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  const invalid = [
    { ...dataset(), entries: dataset().entries.slice(1) },
    { ...dataset(), totalCount: 37 },
    { ...dataset(), validation: { ...dataset().validation, status: 'unverified' } },
    { ...dataset(), validation: { ...dataset().validation, checks: RANK_DISTRIBUTION_VALIDATION_CHECKS.slice(1) } },
    { ...dataset(), id: '../escape' },
    { ...dataset(), id: 'CON' },
    { ...dataset(), userCode: 'private-test-id' },
    { ...dataset(), entries: dataset().entries.map((entry, index) => ({ ...entry, ...(index === 0 ? { player: 'private' } : {}) })) },
  ]
  for (const value of invalid) {
    await writeInput(paths.input, [dataset('12'), value])
    await assert.rejects(importRankDistributionData(paths.input, paths.output, generatedAt))
    assert.deepEqual(await snapshot(paths.output), before)
  }
  await writeInput(paths.input, [dataset(), dataset()])
  await assert.rejects(importRankDistributionData(paths.input, paths.output, generatedAt), /duplicate/)
  assert.deepEqual(await snapshot(paths.output), before)
  assert.deepEqual((await readdir(paths.root)).sort(), ['input.json', 'public'])
})

test('rejects conflicting IDs from another capture and checks existing files before staging', async (t) => {
  const paths = await fixture(t)
  await writeInput(paths.input, [dataset()])
  await importRankDistributionData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  await writeInput(paths.input, [{ ...dataset('12'), id: dataset().id }])
  await assert.rejects(importRankDistributionData(paths.input, paths.output, generatedAt), /duplicate/)
  assert.deepEqual(await snapshot(paths.output), before)
  await writeFile(join(paths.output, 'unregistered.json'), '{}')
  const extraBefore = await snapshot(paths.output)
  await assert.rejects(validateRankDistributionDirectory(paths.output), /一覧に登録されていない/)
  await writeInput(paths.input, [dataset()])
  await assert.rejects(importRankDistributionData(paths.input, paths.output, generatedAt), /一覧に登録されていない/)
  assert.deepEqual(await snapshot(paths.output), extraBefore)
})

test('accepts a directory of standalone captures and rejects generation times before its inputs', async (t) => {
  const paths = await fixture(t)
  const inputRoot = join(paths.root, 'captures')
  await mkdir(inputRoot)
  await writeFile(join(inputRoot, 'a.json'), JSON.stringify(dataset('12')))
  await writeFile(join(inputRoot, 'b.json'), JSON.stringify(dataset()))
  assert.deepEqual(await importRankDistributionData(inputRoot, paths.output, generatedAt), { datasets: 2, entries: 72 })
  const before = await snapshot(paths.output)
  await assert.rejects(importRankDistributionData(inputRoot, paths.output, '2026-10-13T08:30:00Z'), /生成日時/)
  assert.deepEqual(await snapshot(paths.output), before)
  assert.ok(!rankDistributionPathWithin(paths.output, join(paths.output, '..', 'outside.json')))
  assert.ok(!rankDistributionPathWithin(paths.output, paths.output))
})
