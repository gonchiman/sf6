import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateHistoryResult, UsageRateManifest, UsageRateSelection } from '../types/usageRates.ts'
import { createUsageRateBaselineHistory, usageRateBaselineRequestKey, usageRateBaselineSelection } from './usageRateBaseline.ts'
import { createCharacterUsageRateHistory, usageRateHistoryRequestKey } from './usageRateHistory.ts'
import { loadLeagueUsageRates } from './leagueUsageRates.ts'
import { monthlyChartSegments } from './monthlyLineChart.ts'
import {
  loadUsageRateHistory, parseUsageRateDataset, parseUsageRateManifest, USAGE_RATE_EDITION_SOURCES, USAGE_RATE_SOURCE,
} from './usageRates.ts'

const capturedAt = '2026-10-14T09:00:00.000Z'
const generatedAt = '2026-10-14T09:01:00.000Z'

function descriptor(month = '2026-09', overrides: Partial<UsageRateDatasetDescriptor> = {}): UsageRateDatasetDescriptor {
  return { id: `${month}-all`, month, league: 'ALL', path: `${month}-all.json`, capturedAt, ...overrides }
}

function entries(count: number) {
  const share = Math.floor(100000 / count)
  return Array.from({ length: count }, (_, index) => {
    const percentThousandths = index === count - 1 ? 100000 - share * index : share
    return {
      characterId: `character-${index}`, name: `キャラ${index}`, percentThousandths,
      text: `${Math.floor(percentThousandths / 1000)}.${String(percentThousandths % 1000).padStart(3, '0')}`,
    }
  })
}

function dataset(selected = descriptor(), count = 18): UsageRateDataset {
  const controls = selected.edition === 'master' ? ['all'] as const : ['all', 'classic', 'modern'] as const
  return {
    schemaVersion: 1, id: selected.id, ...(selected.edition ? { edition: selected.edition } : {}), month: selected.month,
    league: selected.league, capturedAt: selected.capturedAt, generatedAt,
    source: { ...USAGE_RATE_EDITION_SOURCES[selected.edition ?? 'general'], population: 'ランクマッチ', metric: 'キャラクター使用率', unit: '公開百分率', notes: [] },
    distributions: controls.map(controlType => ({ controlType, month: selected.month, league: selected.league, entries: entries(count) })),
  }
}

function manifest(datasets = [descriptor()]): UsageRateManifest {
  return { schemaVersion: 1, generatedAt, source: USAGE_RATE_SOURCE, datasets }
}

function selection(overrides: Partial<UsageRateSelection> = {}): UsageRateSelection {
  return { league: 'MASTER', fromMonth: '2026-09', toMonth: '2026-09', ...overrides }
}

function ready(data: UsageRateDataset, selected = descriptor(data.month, {
  id: data.id, edition: data.edition, league: data.league, capturedAt: data.capturedAt,
})): UsageRateHistoryResult {
  return { month: data.month, descriptor: selected, status: 'ready', dataset: data }
}

test('forces one general ALL combined roster independently of displayed edition, league, character and controls', () => {
  const selected = selection({ edition: 'master', league: 'ULTIMATE_MASTER', fromMonth: '2025-02' })
  assert.deepEqual(usageRateBaselineSelection(selected), { edition: 'general', league: 'ALL', fromMonth: '2025-02', toMonth: '2026-09' })
  const input = dataset(descriptor(), 18)
  input.distributions[1].entries = entries(17)
  input.distributions[2].entries = entries(16)
  const before = structuredClone(input)
  const output = createUsageRateBaselineHistory(manifest(), selection({ edition: 'master', league: 'HIGH_MASTER' }), [ready(input)])
  assert.equal(output[0].status, 'value')
  assert.equal(output[0].characterCount, 18)
  assert.equal(output[0].value, 100 / 18)
  assert.notEqual(output[0].value, 100 / 16)
  assert.notEqual(output[0].value, 100 / 31)
  assert.equal(output[0].capturedAt, input.capturedAt)
  assert.equal(output[0].generatedAt, input.generatedAt)
  assert.deepEqual(output[0].source, input.source)
  assert.deepEqual(input, before)
  assert.throws(() => usageRateBaselineSelection(selection({ fromMonth: '2026-10' })), /開始月/)
})

