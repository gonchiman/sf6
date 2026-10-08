import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { validateWinRateDirectory } from '../../scripts/validate-win-rate-data.ts'
import {
  loadWinRateDataset,
  loadWinRateManifest,
  parseWinRateDataset,
  parseWinRateManifest,
} from './winRates.ts'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateManifest } from '../types/winRates.ts'
import { editionOf, leagueLabel, WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'

const capturedAt = '2026-10-07T01:02:03.000Z'
const generatedAt = '2026-10-07T02:03:04.000Z'
const source = { url: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/dia', title: '対戦ダイアグラム' }

function descriptor(overrides: Partial<WinRateDatasetDescriptor> = {}): WinRateDatasetDescriptor {
  return { id: '2026-08-master-combined', month: '2026-08', league: 'MASTER', operationMode: 'combined', path: '2026-08-master-combined.json', capturedAt, ...overrides }
}

function dataset(overrides: Partial<WinRateDataset> = {}): WinRateDataset {
  return {
    schemaVersion: 1, id: '2026-08-master-combined', month: '2026-08', league: 'MASTER',
    operationMode: 'combined', capturedAt, generatedAt,
    source: { ...source, population: 'ランクマッチ', metric: '公式対戦成績（0〜10）', notes: ['試合数は非公開'] },
    fighters: [
      { id: 'ryu', characterId: 'ryu', name: 'リュウ', controlType: null },
      { id: 'ken', characterId: 'ken', name: 'ケン', controlType: null },
    ],
    rows: [
      { fighterId: 'ryu', total: { text: '0.000', lowSample: false }, cells: [{ text: '-', lowSample: false }, { text: '0.000', lowSample: true }] },
      { fighterId: 'ken', total: { text: '10.000', lowSample: false }, cells: [{ text: '10.000', lowSample: true }, { text: '-.---', lowSample: false }] },
    ],
    ...overrides,
  }
}

function manifest(datasets = [descriptor()]): WinRateManifest {
  return { schemaVersion: 1, generatedAt, source: { ...source }, datasets }
}

function masterDescriptor(overrides: Partial<WinRateDatasetDescriptor> = {}): WinRateDatasetDescriptor {
  return descriptor({ edition: 'master', id: '2026-08-master-master-combined', path: '2026-08-master-master-combined.json', ...overrides })
}

function masterDataset(overrides: Partial<WinRateDataset> = {}): WinRateDataset {
  return dataset({
    edition: 'master', id: masterDescriptor().id,
    source: { ...dataset().source, ...WIN_RATE_EDITION_SOURCES.master }, ...overrides,
  })
}

test('official zero, both missing markers, three decimals and low-sample flags retain their meanings', () => {
  const input = dataset()
  assert.deepEqual(parseWinRateDataset(input, descriptor()), input)
  assert.equal(parseWinRateDataset(input).rows[0].cells[1].text, '0.000')
  assert.equal(parseWinRateDataset(input).rows[0].cells[1].lowSample, true)
  assert.deepEqual(parseWinRateManifest(manifest()), manifest())
})

test('legacy general editions keep their omitted property while explicit editions retain their identity', () => {
  const legacy = parseWinRateDataset(dataset(), descriptor({ edition: 'general' }))
  assert.equal(Object.hasOwn(legacy, 'edition'), false)
  assert.equal(Object.hasOwn(parseWinRateManifest(manifest()).datasets[0], 'edition'), false)
  const explicit = parseWinRateDataset(dataset({ edition: 'general' }), descriptor())
  assert.equal(explicit.edition, 'general')
  assert.equal(editionOf(legacy), 'general')
  assert.deepEqual(parseWinRateDataset(masterDataset(), masterDescriptor()), masterDataset())
  assert.equal(editionOf(masterDescriptor()), 'master')
  assert.equal(leagueLabel('HIGH_MASTER'), 'HIGH MASTER')
  assert.equal(leagueLabel('GRAND_MASTER'), 'GRAND MASTER')
  assert.equal(leagueLabel('ULTIMATE_MASTER'), 'ULTIMATE MASTER')
  assert.equal(leagueLabel('MASTER'), 'MASTER')
})

test('general and master MASTER conditions coexist, but implicit and explicit general duplicates do not', () => {
  const mixed = manifest([descriptor(), masterDescriptor()])
  assert.deepEqual(parseWinRateManifest(mixed), mixed)
  assert.throws(() => parseWinRateManifest(manifest([
    descriptor(), descriptor({ edition: 'general', id: 'duplicate-general', path: 'duplicate-general.json' }),
  ])), /datasets.conditions/)
  assert.throws(() => parseWinRateManifest(manifest([
    masterDescriptor(), masterDescriptor({ id: 'duplicate-master', path: 'duplicate-master.json' }),
  ])), /datasets.conditions/)
})

test('edition restricts the source, available leagues and operation modes', () => {
  for (const league of WIN_RATE_EDITION_LEAGUES.master) {
    assert.equal(parseWinRateDataset(masterDataset({ league }), masterDescriptor({ league })).league, league)
  }
  for (const invalid of [
    dataset({ source: { ...dataset().source, url: WIN_RATE_EDITION_SOURCES.master.url } }),
    masterDataset({ source: dataset().source }),
    dataset({ league: 'HIGH_MASTER' }), masterDataset({ league: 'GOLD' }),
    masterDataset({ operationMode: 'separate' }),
    { ...dataset(), edition: 'unknown' }, { ...dataset(), edition: null },
  ]) assert.throws(() => parseWinRateDataset(invalid), /形式/)
  for (const invalid of [
    masterDescriptor({ league: 'ROOKIE' }), masterDescriptor({ operationMode: 'separate' }),
    descriptor({ league: 'HIGH_MASTER' }), { ...descriptor(), edition: 'unknown' },
  ]) assert.throws(() => parseWinRateManifest(manifest([invalid as WinRateDatasetDescriptor])), /形式/)
  assert.throws(() => parseWinRateDataset(dataset(), masterDescriptor({ id: descriptor().id })), /edition/)
  assert.throws(() => parseWinRateDataset(masterDataset(), descriptor({ id: masterDescriptor().id })), /edition/)
})

test('rows are identified by fighter ID while the column order is preserved', () => {
  const input = dataset()
  input.rows.reverse()
  assert.deepEqual(parseWinRateDataset(input).rows, input.rows)
})

test('different conditions or capture versions cannot be displayed as the selected dataset', () => {
  for (const expected of [
    descriptor({ id: 'another' }), descriptor({ month: '2026-07' }), descriptor({ league: 'DIAMOND' }),
    descriptor({ operationMode: 'separate' }), descriptor({ capturedAt: '2026-10-07T03:00:00Z' }),
  ]) assert.throws(() => parseWinRateDataset(dataset(), expected), /一致しません/)
})

test('a matrix must contain each fighter exactly once and a value for every column', () => {
  for (const change of [
    (input: WinRateDataset) => { input.rows.pop() },
    (input: WinRateDataset) => { input.rows[0].cells.pop() },
    (input: WinRateDataset) => { input.rows[0].cells.push({ text: '5.000', lowSample: false }) },
    (input: WinRateDataset) => { input.rows[1].fighterId = input.rows[0].fighterId },
    (input: WinRateDataset) => { input.rows[1].fighterId = 'unknown' },
    (input: WinRateDataset) => { input.fighters[1].id = input.fighters[0].id },
    (input: WinRateDataset) => { input.fighters[1].characterId = input.fighters[0].characterId },
  ]) {
    const input = dataset()
    change(input)
    assert.throws(() => parseWinRateDataset(input), /形式/)
  }
})

test('separate controls stay distinct and combined data cannot silently receive a control type', () => {
  const input = dataset({ operationMode: 'separate' })
  input.fighters[0] = { id: 'ryu-c', characterId: 'ryu', name: 'リュウ', controlType: 'classic' }
  input.fighters[1] = { id: 'ryu-m', characterId: 'ryu', name: 'リュウ', controlType: 'modern' }
  input.rows[0].fighterId = 'ryu-c'
  input.rows[1].fighterId = 'ryu-m'
  assert.equal(parseWinRateDataset(input).fighters.length, 2)
  input.fighters[1].controlType = 'classic'
  assert.throws(() => parseWinRateDataset(input), /fighters.identity/)
  assert.throws(() => parseWinRateDataset(dataset({ operationMode: 'separate' })), /controlType/)
  const combined = dataset()
  combined.fighters[0].controlType = 'classic'
  assert.throws(() => parseWinRateDataset(combined), /controlType/)
})

test('invalid values and missing low-sample flags are rejected rather than repaired or treated as zero', () => {
  for (const text of ['0', '5.00', '5.0000', '10.001', '-1.000', '50.000', 'NaN', '', ' 5.000', '—', null, 0]) {
    const input = dataset() as unknown as { rows: { total: { text: unknown } }[] }
    input.rows[0].total.text = text
    assert.throws(() => parseWinRateDataset(input), /text/)
  }
  const input = dataset() as unknown as { rows: { total: { lowSample?: unknown } }[] }
  delete input.rows[0].total.lowSample
  assert.throws(() => parseWinRateDataset(input), /lowSample/)
  input.rows[0].total.lowSample = 'false'
  assert.throws(() => parseWinRateDataset(input), /lowSample/)
})

test('published metadata must use a supported schema, actual calendar dates and an official source', () => {
  assert.equal(parseWinRateDataset(dataset({ capturedAt: '2026-10-07T10:02:03.123456+09:00' })).capturedAt, '2026-10-07T10:02:03.123456+09:00')
  for (const input of [
    { ...dataset(), schemaVersion: 2 }, dataset({ month: '2026-13' }),
    dataset({ capturedAt: '2026-02-30T00:00:00Z' }), dataset({ generatedAt: '2026-10-07' }),
    dataset({ source: { ...dataset().source, url: 'javascript:alert(1)' } }),
    dataset({ source: { ...dataset().source, url: 'https://example.com/6/buckler/ja-jp/stats/dia' } }),
  ]) assert.throws(() => parseWinRateDataset(input), /形式/)
})

test('manifest rejects ambiguous selections and paths outside its data directory', () => {
  for (const input of [
    manifest([descriptor(), descriptor({ path: 'copy.json' })]),
    manifest([descriptor(), descriptor({ id: 'copy', path: 'copy.json' })]),
    manifest([descriptor(), descriptor({ id: 'copy', month: '2026-07' })]),
    ...['../elsewhere.json', '/outside.json', 'https://example.com/data.json', 'file.json?query', 'folder\\data.json', 'index.json'].map((path) => manifest([descriptor({ path })])),
  ]) assert.throws(() => parseWinRateManifest(input), /形式/)
})

test('manifest requests are shared, and a failed load can be retried', async (t) => {
  let count = 0
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(String(input))
    count += 1
    return count === 1 ? new Response(null, { status: 503 }) : Response.json(manifest())
  })
  await assert.rejects(loadWinRateManifest(), /読み込めません/)
  const [first, second] = await Promise.all([loadWinRateManifest(), loadWinRateManifest()])
  assert.strictEqual(first, second)
  assert.equal(count, 2)
  assert.deepEqual(requests, ['/data/win-rates/index.json', '/data/win-rates/index.json'])
})

