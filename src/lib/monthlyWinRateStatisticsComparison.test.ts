import assert from 'node:assert/strict'
import test from 'node:test'
import { createMonthlyStatisticsComparison, loadMonthlyStatisticsComparison } from './monthlyWinRateStatisticsComparison.ts'
import { WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import type { LeagueStatisticsDatasetResults } from '../types/monthlyWinRateStatisticsComparison.ts'
import type { HistoryDatasetResult, WinRateHistorySelection } from '../types/winRateHistory.ts'
import type {
  WinRateControlType, WinRateDataset, WinRateDatasetDescriptor, WinRateEdition, WinRateManifest,
} from '../types/winRates.ts'

const capturedAt = '2026-10-08T00:00:00.000Z'

function descriptor(
  month: string, league = 'MASTER', operationMode: 'combined' | 'separate' = 'combined', edition: WinRateEdition = 'general',
): WinRateDatasetDescriptor {
  const id = `${edition}-${month}-${league.toLowerCase()}-${operationMode}`
  return { edition, id, month, league, operationMode, path: `${id}.json`, capturedAt }
}

function manifest(datasets: WinRateDatasetDescriptor[]): WinRateManifest {
  return { schemaVersion: 1, generatedAt: capturedAt, source: WIN_RATE_EDITION_SOURCES.general, datasets }
}

function selection(overrides: Partial<WinRateHistorySelection> = {}): WinRateHistorySelection {
  return {
    edition: 'general', league: 'MASTER', controlType: 'combined',
    fromMonth: '2026-01', toMonth: '2026-01', ...overrides,
  }
}

interface Character {
  id: string
  text: string
  lowSample?: boolean
  controlType?: WinRateControlType
}

function dataset(desc: WinRateDatasetDescriptor, characters: Character[]): WinRateDataset {
  const fighters = characters.map((character, index) => ({
    id: `slot-${index}`, characterId: character.id, name: character.id.toUpperCase(),
    controlType: character.controlType ?? null,
  }))
  return {
    edition: desc.edition, schemaVersion: 1, id: desc.id, month: desc.month, league: desc.league,
    operationMode: desc.operationMode, capturedAt: desc.capturedAt, generatedAt: capturedAt,
    source: {
      ...WIN_RATE_EDITION_SOURCES[desc.edition ?? 'general'], population: 'ランクマッチ',
      metric: '公式Total', notes: ['試合数は未取得'],
    },
    fighters,
    rows: fighters.map((fighter, index) => ({
      fighterId: fighter.id,
      total: { text: characters[index].text, lowSample: characters[index].lowSample ?? false },
      cells: fighters.map(() => ({ text: '1.000', lowSample: false })),
    })).reverse(),
  }
}

function ready(desc: WinRateDatasetDescriptor, characters: Character[]): HistoryDatasetResult {
  return { month: desc.month, descriptor: desc, status: 'ready', dataset: dataset(desc, characters) }
}

test('選択した版・リーグ・操作モード・期間だけを取得し、重複リーグの先頭順を保つ', async () => {
  const master = descriptor('2026-01')
  const gold = descriptor('2026-01', 'GOLD')
  const input = manifest([
    descriptor('2026-02'), descriptor('2026-01', 'MASTER', 'separate'),
    descriptor('2026-01', 'MASTER', 'combined', 'master'), descriptor('2026-01', 'SILVER'), master, gold,
  ])
  const calls: string[] = []
  const output = await loadMonthlyStatisticsComparison(input, selection(), ['GOLD', 'MASTER', 'GOLD', 'MASTER'], async desc => {
    calls.push(desc.id)
    return dataset(desc, [{ id: 'ryu', text: desc.league === 'GOLD' ? '4.000' : '6.000' }])
  })
  assert.deepEqual(output.map(item => item.league), ['GOLD', 'MASTER'])
  assert.deepEqual(calls.sort(), [master.id, gold.id].sort())
  const statistics = createMonthlyStatisticsComparison(input, selection(), output, 'monthly')
  assert.deepEqual(statistics.map(item => item.statistics.rows[0].statistics?.meanPercent), [40, 60])
})

test('マスター版の複数リーグを同じ版の独立した対象集団として取得する', async () => {
  const leagues = ['MASTER', 'HIGH_MASTER', 'GRAND_MASTER', 'ULTIMATE_MASTER']
  const descriptors = leagues.map(league => descriptor('2026-01', league, 'combined', 'master'))
  const input = manifest([descriptor('2026-01'), ...descriptors])
  const calls: string[] = []
  const selected = selection({ edition: 'master' })
  const results = await loadMonthlyStatisticsComparison(input, selected, leagues, async desc => {
    calls.push(desc.id)
    return dataset(desc, [{ id: 'ryu', text: `${leagues.indexOf(desc.league) + 4}.000` }])
  })
  assert.deepEqual(calls.sort(), descriptors.map(item => item.id).sort())
  const output = createMonthlyStatisticsComparison(input, selected, results, 'monthly')
  assert.deepEqual(output.map(item => item.league), leagues)
  assert.deepEqual(output.map(item => item.statistics.rows[0].statistics?.meanPercent), [40, 50, 60, 70])
  assert.ok(output.every(item => item.statistics.rows[0].source?.url === WIN_RATE_EDITION_SOURCES.master.url))
})

test('全リーグ合計の同時取得を4に制限し、失敗後も待機中の月を取得する', async () => {
  const leagues = ['MASTER', 'GOLD', 'SILVER']
  const descriptors = leagues.flatMap(league => ['2026-01', '2026-02', '2026-03', '2026-04'].map(month => descriptor(month, league)))
  let active = 0
  let peak = 0
  const calls: string[] = []
  const failedId = descriptors[0].id
  const results = await loadMonthlyStatisticsComparison(manifest(descriptors), selection({ toMonth: '2026-04' }), leagues, async desc => {
    active += 1
    peak = Math.max(peak, active)
    calls.push(desc.id)
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (desc.id === failedId) throw new Error('failed fixture')
      return dataset(desc, [{ id: 'ryu', text: '5.000' }])
    } finally {
      active -= 1
    }
  })
  assert.equal(peak, 4)
  assert.equal(active, 0)
  assert.equal(calls.length, descriptors.length)
  assert.equal(new Set(calls).size, descriptors.length)
  assert.deepEqual(results.flatMap(item => item.results).filter(item => item.status === 'error').map(item => item.descriptor.id), [failedId])
  assert.equal(results.flatMap(item => item.results).filter(item => item.status === 'ready').length, descriptors.length - 1)
})