test('retains month-specific counts without display rounding, current-roster substitution or mutation', () => {
  const october = descriptor('2025-10')
  const september = descriptor()
  const old = dataset(october, 28)
  const recent = dataset(september, 31)
  const output = createUsageRateBaselineHistory(manifest([october, september]), selection({ fromMonth: october.month }), [ready(recent), ready(old)])
  assert.equal(output.length, 12)
  assert.equal(output[0].characterCount, 28)
  assert.equal(output[0].value, 100 / 28)
  assert.equal(output.at(-1)!.characterCount, 31)
  assert.equal(output.at(-1)!.value, 100 / 31)
  assert.notEqual(output[0].value, 3.571)
  assert.ok(output.slice(1, -1).every(point => point.status === 'unavailable' && point.value === null && point.characterCount === null))
})

test('published zero and missing percentages still count their roster entries and do not alter raw usage values', () => {
  const input = dataset(descriptor(), 3)
  input.distributions[0].entries[0] = { ...input.distributions[0].entries[0], text: '0.000', percentThousandths: 0 }
  input.distributions[0].entries[1] = { ...input.distributions[0].entries[1], text: '-', percentThousandths: null }
  input.distributions[0].entries[2] = { ...input.distributions[0].entries[2], text: '-.---', percentThousandths: null }
  const untouched = structuredClone(input)
  const output = createUsageRateBaselineHistory(manifest(), selection(), [ready(input)])
  assert.equal(output[0].characterCount, 3)
  assert.equal(output[0].value, 100 / 3)
  assert.deepEqual(input, untouched)
})

test('unregistered ALL, known failures, absent results and duplicate observations stay empty and never borrow another count', () => {
  const master = descriptor('2026-09', { id: '2026-09-master', path: '2026-09-master.json', league: 'MASTER' })
  const rawData = dataset(master, 18)
  const unregistered = createUsageRateBaselineHistory(manifest([master]), selection(), [ready(dataset())])
  assert.equal(unregistered[0].status, 'unavailable')
  const raw = createCharacterUsageRateHistory(manifest([master]), selection(), { characterId: 'character-0', name: 'キャラ0' }, 'combined', [ready(rawData, master)])
  assert.notEqual(raw.series[0].points[0].value, null)
  for (const results of [
    [],
    [{ month: '2026-09', descriptor: descriptor(), status: 'error' }],
    [{ month: '2026-09', status: 'missing' }],
    [ready(dataset()), ready(dataset())],
  ] as UsageRateHistoryResult[][]) {
    const point = createUsageRateBaselineHistory(manifest(), selection(), results)[0]
    assert.equal(point.status, 'error')
    assert.equal(point.value, null)
    assert.equal(point.characterCount, null)
    assert.equal(point.source, null)
    assert.equal(point.capturedAt, null)
  }
})

