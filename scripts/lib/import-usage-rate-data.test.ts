import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { UsageRateDataset } from '../../src/types/usageRates.ts'
import { USAGE_RATE_SOURCE } from '../../src/lib/usageRates.ts'
import { importUsageRateData } from '../import-usage-rate-data.ts'
import { validateUsageRateDirectory } from '../validate-usage-rate-data.ts'

const generatedAt = '2026-10-09T06:00:00Z'
function dataset(month = '2026-09', league = 'MASTER'): UsageRateDataset {
  return {
    schemaVersion: 1, id: `${month}-${league.toLowerCase()}`, month, league,
    capturedAt: '2026-10-09T05:00:00Z', generatedAt,
    source: { ...USAGE_RATE_SOURCE, population: 'ランクマッチ', metric: 'キャラクター使用率', unit: '%（集計単位未公表）', notes: [] },
    distributions: (['all', 'classic', 'modern'] as const).map((controlType) => ({
      controlType, month, league,
      entries: [
        { characterId: 'ryu', name: 'リュウ', text: '0.000', percentThousandths: 0 },
        { characterId: 'ken', name: 'ケン', text: '100.000', percentThousandths: 100000 },
      ],
    })),
  }
}

async function fixture(t: test.TestContext) {
  const parent = resolve('.cache', 'usage-import-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'case-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, input: join(root, 'input.json'), output: join(root, 'public') }
}

async function writeInput(path: string, datasets: UsageRateDataset[]) {
  await writeFile(path, JSON.stringify({ schemaVersion: 1, datasets }))
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async (name) => [name, await readFile(join(directory, name), 'utf8')])))
}

test('imports complete three-distribution datasets, preserving genuine zero and missing', async (t) => {
  const paths = await fixture(t)
  const value = dataset()
  value.distributions.forEach((distribution) => { distribution.entries[1] = { ...distribution.entries[1], text: '-', percentThousandths: null } })
  await writeInput(paths.input, [value])
  assert.deepEqual(await importUsageRateData(paths.input, paths.output, generatedAt), { datasets: 1, entries: 6 })
  assert.deepEqual(await validateUsageRateDirectory(paths.output), { datasets: 1, entries: 6 })
  const stored = JSON.parse(await readFile(join(paths.output, '2026-09-master.json'), 'utf8'))
  assert.equal(stored.distributions[0].entries[0].percentThousandths, 0)
  assert.equal(stored.distributions[0].entries[1].percentThousandths, null)
})

test('updates only matching month/league and retains other files byte for byte', async (t) => {
  const paths = await fixture(t)
  await writeInput(paths.input, [dataset('2026-08'), dataset(), dataset('2026-09', 'ALL')])
  await importUsageRateData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  const changed = dataset()
  changed.distributions[0].entries[0] = { ...changed.distributions[0].entries[0], text: '1.234', percentThousandths: 1234 }
  changed.distributions[0].entries[1] = { ...changed.distributions[0].entries[1], text: '98.766', percentThousandths: 98766 }
  await writeInput(paths.input, [changed])
  assert.deepEqual(await importUsageRateData(paths.input, paths.output, generatedAt), { datasets: 3, entries: 18 })
  const after = await snapshot(paths.output)
  assert.equal(after['2026-08-master.json'], before['2026-08-master.json'])
  assert.equal(after['2026-09-all.json'], before['2026-09-all.json'])
  assert.equal(JSON.parse(after['2026-09-master.json']).distributions[0].entries[0].percentThousandths, 1234)
})

test('rejects partial/inconsistent batches and duplicate conditions before replacing stored data', async (t) => {
  const paths = await fixture(t)
  await writeInput(paths.input, [dataset()])
  await importUsageRateData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  for (const values of [
    [{ ...dataset(), distributions: dataset().distributions.slice(0, 2) }],
    [dataset(), dataset()],
    [dataset('2026-08'), { ...dataset(), distributions: dataset().distributions.map((distribution, index) => ({ ...distribution, month: index === 2 ? '2026-08' : '2026-09' })) }],
  ]) {
    await writeInput(paths.input, values)
    await assert.rejects(importUsageRateData(paths.input, paths.output, generatedAt))
    assert.deepEqual(await snapshot(paths.output), before)
  }
  assert.deepEqual((await readdir(paths.root)).sort(), ['input.json', 'public'])
})

test('rejects a conflicting ID in another condition without altering stored data', async (t) => {
  const paths = await fixture(t)
  await writeInput(paths.input, [dataset()])
  await importUsageRateData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  await writeInput(paths.input, [{ ...dataset('2026-08'), id: dataset().id }])
  await assert.rejects(importUsageRateData(paths.input, paths.output, generatedAt), /duplicate/)
  assert.deepEqual(await snapshot(paths.output), before)
  assert.deepEqual((await readdir(paths.root)).sort(), ['input.json', 'public'])
})

test('accepts a directory of standalone dataset JSON and refuses unregistered stored JSON', async (t) => {
  const paths = await fixture(t)
  const inputRoot = join(paths.root, 'datasets')
  await mkdir(inputRoot)
  await writeFile(join(inputRoot, 'master.json'), JSON.stringify(dataset()))
  await writeFile(join(inputRoot, 'all.json'), JSON.stringify(dataset('2026-09', 'ALL')))
  await importUsageRateData(inputRoot, paths.output, generatedAt)
  await writeFile(join(paths.output, 'unknown.json'), '{}')
  await assert.rejects(validateUsageRateDirectory(paths.output), /一覧に登録されていない/)
  const before = await snapshot(paths.output)
  await assert.rejects(importUsageRateData(inputRoot, paths.output, generatedAt), /一覧に登録されていない/)
  assert.deepEqual(await snapshot(paths.output), before)
})