test('クラシックとモダンは同じ分離データを使い、各リーグの選択操作だけを独立投影する', async () => {
  const master = descriptor('2026-01', 'MASTER', 'separate')
  const gold = descriptor('2026-01', 'GOLD', 'separate')
  const input = manifest([master, gold, descriptor('2026-01'), descriptor('2026-01', 'GOLD')])
  const calls: string[] = []
  const results = await loadMonthlyStatisticsComparison(input, selection({ controlType: 'classic' }), ['MASTER', 'GOLD'], async desc => {
    calls.push(desc.id)
    return dataset(desc, desc.league === 'MASTER' ? [
      { id: 'ryu', text: '0.000', controlType: 'classic' }, { id: 'ryu', text: '10.000', controlType: 'modern' },
      { id: 'ken', text: '4.200', controlType: 'classic' }, { id: 'ken', text: '6.100', controlType: 'modern' },
    ] : [
      { id: 'ryu', text: '1.000', controlType: 'classic' }, { id: 'ryu', text: '9.000', controlType: 'modern' },
    ])
  })
  assert.deepEqual(calls.sort(), [master.id, gold.id].sort())
  const classic = createMonthlyStatisticsComparison(input, selection({ controlType: 'classic' }), results, 'monthly')
  const modern = createMonthlyStatisticsComparison(input, selection({ controlType: 'modern' }), results, 'monthly')
  assert.deepEqual(classic.map(item => item.statistics.rows[0].statistics?.meanPercent), [21, 10])
  assert.deepEqual(modern.map(item => item.statistics.rows[0].statistics?.meanPercent), [80.5, 90])
  assert.equal(calls.length, 2)
})