test('stale paths, captured dates, wrong periods, editions, sources and malformed rosters cannot supply N', () => {
  const input = dataset()
  const selectedMaster = descriptor('2026-09', { edition: 'master', id: 'master-edition', path: 'master-edition.json', league: 'MASTER' })
  const empty = dataset()
  empty.distributions[0].entries = []
  const duplicateId = dataset()
  duplicateId.distributions[0].entries[1].characterId = duplicateId.distributions[0].entries[0].characterId
  const cases = [
    ready(input, descriptor('2026-09', { path: 'wrong.json' })),
    ready(input, descriptor('2026-09', { capturedAt: '2026-10-14T08:00:00Z' })),
    ready(dataset(descriptor('2026-08'))),
    ready(dataset(selectedMaster), selectedMaster),
    ready({ ...input, source: { ...input.source, url: 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate' } }),
    ready(empty),
    ready(duplicateId),
  ]
  for (const result of cases) {
    const point = createUsageRateBaselineHistory(manifest(), selection(), [result])[0]
    assert.equal(point.status, 'error')
    assert.equal(point.characterCount, null)
    assert.equal(point.value, null)
  }
})

test('calendar gaps split the baseline instead of joining or forward-filling unavailable months', () => {
  const july = descriptor('2026-07')
  const september = descriptor()
  const output = createUsageRateBaselineHistory(manifest([july, september]), selection({ fromMonth: july.month }), [ready(dataset(july, 30)), ready(dataset(september, 31))])
  assert.deepEqual(output.map(point => point.status), ['value', 'unavailable', 'value'])
  const paths = monthlyChartSegments(output, month => output.findIndex(point => point.month === month), value => value)
  assert.equal(paths.length, 2)
  assert.ok(paths.every(path => path.startsWith('M ') && !path.includes(' L ')))
})

test('uniform share remains 100/N even for an explicitly rechecked exceptional published sum', () => {
  const input = dataset(descriptor(), 3)
  input.distributions[0].entries[2] = { ...input.distributions[0].entries[2], text: '33.469', percentThousandths: 33469 }
  input.distributions[0].totalMismatch = {
    observedPercentThousandths: 100135, verifiedAt: capturedAt, sourceUrl: USAGE_RATE_SOURCE.url,
    reason: '公式再確認済み。合計100.135%を補正せず保存。',
  }
  input.source.notes.push(input.distributions[0].totalMismatch.reason)
  const original = structuredClone(input)
  const point = createUsageRateBaselineHistory(manifest(), selection(), [ready(input)])[0]
  assert.equal(point.value, 100 / 3)
  assert.notEqual(point.value, 100.135 / 3)
  assert.deepEqual(point.source!.notes, input.source.notes)
  assert.deepEqual(input, original)
})

test('baseline request identity ignores displayed population and controls but tracks ALL source, period and publication', () => {
  const all = descriptor()
  const master = descriptor('2026-09', { id: 'master-edition', path: 'master-edition.json', edition: 'master', league: 'MASTER' })
  const input = manifest([all, master])
  const selected = selection()
  const key = usageRateBaselineRequestKey(input, selected)
  assert.equal(key, usageRateHistoryRequestKey(input, usageRateBaselineSelection(selected)))
  assert.equal(usageRateBaselineRequestKey(input, { ...selected, edition: 'master', league: 'ULTIMATE_MASTER' }), key)
  assert.equal(usageRateBaselineRequestKey(input, { ...selected, characterId: 'other', operationMode: 'separate' } as UsageRateSelection), key)
  assert.equal(usageRateBaselineRequestKey({ ...input, datasets: [all, { ...master, capturedAt: '2026-10-14T08:00:00Z' }] }, selected), key)
  assert.notEqual(usageRateBaselineRequestKey(input, { ...selected, fromMonth: '2026-08' }), key)
  assert.notEqual(usageRateBaselineRequestKey({ ...input, generatedAt: '2026-10-14T10:00:00Z' }, selected), key)
  assert.notEqual(usageRateBaselineRequestKey({ ...input, datasets: [{ ...all, path: 'updated.json' }, master] }, selected), key)
  assert.notEqual(usageRateBaselineRequestKey({ ...input, datasets: [{ ...all, capturedAt: '2026-10-14T08:00:00Z' }, master] }, selected), key)
  assert.notEqual(usageRateBaselineRequestKey({ ...input, source: { ...USAGE_RATE_SOURCE, url: 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate' } }, selected), key)
})

test('baseline loading reuses the existing rank and history dataset request cache', async (t) => {
  const selected = descriptor('2026-09', { id: 'baseline-cache', path: 'baseline-shared-cache.json' })
  const input = dataset(selected, 18)
  const publication = manifest([selected])
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => { count += 1; return Response.json(input) })
  const rank = await loadLeagueUsageRates(publication, selected.month)
  assert.equal(rank[0].status, 'ready')
  const results = await loadUsageRateHistory(publication, usageRateBaselineSelection(selection()))
  const point = createUsageRateBaselineHistory(publication, selection(), results)[0]
  assert.equal(point.characterCount, 18)
  await loadUsageRateHistory(publication, usageRateBaselineSelection(selection({ edition: 'master', league: 'HIGH_MASTER' })))
  assert.equal(count, 1)
})

test('stored historical M16 underlisting never changes the shared N18, and added characters update each month', async () => {
  const publication = parseUsageRateManifest(JSON.parse(await readFile(new URL('../../public/data/usage-rates/index.json', import.meta.url), 'utf8')))
  const oldMaster = parseUsageRateDataset(JSON.parse(await readFile(new URL('../../public/data/usage-rates/2023-06-master.json', import.meta.url), 'utf8')))
  assert.equal(oldMaster.distributions.find(item => item.controlType === 'modern')!.entries.length, 16)
  for (const [month, count] of [['2023-06', 18], ['2025-10', 28], ['2026-03', 29], ['2026-05', 30], ['2026-09', 31]] as const) {
    const selected = publication.datasets.find(item => !item.edition && item.month === month && item.league === 'ALL')!
    const data = parseUsageRateDataset(JSON.parse(await readFile(new URL(`../../public/data/usage-rates/${selected.path}`, import.meta.url), 'utf8')), selected)
    const point = createUsageRateBaselineHistory(publication, selection({ fromMonth: month, toMonth: month }), [ready(data, selected)])[0]
    assert.equal(point.characterCount, count)
    assert.equal(point.value, 100 / count)
    assert.equal(point.source!.url, publication.source.url)
  }
})