test('datasets are cached by URL and capture time without mixing selected conditions', async (t) => {
  const first = descriptor({ path: 'cache-first.json' })
  const second = descriptor({ id: '2026-07-master-combined', month: '2026-07', path: 'cache-second.json' })
  const newer = descriptor({ ...first, capturedAt: '2026-10-08T01:02:03.000Z' })
  let count = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    count += 1
    const url = String(input)
    if (url.includes('cache-second')) return Response.json(dataset({ id: second.id, month: second.month }))
    if (url.includes(encodeURIComponent(newer.capturedAt))) return Response.json(dataset({ capturedAt: newer.capturedAt }))
    return Response.json(dataset())
  })
  const [firstResult, duplicate, secondResult] = await Promise.all([
    loadWinRateDataset(first), loadWinRateDataset(first), loadWinRateDataset(second),
  ])
  assert.strictEqual(firstResult, duplicate)
  assert.equal(firstResult.month, '2026-08')
  assert.equal(secondResult.month, '2026-07')
  assert.equal(count, 2)
  assert.equal((await loadWinRateDataset(newer)).capturedAt, newer.capturedAt)
  assert.equal(count, 3)
  await assert.rejects(loadWinRateDataset({ ...first, league: 'DIAMOND' }), /一致しません/)
})

