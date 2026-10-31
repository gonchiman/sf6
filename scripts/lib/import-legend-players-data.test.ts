import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS, summarizeLegendMr } from '../../src/lib/legendAnalysis.ts'
import { parseLegendPlayersDataset } from '../../src/lib/legendPlayers.ts'
import type { LegendPlayersDataset } from '../../src/types/legendPlayers.ts'
import { importLegendPlayersData, publishLegendPlayersData } from '../import-legend-players-data.ts'
import { validateLegendPlayersDirectory } from '../validate-legend-players-data.ts'
import { legendAnalysisPathWithin } from './legend-analysis-files.ts'

const generatedAt = '2026-10-28T02:00:00.000Z'

function dataset(day = '27', empty = false): LegendPlayersDataset {
  const capture = `2026-10-${day}T00:00:00.000Z`
  return parseLegendPlayersDataset({
    schemaVersion: 1, id: `legend-${capture.replace(/[:.]/g, '-')}`, captureStartedAt: capture, captureEndedAt: capture, generatedAt: capture,
    source: { ...LEGEND_ANALYSIS_SOURCE, population: '人工テストの掲載エントリー', metric: '掲載プレイヤー一覧',
      unit: 'account-character', notes: ['実データではない。'] },
    act: { id: 'act-13', label: 'Act 13' }, definitionVersion: 'legend-listed-v1', membershipRule: 'official-legend-badge',
    conditions: { region: 'all', platform: 'all', characters: 'all', users: 'source-default' }, totalCount: empty ? 0 : 2,
    players: empty ? [] : [
      { id: 'entry-1', playerName: '人工プレイヤーA', characterId: 'ryu', rank: 1, masterRating: 2500 },
      { id: 'entry-2', playerName: '人工プレイヤーA', characterId: 'ken', rank: 2, masterRating: 2400 },
    ],
    validation: { status: 'verified', coverage: 'all-listed-legend-entries',
      checks: [...LEGEND_ANALYSIS_VALIDATION_CHECKS], notes: ['人工テスト。'] },
  })
}

function enrichedDataset(day = '28'): LegendPlayersDataset {
  const legacy = dataset(day)
  return parseLegendPlayersDataset({ ...legacy, schemaVersion: 2, generatedAt: `2026-10-${day}T01:00:00.000Z`,
    rankedMatchScope: { actId: legacy.act.id, mode: 'ranked', collectionStartedAt: `2026-10-${day}T00:01:00.000Z`,
      collectionEndedAt: `2026-10-${day}T00:45:00.000Z` },
    players: legacy.players.map((row, index) => ({ ...row, playerId: '0012345678', region: '日本', platform: 'Steam',
      rankedMatchCount: index === 0 ? 0 : 1203 })) })
}

async function fixture(t: test.TestContext) {
  const parent = resolve('.cache/legend-players-import-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, 'case-'))
  t.after(async () => { if (legendAnalysisPathWithin(parent, root)) await rm(root, { recursive: true, force: true }) })
  return { root, input: resolve(root, 'input.json'), output: resolve(root, 'public') }
}
async function snapshot(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort()
    .map(async name => [name, await readFile(resolve(directory, name), 'utf8')])))
}
async function writeAvailability(root: string, status: 'not-collected' | 'collection-failed') {
  await mkdir(root)
  await writeFile(resolve(root, 'index.json'), JSON.stringify({ schemaVersion: 1, generatedAt, source: LEGEND_ANALYSIS_SOURCE,
    datasets: [], availability: { status, checkedAt: generatedAt, message: status === 'not-collected' ? '未取得' : '取得失敗' } }))
}

