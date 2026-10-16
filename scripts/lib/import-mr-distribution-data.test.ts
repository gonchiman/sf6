import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { MrDistributionDataset } from '../../src/types/mrDistribution.ts'
import { MR_DISTRIBUTION_CHECKS, MR_DISTRIBUTION_CONDITIONS, MR_DISTRIBUTION_SOURCE,
  MR_DISTRIBUTION_THRESHOLDS, parseMrDistributionDataset } from '../../src/lib/mrDistribution.ts'
import { importMrDistributionData } from '../import-mr-distribution-data.ts'
import { mrDistributionPathWithin, validateMrDistributionDirectory } from '../validate-mr-distribution-data.ts'

const generatedAt = '2026-10-16T13:20:00Z'
function dataset(day = '16', counts: number[] = Array(26).fill(1)): MrDistributionDataset {
  const entries = counts.map((count, index) => ({ minimum: index * 100, maximum: index === 25 ? null : (index + 1) * 100, count }))
  const totalCount = counts.reduce((sum, count) => sum + count, 0)
  return {
    schemaVersion: 1, id: `max-mr-estimate-2026-10-${day}`, captureStartedAt: `2026-10-${day}T13:00:00Z`,
    captureEndedAt: `2026-10-${day}T13:10:00Z`, generatedAt,
    source: { ...MR_DISTRIBUTION_SOURCE, population: '今Act・最大MR掲載条件', metric: 'MR区間の概数', unit: 'fighter-account', notes: ['人工テスト。実人口ではない。'] },
    conditions: { ...MR_DISTRIBUTION_CONDITIONS }, method: 'boundary-search-estimate', binWidth: 100, totalCount, entries,
    observation: { totalAtStart: totalCount, totalAtEnd: totalCount, minTotal: totalCount, maxTotal: totalCount,
      boundaries: MR_DISTRIBUTION_THRESHOLDS.map(minimumMr => ({ minimumMr,
        countAtOrAbove: entries.filter(bin => bin.minimum >= minimumMr).reduce((sum, bin) => sum + bin.count, 0),
        totalCount, observedAt: `2026-10-${day}T13:05:00Z` })) },
    validation: { status: 'estimated', coverage: 'all-mr-boundaries', checks: [...MR_DISTRIBUTION_CHECKS], notes: ['人工テストの全区間。'] },
  }
}

async function fixture(t: test.TestContext) {
  const parent = resolve('.cache', 'mr-import-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'case-'))
  t.after(async () => { if (mrDistributionPathWithin(parent, root)) await rm(root, { recursive: true, force: true }) })
  return { root, input: join(root, 'input.json'), output: join(root, 'public') }
}

async function writeInput(path: string, values: unknown[]) {
  await writeFile(path, JSON.stringify({ schemaVersion: 1, datasets: values }))
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name), 'utf8')])))
}

test('imports complete estimated MR bins with observations and preserves genuine zeros', async t => {
  const paths = await fixture(t)
  const value = dataset('16', Array.from({ length: 26 }, (_, index) => index === 15 ? 26 : 0))
  await writeInput(paths.input, [value])
  assert.deepEqual(await importMrDistributionData(paths.input, paths.output, generatedAt), { datasets: 1, entries: 26 })
  assert.deepEqual(await validateMrDistributionDirectory(paths.output), { datasets: 1, entries: 26 })
  const stored = parseMrDistributionDataset(JSON.parse(await readFile(join(paths.output, `${value.id}.json`), 'utf8')))
  assert.equal(stored.entries[0].count, 0)
  assert.equal(stored.entries[15].count, 26)
  assert.deepEqual(stored.observation, value.observation)
})

test('uncollected and failed manifests do not become fabricated zero snapshots', async t => {
  const paths = await fixture(t)
  await mkdir(paths.output)
  await writeFile(join(paths.output, 'index.json'), JSON.stringify({ schemaVersion: 1, generatedAt, source: MR_DISTRIBUTION_SOURCE,
    datasets: [], availability: { status: 'collection-failed', message: '取得失敗', checkedAt: generatedAt } }))
  assert.deepEqual(await validateMrDistributionDirectory(paths.output), { datasets: 0, entries: 0 })
  const before = await snapshot(paths.output)
  await writeInput(paths.input, [])
  await assert.rejects(importMrDistributionData(paths.input, paths.output, generatedAt), /未取得を0件/)
  assert.deepEqual(await snapshot(paths.output), before)
  await writeInput(paths.input, [dataset('16', Array(26).fill(0))])
  await importMrDistributionData(paths.input, paths.output, generatedAt)
  assert.equal(JSON.parse(await readFile(join(paths.output, 'index.json'), 'utf8')).availability, undefined)
  assert.equal(JSON.parse(await readFile(join(paths.output, `${dataset().id}.json`), 'utf8')).totalCount, 0)
})

