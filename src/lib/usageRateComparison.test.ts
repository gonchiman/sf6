import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { UsageRateComparisonResult, UsageRateComparisonRow } from '../types/usageRateComparison.ts'
import type { UsageRateHistorySelection } from '../types/usageRateHistory.ts'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateHistoryResult, UsageRateManifest } from '../types/usageRates.ts'
import {
  createUsageRateComparison, loadUsageRateComparison, MAX_USAGE_RATE_COMPARISON_SERIES,
  usageRateComparisonLabel, usageRateComparisonRequestKey, usageRateComparisonSeriesId,
} from './usageRateComparison.ts'
import { parseUsageRateDataset, parseUsageRateManifest, USAGE_RATE_EDITION_SOURCES, USAGE_RATE_SOURCE } from './usageRates.ts'

const capturedAt = '2026-10-14T09:00:00.000Z'
const generatedAt = '2026-10-14T09:01:00.000Z'

function selection(overrides: Partial<UsageRateHistorySelection> = {}): UsageRateHistorySelection {
  return { edition: 'general', league: 'MASTER', fromMonth: '2026-09', toMonth: '2026-09', ...overrides }
}

function row(overrides: Partial<UsageRateComparisonRow> = {}): UsageRateComparisonRow {
  return { id: 'row-1', characterId: 'ryu', characterName: 'リュウ', league: 'MASTER', controlType: 'combined', colorSlot: 0, ...overrides }
}

function descriptor(month = '2026-09', league = 'MASTER', overrides: Partial<UsageRateDatasetDescriptor> = {}): UsageRateDatasetDescriptor {
  return { id: `${month}-${league.toLowerCase()}`, month, league, path: `${month}-${league.toLowerCase()}.json`, capturedAt, ...overrides }
}

function entry(characterId: string, percentThousandths: number) {
  return {
    characterId, name: characterId === 'ryu' ? 'リュウ' : 'ケン', percentThousandths,
    text: `${Math.floor(percentThousandths / 1000)}.${String(percentThousandths % 1000).padStart(3, '0')}`,
  }
}

function dataset(selected = descriptor(), values = [9566, 10565, 4403]): UsageRateDataset {
  const controls = selected.edition === 'master' ? ['all'] as const : ['all', 'classic', 'modern'] as const
  return {
    schemaVersion: 1, id: selected.id, ...(selected.edition ? { edition: selected.edition } : {}), month: selected.month,
    league: selected.league, capturedAt: selected.capturedAt, generatedAt,
    source: { ...USAGE_RATE_EDITION_SOURCES[selected.edition ?? 'general'], population: 'ランクマッチ', metric: 'キャラクター使用率', unit: '公開百分率', notes: [] },
    distributions: controls.map((controlType, index) => ({ controlType, month: selected.month, league: selected.league,
      entries: [entry('ryu', values[index]), entry('ken', 100000 - values[index])],
    })),
  }
}

function manifest(datasets = [descriptor()]): UsageRateManifest {
  return { schemaVersion: 1, generatedAt, source: USAGE_RATE_SOURCE, datasets }
}

function ready(data: UsageRateDataset, selected = descriptor(data.month, data.league, { id: data.id, capturedAt: data.capturedAt, edition: data.edition })): UsageRateHistoryResult {
  return { month: data.month, descriptor: selected, status: 'ready', dataset: data }
}

function result(data: UsageRateDataset, selected?: UsageRateDatasetDescriptor): UsageRateComparisonResult {
  return { league: data.league, results: [ready(data, selected)] }
}

test('each row projects one exact character/league/control series with stable composite identity and source precision', () => {
  const selected = descriptor()
  const all = descriptor('2026-09', 'ALL')
  const master = dataset(selected)
  master.distributions[2].entries.reverse()
  const allData = dataset(all, [8123, 9000, 4000])
  const rows = Object.freeze([
    row({ id: 'modern', controlType: 'modern', colorSlot: 4 }),
    row({ id: 'all', league: 'ALL', colorSlot: 2 }),
    row({ id: 'ken', characterId: 'ken', characterName: 'ケン', controlType: 'classic', colorSlot: 5 }),
  ])
  const before = structuredClone([master, allData])
  const output = createUsageRateComparison(manifest([selected, all]), selection(), rows, [result(allData, all), result(master, selected)])
  assert.deepEqual(output.map(series => series.id), ['modern', 'all', 'ken'])
  assert.deepEqual(output.map(series => series.points[0].value), [4.403, 8.123, 89.435])
  assert.deepEqual(output.map(series => series.colorSlot), [4, 2, 5])
  assert.equal(output[0].seriesId, 'general:ryu:MASTER:modern')
  assert.equal(output[0].label, 'リュウ · MASTER · モダン')
  assert.equal(output[1].label, 'リュウ · ALL（全体） · 合算')
  assert.equal(output[0].points[0].entry!.text, '4.403')
  assert.equal(output[0].points[0].percentThousandths, 4403)
  assert.equal(output[0].points[0].capturedAt, capturedAt)
  assert.equal(output[0].points[0].generatedAt, generatedAt)
  assert.equal(output[0].points[0].source!.url, USAGE_RATE_SOURCE.url)
  assert.deepEqual([master, allData], before)
})