test('player import retains immutable older snapshots and duplicate names on separate character rows', async t => {
  const paths = await fixture(t), first = dataset(), second = dataset('28')
  await writeFile(paths.input, JSON.stringify(first))
  await importLegendPlayersData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  await writeFile(paths.input, JSON.stringify(second))
  assert.deepEqual(await importLegendPlayersData(paths.input, paths.output, generatedAt), { datasets: 2, entries: 4 })
  assert.deepEqual(await validateLegendPlayersDirectory(paths.output), { datasets: 2, entries: 4 })
  const after = await snapshot(paths.output)
  assert.equal(after[`${first.id}.json`], before[`${first.id}.json`])
  assert.deepEqual(JSON.parse(after['index.json']).datasets.map((value: { id: string }) => value.id), [second.id, first.id])
  assert.equal(JSON.parse(after[`${second.id}.json`]).players.length, 2)
  // Importing exactly the same capture is idempotent, including its row ordinals.
  await importLegendPlayersData(paths.input, paths.output, generatedAt)
  assert.deepEqual(await snapshot(paths.output), after)
})

test('changed player names or unknown identity/session fields never replace a saved capture', async t => {
  const paths = await fixture(t), first = dataset()
  await writeFile(paths.input, JSON.stringify(first))
  await importLegendPlayersData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  const changed = structuredClone(first)
  changed.players[0].playerName = '別の名前'
  await writeFile(paths.input, JSON.stringify(changed))
  await assert.rejects(importLegendPlayersData(paths.input, paths.output, generatedAt), /同じID/)
  for (const field of ['accountKey', 'profileUrl', 'playerId', 'cookies', 'storageState']) {
    await writeFile(paths.input, JSON.stringify({ ...first, players: first.players.map(row => ({ ...row, [field]: 'forbidden' })) }))
    await assert.rejects(importLegendPlayersData(paths.input, paths.output, generatedAt))
    assert.deepEqual(await snapshot(paths.output), before)
  }
})

test('failed capture publishes failure state while preserving every existing player row', async t => {
  const paths = await fixture(t), first = dataset()
  await writeFile(paths.input, JSON.stringify(first))
  await importLegendPlayersData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output), incoming = resolve(paths.root, 'failed')
  await writeAvailability(incoming, 'collection-failed')
  assert.deepEqual(await publishLegendPlayersData(incoming, paths.output, generatedAt), { datasets: 1, entries: 2 })
  const after = await snapshot(paths.output)
  assert.equal(after[`${first.id}.json`], before[`${first.id}.json`])
  const manifest = JSON.parse(after['index.json'])
  assert.equal(manifest.availability.status, 'collection-failed')
  assert.equal(manifest.datasets[0].totalCount, 2)
})

test('malformed failed-capture input does not modify existing output', async t => {
  const paths = await fixture(t), first = dataset()
  await writeFile(paths.input, JSON.stringify(first))
  await importLegendPlayersData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output), incoming = resolve(paths.root, 'failed')
  await writeAvailability(incoming, 'collection-failed')
  // Raw diagnostics must not be admitted through the publication directory.
  await writeFile(resolve(incoming, 'session.json'), '{}')
  await assert.rejects(publishLegendPlayersData(incoming, paths.output, generatedAt))
  assert.deepEqual(await snapshot(paths.output), before)
})

test('genuine zero-entry capture can be imported, whereas uncollected input cannot become a zero capture', async t => {
  const paths = await fixture(t), first = dataset(), zero = dataset('28', true)
  await writeFile(paths.input, JSON.stringify(first))
  await importLegendPlayersData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output), incoming = resolve(paths.root, 'uncollected')
  await writeAvailability(incoming, 'not-collected')
  assert.deepEqual(await validateLegendPlayersDirectory(incoming), { datasets: 0, entries: 0 })
  await assert.rejects(importLegendPlayersData(incoming, paths.output, generatedAt), /未取得/)
  assert.deepEqual(await snapshot(paths.output), before)
  await writeFile(paths.input, JSON.stringify(zero))
  assert.deepEqual(await importLegendPlayersData(paths.input, paths.output, generatedAt), { datasets: 2, entries: 2 })
  const after = await snapshot(paths.output)
  assert.equal(JSON.parse(after['index.json']).datasets[0].totalCount, 0)
  assert.deepEqual(JSON.parse(after[`${zero.id}.json`]).players, [])
  assert.equal(after[`${first.id}.json`], before[`${first.id}.json`])
})