test('リーグごとに0%・欠損・未登録・失敗を区別し、一方の失敗で他方の月を消さない', () => {
  const masterJan = descriptor('2026-01')
  const masterFeb = descriptor('2026-02')
  const goldJan = descriptor('2026-01', 'GOLD')
  const goldFeb = descriptor('2026-02', 'GOLD')
  const input = manifest([masterJan, masterFeb, goldJan, goldFeb])
  const results: LeagueStatisticsDatasetResults[] = [
    { league: 'MASTER', results: [
      ready(masterJan, [{ id: 'ryu', text: '0.000' }, { id: 'ken', text: '0.000' }, { id: 'cammy', text: '-' }]),
      ready(masterFeb, [{ id: 'ryu', text: '5.000' }, { id: 'ken', text: '5.000', lowSample: true }]),
    ] },
    { league: 'GOLD', results: [
      ready(goldJan, [{ id: 'ryu', text: '10.000' }]), { month: goldFeb.month, descriptor: goldFeb, status: 'error' },
    ] },
  ]
  const output = createMonthlyStatisticsComparison(input, selection({ toMonth: '2026-03' }), results, 'monthly')
  const master = output[0].statistics.rows
  const gold = output[1].statistics.rows
  assert.deepEqual(master.map(item => item.status), ['ready', 'ready', 'unavailable'])
  assert.deepEqual(gold.map(item => item.status), ['ready', 'error', 'unavailable'])
  assert.equal(master[0].statistics?.meanPercent, 0)
  assert.equal(master[0].statistics?.standardDeviationPoints, 0)
  assert.equal(master[0].validCount, 2)
  assert.equal(master[0].excludedMissingCount, 1)
  assert.equal(master[1].excludedLowSampleCount, 1)
  assert.equal(master[1].statistics?.meanPercent, 50)
  assert.equal(gold[0].statistics?.meanPercent, 100)
  assert.equal(gold[1].statistics, null)
  assert.equal(master[2].statistics, null)
})

test('共通キャラは各リーグの期間内だけで交差し、異なるリーグ間で交差・合算しない', () => {
  const masterJan = descriptor('2026-01')
  const masterFeb = descriptor('2026-02')
  const goldJan = descriptor('2026-01', 'GOLD')
  const goldFeb = descriptor('2026-02', 'GOLD')
  const input = manifest([masterJan, masterFeb, goldJan, goldFeb])
  const results: LeagueStatisticsDatasetResults[] = [
    { league: 'MASTER', results: [
      ready(masterJan, [{ id: 'ryu', text: '0.000' }, { id: 'ken', text: '6.000' }]),
      ready(masterFeb, [{ id: 'ryu', text: '4.000' }, { id: 'ken', text: '6.000', lowSample: true }]),
    ] },
    { league: 'GOLD', results: [
      ready(goldJan, [{ id: 'ryu', text: '1.000' }, { id: 'ken', text: '8.000' }]),
      ready(goldFeb, [{ id: 'ryu', text: '-' }, { id: 'ken', text: '8.000' }]),
    ] },
  ]
  const before = structuredClone({ input, results })
  const output = createMonthlyStatisticsComparison(input, selection({ toMonth: '2026-02' }), results, 'common')
  assert.deepEqual(output.map(item => item.statistics.commonCharacterCount), [1, 1])
  assert.deepEqual(output[0].statistics.rows.map(item => item.characterIds), [['ryu'], ['ryu']])
  assert.deepEqual(output[1].statistics.rows.map(item => item.characterIds), [['ken'], ['ken']])
  assert.deepEqual(output[0].statistics.rows.map(item => item.statistics?.meanPercent), [0, 40])
  assert.deepEqual(output[1].statistics.rows.map(item => item.statistics?.meanPercent), [80, 80])
  assert.deepEqual({ input, results }, before)
})

test('共通集計が失敗する範囲は該当リーグだけに留める', () => {
  const masterJan = descriptor('2026-01')
  const masterFeb = descriptor('2026-02')
  const goldJan = descriptor('2026-01', 'GOLD')
  const goldFeb = descriptor('2026-02', 'GOLD')
  const output = createMonthlyStatisticsComparison(manifest([masterJan, masterFeb, goldJan, goldFeb]), selection({ toMonth: '2026-02' }), [
    { league: 'MASTER', results: [ready(masterJan, [{ id: 'ryu', text: '5.000' }]), ready(masterFeb, [{ id: 'ryu', text: '6.000' }])] },
    { league: 'GOLD', results: [ready(goldJan, [{ id: 'ryu', text: '5.000' }]), { month: goldFeb.month, descriptor: goldFeb, status: 'error' }] },
  ], 'common')
  assert.equal(output[0].statistics.commonUnavailable, false)
  assert.equal(output[0].statistics.commonCharacterCount, 1)
  assert.deepEqual(output[0].statistics.rows.map(item => item.status), ['ready', 'ready'])
  assert.equal(output[1].statistics.commonUnavailable, true)
  assert.equal(output[1].statistics.commonCharacterCount, null)
  assert.deepEqual(output[1].statistics.rows.map(item => item.status), ['incomplete', 'error'])
})