test('series identity ignores row metadata but separates every statistical condition', () => {
  const original = row()
  const id = usageRateComparisonSeriesId('general', original)
  assert.equal(usageRateComparisonSeriesId('general', row({ id: 'renamed', characterName: 'RYU', colorSlot: 5 })), id)
  assert.notEqual(usageRateComparisonSeriesId('master', original), id)
  for (const change of [{ characterId: 'ken' }, { league: 'ALL' }, { controlType: 'modern' }] as const) {
    assert.notEqual(usageRateComparisonSeriesId('general', row(change)), id)
  }
  assert.equal(usageRateComparisonLabel(row({ league: 'HIGH_MASTER' })), 'リュウ · HIGH MASTER · 合算')
})

test('six unique rows are accepted; duplicate conditions, row IDs, colors and malformed or unsupported rows are rejected', async () => {
  const rows: UsageRateComparisonRow[] = ['ryu', 'ken'].flatMap((characterId, index) =>
    (['combined', 'classic', 'modern'] as const).map((controlType, controlIndex) => row({
      id: `${characterId}-${controlType}`, characterId, controlType, colorSlot: index * 3 + controlIndex,
    })))
  assert.equal(rows.length, MAX_USAGE_RATE_COMPARISON_SERIES)
  assert.equal(createUsageRateComparison(manifest(), selection(), rows, [result(dataset())]).length, 6)
  const seventh = [...rows, row({ id: 'seventh', characterId: 'jamie' })]
  assert.throws(() => usageRateComparisonRequestKey(manifest(), selection(), seventh), /6件/)
  await assert.rejects(loadUsageRateComparison(manifest(), selection(), seventh), /6件/)
  const duplicates = [
    [row(), row({ id: 'other', colorSlot: 1 })],
    [row(), row({ controlType: 'modern', colorSlot: 1 })],
    [row(), row({ id: 'other', controlType: 'modern' })],
  ]
  for (const conditions of duplicates) assert.throws(() => createUsageRateComparison(manifest(), selection(), conditions, []), /重複/)
  const invalid = [
    row({ id: '' }), row({ characterId: '' }), row({ characterName: ' ' }), row({ characterId: 'has:separator' }),
    row({ league: 'HIGH_MASTER' }), row({ controlType: 'wrong' as 'combined' }),
    row({ colorSlot: -1 }), row({ colorSlot: 6 }), row({ colorSlot: 0.5 }), row({ colorSlot: Number.NaN }),
  ]
  for (const condition of invalid) assert.throws(() => usageRateComparisonRequestKey(manifest(), selection(), [condition]), /指定/)
  for (const condition of [row({ controlType: 'classic' }), row({ league: 'ROOKIE' })]) {
    assert.throws(() => createUsageRateComparison(manifest(), selection({ edition: 'master' }), [condition], []), /指定/)
  }
  assert.deepEqual(createUsageRateComparison(manifest(), selection(), [], []), [])
  assert.deepEqual(await loadUsageRateComparison(manifest(), selection(), []), [])
})