test('aggregate-only dataset is rejected rather than interpreted as missing player rows', async t => {
  const paths = await fixture(t), first = dataset()
  await writeFile(paths.input, JSON.stringify(first))
  await importLegendPlayersData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output)
  const { players, ...metadata } = dataset('28')
  const aggregate = { ...metadata, characterIds: ['ryu', 'ken'],
    characters: players.map(row => ({ characterId: row.characterId, name: row.characterId.toUpperCase(), count: 1,
      mr: summarizeLegendMr([row.masterRating]) })), mr: summarizeLegendMr(players.map(row => row.masterRating)) }
  await writeFile(paths.input, JSON.stringify(aggregate))
  await assert.rejects(importLegendPlayersData(paths.input, paths.output, generatedAt))
  assert.deepEqual(await snapshot(paths.output), before)
})

test('v1 and v2 player captures coexist and a failed refresh preserves both immutable datasets', async t => {
  const paths = await fixture(t), legacy = dataset(), enriched = enrichedDataset()
  await writeFile(paths.input, JSON.stringify(legacy))
  await importLegendPlayersData(paths.input, paths.output, generatedAt)
  const original = await snapshot(paths.output)
  await writeFile(paths.input, JSON.stringify(enriched))
  assert.deepEqual(await importLegendPlayersData(paths.input, paths.output, generatedAt), { datasets: 2, entries: 4 })
  const combined = await snapshot(paths.output), saved = JSON.parse(combined[`${enriched.id}.json`])
  assert.equal(combined[`${legacy.id}.json`], original[`${legacy.id}.json`])
  assert.equal(saved.schemaVersion, 2)
  assert.equal(saved.players[0].playerId, '0012345678')
  assert.equal(saved.players[0].rankedMatchCount, 0)
  assert.equal(saved.players[1].rankedMatchCount, 1203)
  assert.equal(Object.hasOwn(JSON.parse(combined[`${legacy.id}.json`]).players[0], 'rankedMatchCount'), false)
  assert.deepEqual(saved.rankedMatchScope, enriched.rankedMatchScope)
  const failed = resolve(paths.root, 'failed-v2')
  await writeAvailability(failed, 'collection-failed')
  assert.deepEqual(await publishLegendPlayersData(failed, paths.output, generatedAt), { datasets: 2, entries: 4 })
  const after = await snapshot(paths.output), manifest = JSON.parse(after['index.json'])
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(manifest.datasets.map((value: { id: string }) => value.id), [enriched.id, legacy.id])
  assert.equal(manifest.availability.status, 'collection-failed')
  for (const id of [legacy.id, enriched.id]) assert.equal(after[`${id}.json`], combined[`${id}.json`])
})

test('invalid enriched values and edits to an existing v2 capture never replace published history', async t => {
  const paths = await fixture(t), enriched = enrichedDataset('27')
  await writeFile(paths.input, JSON.stringify(enriched))
  await importLegendPlayersData(paths.input, paths.output, generatedAt)
  const before = await snapshot(paths.output), next = enrichedDataset()
  for (const patch of [{ playerId: 'not-an-id' }, { region: '' }, { platform: { label: 'Steam' } },
    { rankedMatchCount: -1 }, { rankedMatchCount: undefined }, { accountKey: 'must-not-publish' }]) {
    await writeFile(paths.input, JSON.stringify({ ...next, players: [{ ...next.players[0], ...patch }, next.players[1]] }))
    await assert.rejects(importLegendPlayersData(paths.input, paths.output, generatedAt))
    assert.deepEqual(await snapshot(paths.output), before)
  }
  await writeFile(paths.input, JSON.stringify({ ...next, rankedMatchScope: { ...next.rankedMatchScope, actId: 'act-12' } }))
  await assert.rejects(importLegendPlayersData(paths.input, paths.output, generatedAt))
  const changed = structuredClone(enriched)
  changed.players[0].rankedMatchCount = 1
  await writeFile(paths.input, JSON.stringify(changed))
  await assert.rejects(importLegendPlayersData(paths.input, paths.output, generatedAt), /同じID/)
  assert.deepEqual(await snapshot(paths.output), before)
})
