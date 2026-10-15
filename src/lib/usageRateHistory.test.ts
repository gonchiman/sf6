import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateHistoryResult, UsageRateManifest, UsageRateSelection } from '../types/usageRates.ts'
import { monthlyChartMonths, monthlyChartSegments } from './monthlyLineChart.ts'
import {
  createCharacterUsageRateHistory, formatUsageRateHistoryPoint, monthlyUsageRateAxis,
  selectUsageRateHistoryConditions, usageRateHistoryRequestKey,
} from './usageRateHistory.ts'
import { parseUsageRateDataset, parseUsageRateManifest, USAGE_RATE_EDITION_SOURCES, USAGE_RATE_SOURCE } from './usageRates.ts'

const capturedAt = '2026-10-14T09:00:00.000Z'
const generatedAt = '2026-10-14T09:01:00.000Z'
const character = { characterId: 'ryu', name: 'リュウ' }

function descriptor(month = '2026-09', overrides: Partial<UsageRateDatasetDescriptor> = {}): UsageRateDatasetDescriptor {
  return { id: `${month}-master`, month, league: 'MASTER', path: `${month}-master.json`, capturedAt, ...overrides }
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
    schemaVersion: 1, id: selected.id, ...(selected.edition ? { edition: selected.edition } : {}),
    month: selected.month, league: selected.league, capturedAt: selected.capturedAt, generatedAt,
    source: {
      ...USAGE_RATE_EDITION_SOURCES[selected.edition ?? 'general'], population: 'ランクマッチ',
      metric: 'キャラクター使用率', unit: '公開使用率（%）', notes: ['人数と試合数は非公開'],
    },
    distributions: controls.map((controlType, index) => ({
      controlType, month: selected.month, league: selected.league,
      entries: [entry('ryu', values[index]), entry('ken', 100000 - values[index])],
    })),
  }
}

function manifest(datasets = [descriptor()]): UsageRateManifest {
  return { schemaVersion: 1, generatedAt, source: USAGE_RATE_SOURCE, datasets }
}

function selection(overrides: Partial<UsageRateSelection> = {}): UsageRateSelection {
  return { league: 'MASTER', fromMonth: '2026-09', toMonth: '2026-09', ...overrides }
}

function ready(input: UsageRateDataset, selected = descriptor(input.month, { id: input.id, edition: input.edition, league: input.league, capturedAt: input.capturedAt })): UsageRateHistoryResult {
  return { month: input.month, descriptor: selected, status: 'ready', dataset: input }
}

test('selects by stable character ID and retains exact thousandths, original text and provenance without win-rate scaling', () => {
  const input = dataset()
  input.distributions[0].entries.reverse()
  input.distributions[0].entries.find(entry => entry.characterId === 'ryu')!.name = '別の表示名'
  const untouched = structuredClone(input)
  const result = createCharacterUsageRateHistory(manifest(), selection(), character, 'combined', [ready(input)])
  assert.equal(result.characterId, 'ryu')
  assert.equal(result.characterName, 'リュウ')
  assert.equal(result.series[0].controlType, 'combined')
  const point = result.series[0].points[0]
  assert.equal(point.percentThousandths, 9566)
  assert.equal(point.value, 9.566)
  assert.equal(formatUsageRateHistoryPoint(point), '9.566%')
  assert.equal(point.entry!.name, '別の表示名')
  assert.equal(point.capturedAt, capturedAt)
  assert.equal(point.generatedAt, generatedAt)
  assert.deepEqual(point.source, input.source)
  assert.deepEqual(input, untouched)
})

