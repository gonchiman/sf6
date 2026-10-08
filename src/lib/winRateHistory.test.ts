import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateEdition, WinRateManifest } from '../types/winRates.ts'
import { WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import type { HistoryDatasetResult, WinRateHistorySelection } from '../types/winRateHistory.ts'
import {
  createWinRateHistoryPoints, formatHistoryValue, historyCalendarMonths, historyMonths, initialHistorySelection,
  loadWinRateHistory, monthLabel,
} from './winRateHistory.ts'

const capturedAt = '2026-10-08T00:00:00.000Z'
const source = { url: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/dia', title: '対戦ダイアグラム' }

function descriptor(month: string, league = 'MASTER', operationMode: 'combined' | 'separate' = 'combined', edition?: WinRateEdition): WinRateDatasetDescriptor {
  const id = `${edition === 'master' ? 'master-' : ''}${month}-${league.toLowerCase()}-${operationMode}`
  return { ...(edition ? { edition } : {}), id, month, league, operationMode, path: `${id}.json`, capturedAt }
}

function manifest(datasets: WinRateDatasetDescriptor[]): WinRateManifest {
  return { schemaVersion: 1, generatedAt: capturedAt, source, datasets }
}

function selection(overrides: Partial<WinRateHistorySelection> = {}): WinRateHistorySelection {
  return { edition: 'general', league: 'MASTER', controlType: 'combined', fromMonth: '2026-01', toMonth: '2026-08', ...overrides }
}

function dataset(desc: WinRateDatasetDescriptor, text = '5.058'): WinRateDataset {
  const fighters = desc.operationMode === 'combined'
    ? [
      { id: 'first-slot', characterId: 'ryu', name: 'RYU', controlType: null },
      { id: 'second-slot', characterId: 'ken', name: 'KEN', controlType: null },
    ]
    : [
      { id: 'first-slot', characterId: 'ryu', name: 'RYU', controlType: 'classic' as const },
      { id: 'second-slot', characterId: 'ryu', name: 'RYU', controlType: 'modern' as const },
    ]
  return {
    ...(desc.edition ? { edition: desc.edition } : {}),
    schemaVersion: 1, id: desc.id, month: desc.month, league: desc.league,
    operationMode: desc.operationMode, capturedAt: desc.capturedAt, generatedAt: capturedAt,
    source: { ...(desc.edition === 'master' ? WIN_RATE_EDITION_SOURCES.master : source), population: 'ランクマッチ', metric: '公式Total', notes: ['集計詳細は未確認'] },
    fighters,
    // Deliberately reverse the rows: the index must never replace the fighter ID join.
    rows: fighters.map((fighter, index) => ({
      fighterId: fighter.id, total: { text: index === 0 ? text : '10.000', lowSample: false },
      cells: fighters.map(() => ({ text: '1.000', lowSample: false })),
    })).reverse(),
  }
}

function ready(desc: WinRateDatasetDescriptor, data = dataset(desc)): HistoryDatasetResult {
  return { month: desc.month, descriptor: desc, status: 'ready', dataset: data }
}

test('registered months are unique and ascending; initial selection is the last twelve calendar months', () => {
  const input = manifest([descriptor('2026-08'), descriptor('2023-06'), descriptor('2026-08', 'GOLD'), descriptor('2025-09')])
  const before = structuredClone(input)
  assert.deepEqual(historyMonths(input), ['2023-06', '2025-09', '2026-08'])
  assert.deepEqual(initialHistorySelection(input), selection({ fromMonth: '2025-09' }))
  assert.deepEqual(input, before)
  assert.deepEqual(initialHistorySelection(manifest([descriptor('2026-08'), descriptor('2026-06')])), selection({ fromMonth: '2026-06' }))
  assert.throws(() => initialHistorySelection(manifest([])), /対象月/)
  assert.equal(monthLabel('2026-01'), '2026年1月')
  const sparse = manifest([descriptor('2023-06'), descriptor('2026-08')])
  const calendar = historyCalendarMonths(sparse)
  assert.equal(calendar.length, 39)
  assert.equal(calendar[0], '2023-06')
  assert.equal(calendar.at(-1), '2026-08')
  assert.ok(calendar.includes(initialHistorySelection(sparse).fromMonth))
  assert.deepEqual(historyCalendarMonths(manifest([])), [])
})

test('loading uses the exact league, operation mode, and range without substituting another condition', async () => {
  const jan = descriptor('2026-01', 'MASTER', 'separate')
  const feb = descriptor('2026-02', 'MASTER', 'separate')
  const input = manifest([
    feb, descriptor('2026-03', 'MASTER', 'separate'), descriptor('2026-01', 'GOLD', 'separate'),
    descriptor('2026-01'), jan,
  ])
  const calls: string[] = []
  const results = await loadWinRateHistory(input, selection({ controlType: 'modern', toMonth: '2026-02' }), async (desc) => {
    calls.push(desc.id)
    return dataset(desc)
  })
  assert.deepEqual(calls, [jan.id, feb.id])
  assert.deepEqual(results.map((result) => [result.month, result.status]), [['2026-01', 'ready'], ['2026-02', 'ready']])
  assert.deepEqual(await loadWinRateHistory(input, selection({ league: 'ROOKIE' }), async () => {
    assert.fail('an unregistered condition must not load a substitute')
  }), [])
})

test('loads at most four datasets concurrently and returns month order despite completion order', async () => {
  const descriptors = Array.from({ length: 7 }, (_, index) => descriptor(`2026-0${index + 1}`))
  let active = 0
  let peak = 0
  const finished: string[] = []
  const results = await loadWinRateHistory(manifest([...descriptors].reverse()), selection(), async (desc) => {
    peak = Math.max(peak, ++active)
    await delay(desc.month === '2026-01' ? 25 : 1)
    finished.push(desc.month)
    active -= 1
    return dataset(desc)
  })
  assert.equal(peak, 4)
  assert.notEqual(finished[0], '2026-01')
  assert.deepEqual(results.map((result) => result.month), descriptors.map((desc) => desc.month))
})

test('mismatched loader results become errors rather than receiving the requested labels', async () => {
  const desc = descriptor('2026-01')
  for (const change of [
    { id: 'another-dataset' }, { month: '2026-02' }, { league: 'GOLD' },
    { operationMode: 'separate' as const }, { capturedAt: '2026-10-09T00:00:00.000Z' }, { rows: [] },
  ]) {
    const results = await loadWinRateHistory(manifest([desc]), selection(), async () => ({ ...dataset(desc), ...change }))
    assert.deepEqual(results, [{ month: desc.month, descriptor: desc, status: 'error' }])
  }
})

test('a failed month can be retried while successful months use the existing loader cache', async (t) => {
  const first = { ...descriptor('2026-01'), path: 'history-cache-success.json' }
  const second = { ...descriptor('2026-02'), path: 'history-cache-retry.json' }
  const calls = new Map<string, number>()
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const requested = String(input).includes(first.path) ? first : second
    const count = (calls.get(requested.id) ?? 0) + 1
    calls.set(requested.id, count)
    return requested.id === second.id && count === 1 ? new Response(null, { status: 503 }) : Response.json(dataset(requested))
  })
  const input = manifest([first, second])
  assert.deepEqual((await loadWinRateHistory(input, selection())).map((result) => result.status), ['ready', 'error'])
  assert.deepEqual((await loadWinRateHistory(input, selection())).map((result) => result.status), ['ready', 'ready'])
  assert.equal(calls.get(first.id), 1)
  assert.equal(calls.get(second.id), 2)
})