test('request identity depends only on common dates, edition and the unique sorted league files, not series presentation', () => {
  const all = descriptor('2026-09', 'ALL')
  const input = manifest([descriptor(), all])
  const original = [row()]
  const key = usageRateComparisonRequestKey(input, selection(), original)
  const replacement = [row({ id: 'replacement', characterId: 'ken', characterName: 'KEN', controlType: 'modern', colorSlot: 5 })]
  assert.equal(usageRateComparisonRequestKey(input, selection({ league: 'unused-common-league' }), replacement), key)
  assert.equal(usageRateComparisonRequestKey(input, selection(), [...original, row({ id: 'modern', controlType: 'modern', colorSlot: 1 })]), key)
  const multiple = [row(), row({ id: 'all', league: 'ALL', colorSlot: 1 })]
  const multipleKey = usageRateComparisonRequestKey(input, selection(), multiple)
  assert.equal(usageRateComparisonRequestKey(input, selection(), [...multiple].reverse()), multipleKey)
  assert.notEqual(multipleKey, key)
  assert.notEqual(usageRateComparisonRequestKey(input, selection({ fromMonth: '2026-08' }), original), key)
  assert.notEqual(usageRateComparisonRequestKey(input, selection({ edition: 'master' }), original), key)
  assert.notEqual(usageRateComparisonRequestKey({ ...input, generatedAt: '2026-10-14T10:00:00Z' }, selection(), original), key)
  assert.notEqual(usageRateComparisonRequestKey({ ...input, datasets: [{ ...descriptor(), path: 'changed.json' }, all] }, selection(), original), key)
  assert.notEqual(usageRateComparisonRequestKey({ ...input, source: { ...USAGE_RATE_SOURCE, url: 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate' } }, selection(), original), key)
})

test('zeros, unlisted controls, missing markers, unregistered months and failed loads remain independent for every row', () => {
  const july = descriptor('2026-07')
  const september = descriptor()
  const early = dataset(july, [0, 0, 0])
  early.distributions[2].entries = [entry('ken', 100000)]
  const late = dataset(september)
  late.distributions[2].entries[0] = { ...late.distributions[2].entries[0], text: '-.---', percentThousandths: null }
  const rows = [row(), row({ id: 'modern', controlType: 'modern', colorSlot: 1 }), row({ id: 'all', league: 'ALL', colorSlot: 2 })]
  const output = createUsageRateComparison(manifest([july, september]), selection({ fromMonth: july.month }), rows, [{ league: 'MASTER', results: [ready(early), ready(late)] }])
  assert.deepEqual(output[0].points.map(point => point.value), [0, null, 9.566])
  assert.deepEqual(output[1].points.map(point => point.status), ['unlisted', 'unavailable', 'missing'])
  assert.equal(output[1].points[2].entry!.text, '-.---')
  assert.ok(output[2].points.every(point => point.status === 'unavailable' && point.value === null))
  const failed = createUsageRateComparison(manifest([july, september]), selection({ fromMonth: july.month }), [row()], [{ league: 'MASTER', results: [ready(early), { month: september.month, descriptor: september, status: 'error' }] }])
  assert.deepEqual(failed[0].points.map(point => point.status), ['value', 'unavailable', 'error'])
})

test('stale datasets, duplicate result groups and duplicate months cannot inject a value or erase another league', () => {
  const all = descriptor('2026-09', 'ALL')
  const input = manifest([descriptor(), all])
  const validAll = result(dataset(all), all)
  const original = dataset()
  const candidates: UsageRateComparisonResult[] = [
    { league: 'MASTER', results: [ready(original, descriptor('2026-09', 'MASTER', { path: 'stale.json' }))] },
    { league: 'MASTER', results: [ready({ ...original, capturedAt: '2026-10-14T08:00:00Z' })] },
    { league: 'MASTER', results: [ready(dataset(descriptor('2026-08')))] },
    { league: 'MASTER', results: [ready({ ...original, source: { ...original.source, url: 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate' } })] },
    { league: 'MASTER', results: [ready(original), ready(original)] },
  ]
  const rows = [row(), row({ id: 'all', league: 'ALL', colorSlot: 1 })]
  for (const candidate of candidates) {
    const output = createUsageRateComparison(input, selection(), rows, [candidate, validAll])
    assert.equal(output[0].points[0].status, 'error')
    assert.equal(output[0].points[0].value, null)
    assert.equal(output[0].points[0].source, null)
    assert.equal(output[1].points[0].value, 9.566)
  }
  const duplicated = createUsageRateComparison(input, selection(), rows, [result(original), result(original), validAll])
  assert.equal(duplicated[0].points[0].status, 'error')
  assert.equal(duplicated[1].points[0].status, 'value')
})

test('mixed leagues share one global four-request budget and files are loaded once regardless of C/M or character rows', async () => {
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
  const descriptors = ['MASTER', 'ALL'].flatMap(league => months.map(month => descriptor(month, league)))
  const rows = [row(), row({ id: 'modern', controlType: 'modern', colorSlot: 1 }),
    row({ id: 'ken-all', characterId: 'ken', characterName: 'ケン', league: 'ALL', colorSlot: 2 })]
  let active = 0
  let maximum = 0
  const calls: UsageRateDatasetDescriptor[] = []
  const output = await loadUsageRateComparison(manifest(descriptors), selection({ fromMonth: months[0] }), rows, async selected => {
    active += 1
    maximum = Math.max(maximum, active)
    calls.push(selected)
    try {
      await new Promise(done => setTimeout(done, 2))
      if (selected.league === 'ALL' && selected.month === '2026-07') throw new Error('network')
      return dataset(selected)
    } finally { active -= 1 }
  })
  assert.equal(maximum, 4)
  assert.equal(active, 0)
  assert.equal(calls.length, 10)
  assert.deepEqual(calls.map(item => item.league), [...Array(5).fill('ALL'), ...Array(5).fill('MASTER')])
  assert.deepEqual(output.map(item => item.league), ['ALL', 'MASTER'])
  assert.equal(output[0].results[2].status, 'error')
  const projected = createUsageRateComparison(manifest(descriptors), selection({ fromMonth: months[0] }), rows, output)
  assert.equal(projected[0].points[2].status, 'value')
  assert.equal(projected[2].points[2].status, 'error')
})

test('default loader reuses cached files for row edits and keeps master edition source files separate', async (t) => {
  const descriptorList = ['2026-08', '2026-09'].flatMap(month => [
    descriptor(month, 'MASTER', { id: `comparison-cache-${month}-master`, path: `comparison-cache-${month}-master.json` }),
    descriptor(month, 'ALL', { id: `comparison-cache-${month}-all`, path: `comparison-cache-${month}-all.json` }),
    descriptor(month, 'MASTER', { edition: 'master', id: `comparison-cache-${month}-master-edition`, path: `comparison-cache-${month}-master-edition.json` }),
  ])
  const input = manifest(descriptorList)
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (request: string | URL | Request) => {
    requests.push(String(request))
    const path = new URL(String(request), 'http://localhost').pathname
    const selected = descriptorList.find(item => path.endsWith(`/${item.path}`))!
    return Response.json(dataset(selected, selected.edition === 'master' ? [80000] : undefined))
  })
  const common = selection({ fromMonth: '2026-08' })
  const rows = [row(), row({ id: 'all', league: 'ALL', colorSlot: 1 })]
  const first = await loadUsageRateComparison(input, common, rows)
  assert.equal(requests.length, 4)
  const changed = [row({ id: 'ken', characterId: 'ken', characterName: 'ケン', controlType: 'modern', colorSlot: 5 }),
    row({ id: 'all-classic', league: 'ALL', controlType: 'classic', colorSlot: 4 })]
  await loadUsageRateComparison(input, common, changed)
  assert.equal(requests.length, 4)
  const projection = createUsageRateComparison(input, common, changed, first)
  assert.equal(projection[0].points[0].value, 95.597)
  assert.equal(projection[1].points[0].value, 10.565)
  const master = await loadUsageRateComparison(input, { ...common, edition: 'master' }, [row()])
  assert.equal(requests.length, 6)
  assert.equal(createUsageRateComparison(input, { ...common, edition: 'master' }, [row()], master)[0].points[0].value, 80)
  assert.ok(requests.slice(-2).every(url => url.includes(encodeURIComponent(USAGE_RATE_EDITION_SOURCES.master.url))))
})

test('official historical conditions preserve unlisted Modern characters and the combined-only quality annotation', async () => {
  const input = parseUsageRateManifest(JSON.parse(await readFile(new URL('../../public/data/usage-rates/index.json', import.meta.url), 'utf8')))
  const selected = input.datasets.find(item => !item.edition && item.month === '2023-06' && item.league === 'MASTER')!
  const data = parseUsageRateDataset(JSON.parse(await readFile(new URL(`../../public/data/usage-rates/${selected.path}`, import.meta.url), 'utf8')), selected)
  const rows = [row(), row({ id: 'modern', characterId: 'dhalsim', characterName: 'ダルシム', controlType: 'modern', colorSlot: 1 }),
    row({ id: 'classic', characterId: 'dhalsim', characterName: 'ダルシム', controlType: 'classic', colorSlot: 2 })]
  const output = createUsageRateComparison(input, selection({ fromMonth: selected.month, toMonth: selected.month }), rows, [result(data, selected)])
  assert.equal(output[0].points[0].value, 4.537)
  assert.equal(output[0].points[0].totalMismatch!.observedPercentThousandths, 100135)
  assert.equal(output[1].points[0].status, 'unlisted')
  assert.equal(output[1].points[0].value, null)
  assert.equal(output[2].points[0].status, 'value')
  assert.equal(output[2].points[0].totalMismatch, undefined)
})