test('keeps real zero, both official missing markers, unlisted characters, unregistered months and failures distinct', () => {
  const may = descriptor('2026-05')
  const july = descriptor('2026-07')
  const august = descriptor('2026-08')
  const september = descriptor('2026-09')
  const october = descriptor('2026-10')
  const zero = dataset(may, [0, 0, 0])
  const unlisted = dataset(july)
  for (const distribution of unlisted.distributions) distribution.entries = [entry('ken', 100000)]
  const missing = dataset(august)
  missing.distributions[0].entries[0] = { ...missing.distributions[0].entries[0], text: '-', percentThousandths: null }
  const missingDotted = dataset(october)
  missingDotted.distributions[0].entries[0] = { ...missingDotted.distributions[0].entries[0], text: '-.---', percentThousandths: null }
  const result = createCharacterUsageRateHistory(manifest([may, july, august, september, october]),
    selection({ fromMonth: may.month, toMonth: october.month }), character, 'combined', [
      ready(missingDotted), { month: september.month, descriptor: september, status: 'error' }, ready(missing), ready(unlisted), ready(zero),
    ])
  const points = result.series[0].points
  assert.deepEqual(points.map(point => point.month), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
  assert.deepEqual(points.map(point => point.status), ['value', 'unavailable', 'unlisted', 'missing', 'error', 'missing'])
  assert.deepEqual(points.map(formatUsageRateHistoryPoint), ['0.000%', '未登録', '未掲載', '-', '読込失敗', '-.---'])
  assert.deepEqual(points.map(point => point.value), [0, null, null, null, null, null])
  assert.equal(points[1].source, null)
  assert.notEqual(points[2].source, null)
  assert.equal(points[4].capturedAt, null)
})

test('C/M keep their published within-control distributions, unequal rosters and order without averages or zero filling', () => {
  const input = dataset()
  input.distributions[1].entries = [entry('ken', 60000), entry('ryu', 40000)]
  input.distributions[2].entries = [entry('ken', 100000)]
  const result = createCharacterUsageRateHistory(manifest(), selection(), character, 'separate', [ready(input)])
  assert.deepEqual(result.series.map(series => series.controlType), ['classic', 'modern'])
  assert.equal(result.series[0].points[0].value, 40)
  assert.equal(result.series[1].points[0].status, 'unlisted')
  assert.equal(result.series[1].points[0].value, null)
  const combined = createCharacterUsageRateHistory(manifest(), selection(), character, 'combined', [ready(input)])
  assert.equal(combined.series[0].points[0].value, 9.566)
})

test('master edition has one combined series and never substitutes the same-month general MASTER dataset', () => {
  const master = descriptor('2026-09', { id: 'master-edition-master', path: 'master-edition-master.json', edition: 'master' })
  const publication = manifest([descriptor(), master])
  const input = dataset(master, [80000])
  const result = createCharacterUsageRateHistory(publication, selection({ edition: 'master' }), character, 'combined', [ready(input, master)])
  assert.equal(result.series.length, 1)
  assert.equal(result.series[0].points[0].value, 80)
  assert.equal(result.series[0].points[0].source!.url, USAGE_RATE_EDITION_SOURCES.master.url)
  const stale = createCharacterUsageRateHistory(publication, selection({ edition: 'master' }), character, 'combined', [ready(dataset())])
  assert.equal(stale.series[0].points[0].status, 'error')
  assert.throws(() => createCharacterUsageRateHistory(publication, selection({ edition: 'master' }), character, 'separate', []), /操作タイプ/)
})

test('stale descriptors, wrong dates, conditions, sources and duplicated observations cannot contribute values', () => {
  const input = dataset()
  const cases: UsageRateHistoryResult[] = [
    ready(input, descriptor('2026-09', { id: 'wrong' })),
    ready(input, descriptor('2026-09', { path: 'wrong.json' })),
    ready(input, descriptor('2026-09', { capturedAt: '2026-10-14T08:00:00Z' })),
    ready({ ...input, id: 'wrong' }),
    ready({ ...input, month: '2026-08' }, descriptor()),
    ready({ ...input, source: { ...input.source, url: 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate' } }),
    { month: '2026-09', status: 'missing' },
  ]
  for (const candidate of cases) {
    const result = createCharacterUsageRateHistory(manifest(), selection(), character, 'combined', [candidate])
    assert.equal(result.series[0].points[0].status, 'error')
    assert.equal(result.series[0].points[0].value, null)
    assert.equal(result.series[0].points[0].source, null)
  }
  const duplicated = createCharacterUsageRateHistory(manifest(), selection(), character, 'combined', [ready(input), ready(input)])
  assert.equal(duplicated.series[0].points[0].status, 'error')
  const noResult = createCharacterUsageRateHistory(manifest(), selection(), character, 'combined', [])
  assert.equal(noResult.series[0].points[0].status, 'error')
  const unregistered = createCharacterUsageRateHistory(manifest(), selection({ league: 'ALL' }), character, 'combined', [ready(dataset(descriptor('2026-09', { league: 'ALL' })))])
  assert.equal(unregistered.series[0].points[0].status, 'unavailable')
})

test('rechecked exceptional totals retain raw values and a warning only on the affected visible distribution', () => {
  const selected = descriptor('2023-06')
  const input = dataset(selected, [33735, 40000, 0])
  input.distributions[0].entries[1] = entry('ken', 66400)
  const warning = {
    observedPercentThousandths: 100135, verifiedAt: capturedAt, sourceUrl: `${USAGE_RATE_SOURCE.url}/202306`,
    reason: '公式再確認済み。合計100.135%の掲載値を補正せず保存。',
  }
  input.distributions[0].totalMismatch = warning
  const selectedConditions = selection({ fromMonth: selected.month, toMonth: selected.month })
  const result = createCharacterUsageRateHistory(manifest([selected]), selectedConditions, character, 'combined', [ready(input)])
  assert.equal(result.series[0].points[0].value, 33.735)
  assert.deepEqual(result.series[0].points[0].totalMismatch, warning)
  const separate = createCharacterUsageRateHistory(manifest([selected]), selectedConditions, character, 'separate', [ready(input)])
  assert.equal(separate.series[0].points[0].totalMismatch, undefined)
  assert.equal(separate.series[1].points[0].totalMismatch, undefined)
})

test('monthly calendar and line segments preserve gaps instead of connecting across unregistered months', () => {
  const july = descriptor('2026-07')
  const september = descriptor('2026-09')
  const result = createCharacterUsageRateHistory(manifest([july, september]), selection({ fromMonth: july.month }), character, 'combined', [ready(dataset(july)), ready(dataset(september))])
  const points = result.series[0].points
  const series = [{ id: 'combined', label: '合算', points, style: { color: '#777', marker: 'circle' as const } }]
  assert.deepEqual(monthlyChartMonths(series), ['2026-07', '2026-08', '2026-09'])
  assert.deepEqual(monthlyChartSegments(points, month => points.findIndex(point => point.month === month), value => value), ['M 0 9.566', 'M 2 9.566'])
})

function months(from: string, count: number): string[] {
  const [year, month] = from.split('-').map(Number)
  const first = year * 12 + month - 1
  return Array.from({ length: count }, (_, offset) => {
    const index = first + offset
    return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`
  })
}

function fullCalendarManifest(): UsageRateManifest {
  return manifest([
    ...months('2023-06', 40).map(month => descriptor(month)),
    ...months('2025-02', 20).map(month => descriptor(month, { edition: 'master', id: `${month}-master-edition`, path: `${month}-master-edition.json` })),
  ])
}

test('conditions default to MASTER and the earliest through latest calendar months of each edition', () => {
  const input = fullCalendarManifest()
  assert.deepEqual(selectUsageRateHistoryConditions(input, 'general'), {
    edition: 'general', league: 'MASTER', fromMonth: '2023-06', toMonth: '2026-09',
  })
  assert.deepEqual(selectUsageRateHistoryConditions(input, 'master'), {
    edition: 'master', league: 'MASTER', fromMonth: '2025-02', toMonth: '2026-09',
  })
  assert.equal(selectUsageRateHistoryConditions(manifest(), 'master'), null)
  const sparse = manifest([descriptor('2025-01'), descriptor('2026-09')])
  assert.equal(selectUsageRateHistoryConditions(sparse, 'general')!.fromMonth, '2025-01')
})

test('valid history ranges survive condition changes, partial overlap clamps, and fully unavailable ranges reset', () => {
  const input = fullCalendarManifest()
  const preferred = selection({ league: 'DIAMOND', fromMonth: '2024-06', toMonth: '2026-03' })
  const before = structuredClone(preferred)
  assert.deepEqual(selectUsageRateHistoryConditions(input, 'general', preferred), { ...preferred, edition: 'general' })
  assert.deepEqual(selectUsageRateHistoryConditions(input, 'master', preferred), {
    edition: 'master', league: 'MASTER', fromMonth: '2025-02', toMonth: '2026-03',
  })
  assert.deepEqual(selectUsageRateHistoryConditions(input, 'general', { league: 'ALL', fromMonth: '2022-01', toMonth: '2027-03' }), {
    edition: 'general', league: 'ALL', fromMonth: '2023-06', toMonth: '2026-09',
  })
  for (const unavailable of [
    { fromMonth: '2023-06', toMonth: '2024-12' },
    { fromMonth: '2027-01', toMonth: '2027-06' },
    { fromMonth: '2026-09', toMonth: '2025-02' },
  ]) assert.deepEqual(selectUsageRateHistoryConditions(input, 'master', unavailable), {
    edition: 'master', league: 'MASTER', fromMonth: '2025-02', toMonth: '2026-09',
  })
  assert.deepEqual(preferred, before)
})

test('request keys separate editions, sources, periods and publication changes while excluding characters and display mode', () => {
  const input = fullCalendarManifest()
  const selected = selection()
  const key = usageRateHistoryRequestKey(input, selected)
  assert.equal(usageRateHistoryRequestKey(input, { ...selected, edition: 'general' }), key)
  assert.equal(usageRateHistoryRequestKey(input, { ...selected, characterId: 'ken', operationMode: 'separate' } as UsageRateSelection), key)
  assert.equal(usageRateHistoryRequestKey({ ...input, datasets: [...input.datasets].reverse() }, selected), key)
  assert.notEqual(usageRateHistoryRequestKey(input, { ...selected, edition: 'master' }), key)
  assert.notEqual(usageRateHistoryRequestKey(input, { ...selected, fromMonth: '2026-08' }), key)
  assert.notEqual(usageRateHistoryRequestKey(input, { ...selected, league: 'ALL' }), key)
  assert.notEqual(usageRateHistoryRequestKey({ ...input, generatedAt: '2026-10-14T09:02:00Z' }, selected), key)
  assert.notEqual(usageRateHistoryRequestKey({ ...input, source: { ...USAGE_RATE_SOURCE, url: 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate' } }, selected), key)
  const changed = structuredClone(input)
  changed.datasets.find(item => item.id === descriptor().id)!.capturedAt = '2026-10-14T08:00:00Z'
  assert.notEqual(usageRateHistoryRequestKey(changed, selected), key)
  const duplicate = manifest([descriptor(), descriptor('2026-09', { id: 'duplicate', path: 'duplicate.json' })])
  assert.throws(() => usageRateHistoryRequestKey(duplicate, selected), /duplicate/)
})

test('usage history axes start at zero, include every valid percentage, and ignore nonfinite or invalid percentages', () => {
  const normal = monthlyUsageRateAxis([9.001, 9.566, 10.565])
  assert.equal(normal.start, 0)
  assert.ok(normal.end >= 10.565 && normal.end < 50)
  assert.ok(!normal.ticks.includes(50))
  assert.deepEqual(monthlyUsageRateAxis([0, 100]), { start: 0, end: 100, step: 20, ticks: [0, 20, 40, 60, 80, 100] })
  for (const values of [[], [0], [0.001], [99.999], [Number.NaN, Infinity, -1, 101]]) {
    const axis = monthlyUsageRateAxis(values)
    assert.equal(axis.start, 0)
    assert.ok(Number.isFinite(axis.end) && axis.end > 0 && axis.end <= 100)
    assert.ok(values.filter(value => Number.isFinite(value) && value >= 0 && value <= 100).every(value => value <= axis.end))
    assert.equal(axis.ticks[0], 0)
    assert.equal(axis.ticks.at(-1), axis.end)
  }
})

test('stored official September data and rechecked historical data retain their exact published values', async () => {
  const input = parseUsageRateManifest(JSON.parse(await readFile(new URL('../../public/data/usage-rates/index.json', import.meta.url), 'utf8')))
  for (const [month, expectedValue, expectedWarning] of [['2026-09', 9.566, undefined], ['2023-06', 4.537, 100135]] as const) {
    const selected = input.datasets.find(item => !item.edition && item.month === month && item.league === 'MASTER')!
    const data = parseUsageRateDataset(JSON.parse(await readFile(new URL(`../../public/data/usage-rates/${selected.path}`, import.meta.url), 'utf8')), selected)
    const result = createCharacterUsageRateHistory(input, selection({ fromMonth: month, toMonth: month }), character, 'combined', [ready(data, selected)])
    assert.equal(result.series[0].points[0].value, expectedValue)
    assert.equal(result.series[0].points[0].totalMismatch?.observedPercentThousandths, expectedWarning)
  }
})