test('calendar gaps, unlisted fighters, missing values, true zero and failed loads remain distinct', () => {
  const descriptors = Array.from({ length: 7 }, (_, index) => descriptor(`2026-0${index + 1}`))
  descriptors[0].league = 'GOLD'
  const unlisted = dataset(descriptors[1])
  unlisted.fighters[0].characterId = 'terry'
  const input = manifest([...descriptors].reverse())
  const results: HistoryDatasetResult[] = [
    ready(descriptors[1], unlisted), ready(descriptors[2], dataset(descriptors[2], '-.---')),
    ready(descriptors[3], dataset(descriptors[3], '0.000')), ready(descriptors[4]),
    { month: descriptors[5].month, descriptor: descriptors[5], status: 'error' },
  ]
  const points = createWinRateHistoryPoints(input, selection({ toMonth: '2026-07' }), 'ryu', results)
  assert.deepEqual(points.map((point) => point.month), descriptors.map((desc) => desc.month))
  assert.deepEqual(points.map((point) => point.status), ['unavailable', 'unlisted', 'missing', 'value', 'value', 'error', 'error'])
  assert.deepEqual(points.map((point) => point.percentHundredths), [null, null, null, 0, 5058, null, null])
  assert.deepEqual(points.map(formatHistoryValue), ['未登録', '未掲載', '-.---', '0.00%', '50.58%', '読込失敗', '読込失敗'])
  assert.equal(points[1].capturedAt, capturedAt)
  assert.deepEqual(points[1].source, unlisted.source)
  assert.equal(points[0].source, null)
  assert.equal(points[5].capturedAt, null)
})

