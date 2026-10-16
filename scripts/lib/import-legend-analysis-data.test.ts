import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS, parseLegendAnalysisDataset, summarizeLegendMr } from '../../src/lib/legendAnalysis.ts'
import { importLegendAnalysisData, publishLegendAnalysisData } from '../import-legend-analysis-data.ts'
import { validateLegendAnalysisDirectory } from '../validate-legend-analysis-data.ts'
import { legendAnalysisPathWithin } from './legend-analysis-files.ts'

const generatedAt = '2026-10-16T02:00:00.000Z'
function dataset(day = '15') {
  const captured = `2026-10-${day}T00:00:00.000Z`
  return parseLegendAnalysisDataset({ schemaVersion: 1, id: `legend-${day}`, captureStartedAt: captured, captureEndedAt: captured, generatedAt: captured,
    source: { ...LEGEND_ANALYSIS_SOURCE, population: '人工テストの掲載エントリー', metric: 'キャラ構成とMR分布', unit: 'account-character', notes: ['実データではない。'] },
    act: { id: 'act-13', label: 'Act 13' }, definitionVersion: 'legend-listed-v1', membershipRule: 'official-legend-badge',
    conditions: { region: 'all', platform: 'all', characters: 'all', users: 'source-default' }, totalCount: 2,
    characterIds: ['ryu', 'arjun'], characters: [
      { characterId: 'ryu', name: 'リュウ', count: 2, mr: summarizeLegendMr([2200, 2250]) },
      { characterId: 'arjun', name: 'アージュン', count: 0, mr: summarizeLegendMr([]) },
    ], mr: summarizeLegendMr([2200, 2250]), validation: { status: 'verified', coverage: 'all-listed-legend-entries', checks: [...LEGEND_ANALYSIS_VALIDATION_CHECKS], notes: ['人工テスト。'] } })
}
async function fixture(t: test.TestContext) {
  const parent = resolve('.cache/legend-import-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, 'case-'))
  t.after(async () => { if (legendAnalysisPathWithin(parent, root)) await rm(root, { recursive: true, force: true }) })
  return { root, input: resolve(root, 'input.json'), output: resolve(root, 'public') }
}
async function snapshot(directory: string) {
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(resolve(directory, name), 'utf8')])))
}

test('aggregate import preserves previous successful snapshots and genuine zero roster entries', async t => {
  const paths = await fixture(t), first = dataset('15'), second = dataset('16')
  await writeFile(paths.input, JSON.stringify(first))
  await importLegendAnalysisData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  await writeFile(paths.input, JSON.stringify(second))
  assert.deepEqual(await importLegendAnalysisData(paths.input, paths.output, generatedAt), { datasets: 2, entries: 4 })
  assert.deepEqual(await validateLegendAnalysisDirectory(paths.output), { datasets: 2, entries: 4 })
  const after = await snapshot(paths.output)
  assert.equal(after[`${first.id}.json`], before[`${first.id}.json`])
  assert.equal(JSON.parse(after[`${second.id}.json`]).characters[1].count, 0)
})

test('same snapshot ID cannot change; invalid private fields never replace public history', async t => {
  const paths = await fixture(t), first = dataset()
  await writeFile(paths.input, JSON.stringify(first))
  await importLegendAnalysisData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  const changed = structuredClone(first); changed.source.notes.push('変更')
  await writeFile(paths.input, JSON.stringify(changed))
  await assert.rejects(importLegendAnalysisData(paths.input, paths.output, generatedAt), /同じID/)
  await writeFile(paths.input, JSON.stringify({ ...first, rows: [{ playerName: 'private', accountKey: 'private-key' }] }))
  await assert.rejects(importLegendAnalysisData(paths.input, paths.output, generatedAt))
  assert.deepEqual(await snapshot(paths.output), before)
})

test('failed daily capture updates availability while retaining every old aggregate', async t => {
  const paths = await fixture(t), first = dataset()
  await writeFile(paths.input, JSON.stringify(first)); await importLegendAnalysisData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output), incoming = resolve(paths.root, 'incoming')
  await mkdir(incoming)
  await writeFile(resolve(incoming, 'index.json'), JSON.stringify({ schemaVersion: 1, generatedAt, source: LEGEND_ANALYSIS_SOURCE,
    datasets: [], availability: { status: 'collection-failed', checkedAt: generatedAt, message: '今回の取得を完了できませんでした。' } }))
  assert.deepEqual(await publishLegendAnalysisData(incoming, paths.output, generatedAt), { datasets: 1, entries: 2 })
  const after = await snapshot(paths.output)
  assert.equal(after[`${first.id}.json`], before[`${first.id}.json`])
  assert.equal(JSON.parse(after['index.json']).availability.status, 'collection-failed')
})

test('unlisted files and oversized JSON fail before publication', async t => {
  const paths = await fixture(t), first = dataset()
  await writeFile(paths.input, JSON.stringify(first)); await importLegendAnalysisData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output), rogue = resolve(paths.output, 'cookies.json')
  await writeFile(rogue, '{}')
  await assert.rejects(validateLegendAnalysisDirectory(paths.output))
  await rm(rogue)
  await writeFile(paths.input, ' '.repeat(1024 * 1024 + 1))
  await assert.rejects(importLegendAnalysisData(paths.input, paths.output, generatedAt))
  assert.deepEqual(await snapshot(paths.output), before)
})

test('hard links are rejected when the platform permits creating them', async t => {
  const paths = await fixture(t)
  await writeFile(paths.input, JSON.stringify(dataset()))
  const linked = resolve(paths.root, 'linked.json')
  try { await link(paths.input, linked) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(String(error.code))) { t.skip('この環境ではハードリンク作成を許可されていません。'); return }
    throw error
  }
  await assert.rejects(importLegendAnalysisData(linked, paths.output, generatedAt))
})