test('malformed datasets are removed from the request cache so a retry can recover', async (t) => {
  const selected = descriptor({ path: 'retry-malformed.json' })
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => {
    count += 1
    return Response.json(count === 1 ? dataset({ rows: [] }) : dataset())
  })
  await assert.rejects(loadWinRateDataset(selected), /rows/)
  assert.equal((await loadWinRateDataset(selected)).rows.length, 2)
  assert.equal(count, 2)
})

test('edition-specific cache failures cannot evict or return the other edition at the same URL', async (t) => {
  const general = descriptor({ path: 'edition-cache-isolation.json' })
  const master = masterDescriptor({ id: general.id, path: general.path })
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => {
    count += 1
    return Response.json(count < 3 ? dataset() : masterDataset({ id: master.id }))
  })
  const generalResult = await loadWinRateDataset(general)
  assert.equal(editionOf(generalResult), 'general')
  await assert.rejects(loadWinRateDataset(master), /edition/)
  assert.strictEqual(await loadWinRateDataset({ ...general, edition: 'general' }), generalResult)
  assert.equal(count, 2)
  assert.equal(editionOf(await loadWinRateDataset(master)), 'master')
  assert.strictEqual(await loadWinRateDataset(general), generalResult)
  assert.equal(count, 3)
})