test('months absent from the manifest still occupy their calendar positions across year boundaries', () => {
  const november = descriptor('2025-11')
  const february = descriptor('2026-02')
  const points = createWinRateHistoryPoints(manifest([february, november]), selection({ fromMonth: '2025-11', toMonth: '2026-02' }), 'ryu', [ready(february), ready(november)])
  assert.deepEqual(points.map((point) => [point.month, point.status]), [
    ['2025-11', 'value'], ['2025-12', 'unavailable'], ['2026-01', 'unavailable'], ['2026-02', 'value'],
  ])
})

test('extracts the selected control by stable IDs, not names, row order, or matchup-cell averages', () => {
  const desc = descriptor('2026-01', 'MASTER', 'separate')
  const data = dataset(desc, '0.000')
  const input = manifest([desc])
  const before = structuredClone(data)
  const classic = createWinRateHistoryPoints(input, selection({ controlType: 'classic', toMonth: '2026-01' }), 'ryu', [ready(desc, data)])[0]
  const modern = createWinRateHistoryPoints(input, selection({ controlType: 'modern', toMonth: '2026-01' }), 'ryu', [ready(desc, data)])[0]
  assert.equal(classic.percentHundredths, 0)
  assert.equal(modern.percentHundredths, 10000)
  assert.equal(formatHistoryValue(modern), '100.00%')
  assert.deepEqual(data, before)
})

test('preserves both official missing markers and their stored metadata', () => {
  const desc = descriptor('2026-01')
  for (const marker of ['-', '-.---']) {
    const data = dataset(desc, marker)
    const total = data.rows.find((row) => row.fighterId === 'first-slot')!.total
    total.lowSample = true
    const [point] = createWinRateHistoryPoints(manifest([desc]), selection({ toMonth: desc.month }), 'ryu', [ready(desc, data)])
    assert.equal(point.status, 'missing')
    assert.equal(point.percentHundredths, null)
    assert.deepEqual(point.total, total)
    assert.equal(formatHistoryValue(point), marker)
  }
})

test('rejects stale, duplicated or differently labelled results at point creation', () => {
  const desc = descriptor('2026-01')
  const input = manifest([desc])
  const selected = selection({ toMonth: desc.month })
  for (const results of [
    [ready({ ...desc, capturedAt: '2026-10-09T00:00:00.000Z' })],
    [ready({ ...desc, path: 'another.json' })],
    [ready(desc, { ...dataset(desc), month: '2026-02' })],
    [{ ...ready(desc), month: '2026-02' }],
    [ready(desc), ready(desc)],
  ]) assert.equal(createWinRateHistoryPoints(input, selected, 'ryu', results)[0].status, 'error')
})