test('retains history byte for byte and replaces only a matching capture interval', async t => {
  const paths = await fixture(t)
  await writeInput(paths.input, [dataset('15'), dataset()])
  await importMrDistributionData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  const changed = dataset('16', [0, 2, ...Array(24).fill(1)])
  changed.id = 'corrected-mr-capture'
  await writeInput(paths.input, [changed])
  assert.deepEqual(await importMrDistributionData(paths.input, paths.output, generatedAt), { datasets: 2, entries: 52 })
  const after = await snapshot(paths.output)
  assert.equal(after[`${dataset('15').id}.json`], before[`${dataset('15').id}.json`])
  assert.equal(after[`${dataset().id}.json`], undefined)
  assert.equal(JSON.parse(after['corrected-mr-capture.json']).entries[0].count, 0)
})

test('invalid or private batches leave every previous public file unchanged', async t => {
  const paths = await fixture(t)
  await writeInput(paths.input, [dataset()])
  await importMrDistributionData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  const value = dataset()
  for (const invalid of [
    { ...value, entries: value.entries.slice(1) },
    { ...value, totalCount: 27 },
    { ...value, validation: { ...value.validation, coverage: 'single-interval' } },
    { ...value, observation: { ...value.observation, boundaries: value.observation.boundaries.slice(1) } },
    { ...value, id: '../escape' }, { ...value, id: 'CON' },
    { ...value, userCode: 'private' },
    { ...value, entries: value.entries.map(bin => ({ ...bin, playerName: 'private' })) },
  ]) {
    await writeInput(paths.input, [dataset('15'), invalid])
    await assert.rejects(importMrDistributionData(paths.input, paths.output, generatedAt))
    assert.deepEqual(await snapshot(paths.output), before)
  }
  await writeInput(paths.input, [value, value])
  await assert.rejects(importMrDistributionData(paths.input, paths.output, generatedAt), /duplicate/)
  assert.deepEqual(await snapshot(paths.output), before)
  assert.deepEqual((await readdir(paths.root)).sort(), ['input.json', 'public'])
})

test('rejects conflicting capture IDs, unregistered public files and earlier publication dates', async t => {
  const paths = await fixture(t)
  await writeInput(paths.input, [dataset()])
  await importMrDistributionData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  await writeInput(paths.input, [{ ...dataset('15'), id: dataset().id }])
  await assert.rejects(importMrDistributionData(paths.input, paths.output, generatedAt), /duplicate/)
  assert.deepEqual(await snapshot(paths.output), before)
  await writeInput(paths.input, [dataset()])
  await assert.rejects(importMrDistributionData(paths.input, paths.output, '2026-10-16T13:15:00Z'), /生成日時/)
  assert.deepEqual(await snapshot(paths.output), before)
  await writeFile(join(paths.output, 'unregistered.json'), '{}')
  const withExtra = await snapshot(paths.output)
  await assert.rejects(validateMrDistributionDirectory(paths.output), /一覧に登録されていない/)
  await assert.rejects(importMrDistributionData(paths.input, paths.output, generatedAt), /一覧に登録されていない/)
  assert.deepEqual(await snapshot(paths.output), withExtra)
})

test('accepts standalone capture directories and rejects path escapes and LP sources', async t => {
  const paths = await fixture(t)
  const inputRoot = join(paths.root, 'captures')
  await mkdir(inputRoot)
  await writeFile(join(inputRoot, 'a.json'), JSON.stringify(dataset('15')))
  await writeFile(join(inputRoot, 'b.json'), JSON.stringify(dataset()))
  assert.deepEqual(await importMrDistributionData(inputRoot, paths.output, generatedAt), { datasets: 2, entries: 52 })
  assert.ok(!mrDistributionPathWithin(paths.output, join(paths.output, '..', 'outside.json')))
  assert.ok(!mrDistributionPathWithin(paths.output, paths.output))
  const before = await snapshot(paths.output)
  await writeInput(paths.input, [{ ...dataset(), source: { ...dataset().source,
    url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league' } }])
  await assert.rejects(importMrDistributionData(paths.input, paths.output, generatedAt), /source.url/)
  assert.deepEqual(await snapshot(paths.output), before)
})