test('validation checks every registered file and rejects unregistered or absent JSON files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sf6-win-rate-validation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dataPath = join(directory, descriptor().path)
  await writeFile(join(directory, 'index.json'), JSON.stringify(manifest()))
  await writeFile(dataPath, JSON.stringify(dataset()))
  assert.deepEqual(await validateWinRateDirectory(directory), { datasets: 1, cells: 6 })
  const unregisteredPath = join(directory, 'unregistered.json')
  await writeFile(unregisteredPath, JSON.stringify(dataset()))
  await assert.rejects(validateWinRateDirectory(directory), /登録されていないJSON/)
  await rm(unregisteredPath)
  await rm(dataPath)
  await assert.rejects(validateWinRateDirectory(directory), /ENOENT/)
})

test('directory validation checks master sources by edition while preserving a general manifest source', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sf6-edition-validation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'index.json'), JSON.stringify(manifest([descriptor(), masterDescriptor()])))
  await writeFile(join(directory, descriptor().path), JSON.stringify(dataset()))
  const masterPath = join(directory, masterDescriptor().path)
  await writeFile(masterPath, JSON.stringify(masterDataset()))
  assert.deepEqual(await validateWinRateDirectory(directory), { datasets: 2, cells: 12 })
  await writeFile(masterPath, JSON.stringify(masterDataset({ source: dataset().source })))
  await assert.rejects(validateWinRateDirectory(directory), /source.url/)
  await writeFile(masterPath, JSON.stringify(masterDataset({
    source: { ...masterDataset().source, url: 'https://www.streetfighter.com/6/buckler/en/stats/dia_master' },
  })))
  await assert.rejects(validateWinRateDirectory(directory), /出典URL/)
})