test('invalid or reversed ranges fail before loading data', async () => {
  for (const selected of [
    selection({ fromMonth: '2026-13' }), selection({ fromMonth: '2026-09', toMonth: '2026-08' }),
    selection({ league: '' }), selection({ controlType: 'separate' as never }),
    selection({ edition: 'unknown' as never }), selection({ edition: 'master', controlType: 'classic' }),
    selection({ edition: 'master', controlType: 'modern' }), selection({ edition: 'master', league: 'GOLD' }),
  ]) {
    await assert.rejects(loadWinRateHistory(manifest([descriptor('2026-01')]), selected, async () => {
      assert.fail('invalid selections must not request data')
    }))
    assert.throws(() => createWinRateHistoryPoints(manifest([]), selected, 'ryu', []))
  }
  const desc = descriptor('2026-01')
  await assert.rejects(loadWinRateHistory(manifest([desc, { ...desc, id: 'duplicate' }]), selection()), /重複/)
  assert.throws(() => monthLabel('2026-00'), /YYYY-MM/)
})

test('general defaults ignore a newer master-edition month while the calendar keeps both editions', () => {
  const input = manifest([
    descriptor('2023-06'), descriptor('2026-08'), descriptor('2026-09', 'MASTER', 'combined', 'master'),
  ])
  assert.deepEqual(initialHistorySelection(input), selection({ fromMonth: '2025-09', toMonth: '2026-08' }))
  assert.equal(historyCalendarMonths(input).at(-1), '2026-09')
})

test('the two MASTER populations load separately, with omitted edition remaining general', async () => {
  const general = descriptor('2026-01')
  const master = descriptor('2026-01', 'MASTER', 'combined', 'master')
  const input = manifest([master, general])
  for (const edition of [undefined, 'general', 'master'] as const) {
    const calls: string[] = []
    const selected = selection({ edition, toMonth: '2026-01' })
    const results = await loadWinRateHistory(input, selected, async (desc) => {
      calls.push(desc.id)
      return dataset(desc, desc.edition === 'master' ? '4.500' : '5.058')
    })
    assert.deepEqual(calls, [edition === 'master' ? master.id : general.id])
    const [point] = createWinRateHistoryPoints(input, selected, 'ryu', results)
    assert.equal(point.percentHundredths, edition === 'master' ? 4500 : 5058)
    assert.equal(point.source?.url, WIN_RATE_EDITION_SOURCES[edition ?? 'general'].url)
  }
})

test('master history retains the full calendar and never substitutes general data before registration', () => {
  const firstMaster = descriptor('2025-03', 'MASTER', 'combined', 'master')
  const latestMaster = descriptor('2026-08', 'MASTER', 'combined', 'master')
  const firstGeneral = descriptor('2023-06')
  const input = manifest([firstGeneral, firstMaster, latestMaster])
  const points = createWinRateHistoryPoints(input, selection({ edition: 'master', fromMonth: '2023-06' }), 'ryu', [
    ready(firstGeneral), ready(firstMaster), ready(latestMaster),
  ])
  assert.equal(points.length, 39)
  assert.equal(points[20].month, '2025-02')
  assert.ok(points.slice(0, 21).every((point) => point.status === 'unavailable' && point.source === null))
  assert.equal(points[21].month, '2025-03')
  assert.equal(points[21].status, 'value')
  assert.equal(points[21].source?.url, WIN_RATE_EDITION_SOURCES.master.url)
})

test('a result from another edition is rejected even when other descriptor fields match', async () => {
  const general = descriptor('2026-01')
  const mislabeled = { ...general, edition: 'master' as const }
  const selected = selection({ toMonth: '2026-01' })
  const input = manifest([general])
  assert.equal(createWinRateHistoryPoints(input, selected, 'ryu', [ready(mislabeled)])[0].status, 'error')
  assert.equal(createWinRateHistoryPoints(input, selected, 'ryu', [ready(general, dataset(mislabeled))])[0].status, 'error')
  const result = await loadWinRateHistory(input, selected, async () => dataset(mislabeled))
  assert.equal(result[0].status, 'error')
})