test('別リーグ・別版・別操作モードの結果や壊れたデータを代用せず該当月を失敗にする', () => {
  const desc = descriptor('2026-01')
  const gold = descriptor('2026-01', 'GOLD')
  const masterEdition = descriptor('2026-01', 'MASTER', 'combined', 'master')
  const separate = descriptor('2026-01', 'MASTER', 'separate')
  const malformed = ready(desc, [{ id: 'ryu', text: '5.000' }])
  if (malformed.status === 'ready') malformed.dataset.rows[0].cells = []
  for (const bad of [ready(gold, [{ id: 'ryu', text: '5.000' }]), ready(masterEdition, [{ id: 'ryu', text: '5.000' }]),
    ready(separate, [{ id: 'ryu', text: '5.000', controlType: 'classic' }]), malformed]) {
    const [output] = createMonthlyStatisticsComparison(manifest([desc, gold, masterEdition, separate]), selection(), [
      { league: 'MASTER', results: [bad] },
    ], 'monthly')
    assert.equal(output.statistics.rows[0].status, 'error')
    assert.equal(output.statistics.rows[0].statistics, null)
  }
})

test('結果側の重複リーグも最初の結果だけを保つ', () => {
  const desc = descriptor('2026-01')
  const output = createMonthlyStatisticsComparison(manifest([desc]), selection(), [
    { league: 'MASTER', results: [ready(desc, [{ id: 'ryu', text: '4.000' }])] },
    { league: 'MASTER', results: [ready(desc, [{ id: 'ryu', text: '8.000' }])] },
  ], 'monthly')
  assert.equal(output.length, 1)
  assert.equal(output[0].statistics.rows[0].statistics?.meanPercent, 40)
})

test('不正な版・リーグ・操作・期間・重複descriptorを通信開始前に拒否する', async () => {
  let calls = 0
  const loader = async (desc: WinRateDatasetDescriptor) => { calls += 1; return dataset(desc, [{ id: 'ryu', text: '5.000' }]) }
  const input = manifest([descriptor('2026-01')])
  for (const [selected, leagues] of [
    [selection(), ['MASTER', 'UNKNOWN']], [selection(), ['MASTER', 'HIGH_MASTER']],
    [selection({ edition: 'master' }), ['MASTER', 'GOLD']],
    [selection({ edition: 'master', controlType: 'modern' }), ['MASTER']],
    [selection({ edition: 'unknown' as never }), ['MASTER']],
    [selection({ fromMonth: '2026-13' }), []], [selection({ fromMonth: '2026-02' }), ['MASTER']],
  ] as const) {
    await assert.rejects(loadMonthlyStatisticsComparison(input, selected, leagues, loader))
    assert.throws(() => createMonthlyStatisticsComparison(input, selected, leagues.map(league => ({ league, results: [] })), 'monthly'))
  }
  const desc = descriptor('2026-01')
  await assert.rejects(loadMonthlyStatisticsComparison(manifest([desc, { ...desc, id: 'duplicate' }]), selection(), ['MASTER'], loader), /重複/)
  assert.equal(calls, 0)
  assert.throws(() => createMonthlyStatisticsComparison(input, selection(), [], 'unknown' as never), /集計対象/)
})

test('有効な空のリーグ選択は取得・集計とも空で返す', async () => {
  const input = manifest([])
  const output = await loadMonthlyStatisticsComparison(input, selection(), [], async () => { assert.fail('must not request empty selection') })
  assert.deepEqual(output, [])
  assert.deepEqual(createMonthlyStatisticsComparison(input, selection(), [], 'monthly'), [])
})
