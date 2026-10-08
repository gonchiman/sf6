import assert from 'node:assert/strict'
import test from 'node:test'
import { createMonthlyWinRateStatistics, formatMonthlyStatistic } from './monthlyWinRateStatistics.ts'
import { loadWinRateHistory } from './winRateHistory.ts'
import { WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import type { HistoryDatasetResult, WinRateHistorySelection } from '../types/winRateHistory.ts'
import type {
  WinRateControlType, WinRateDataset, WinRateDatasetDescriptor, WinRateEdition, WinRateManifest,
} from '../types/winRates.ts'

const capturedAt = '2026-10-08T00:00:00.000Z'
const source = WIN_RATE_EDITION_SOURCES.general

function descriptor(
  month: string, operationMode: 'combined' | 'separate' = 'combined', edition: WinRateEdition = 'general', league = 'MASTER',
): WinRateDatasetDescriptor {
  const id = `${edition}-${month}-${league.toLowerCase()}-${operationMode}`
  return { edition, id, month, league, operationMode, path: `${id}.json`, capturedAt }
}

function manifest(datasets: WinRateDatasetDescriptor[]): WinRateManifest {
  return { schemaVersion: 1, generatedAt: capturedAt, source, datasets }
}

function selection(overrides: Partial<WinRateHistorySelection> = {}): WinRateHistorySelection {
  return {
    edition: 'general', league: 'MASTER', controlType: 'combined',
    fromMonth: '2026-01', toMonth: '2026-01', ...overrides,
  }
}

interface FixtureCharacter {
  id: string
  text: string
  lowSample?: boolean
  controlType?: WinRateControlType
  name?: string
}

function dataset(desc: WinRateDatasetDescriptor, characters: FixtureCharacter[]): WinRateDataset {
  const fighters = characters.map((character, index) => ({
    id: `slot-${index}`, characterId: character.id, name: character.name ?? character.id.toUpperCase(),
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
    // Matchup cells deliberately disagree with Total, and rows deliberately have another order.
    rows: fighters.map((fighter, index) => ({
      fighterId: fighter.id,
      total: { text: characters[index].text, lowSample: characters[index].lowSample ?? false },
      cells: fighters.map(() => ({ text: '0.000', lowSample: false })),
    })).reverse(),
  }
}

function ready(desc: WinRateDatasetDescriptor, characters: FixtureCharacter[]): HistoryDatasetResult {
  return { month: desc.month, descriptor: desc, status: 'ready', dataset: dataset(desc, characters) }
}

test('月別はキャラを等重みとし、平均・中央値・N除算の標準偏差を公式Totalから計算する', () => {
  const desc = descriptor('2026-01')
  const result = ready(desc, [
    { id: 'ryu', text: '4.000' }, { id: 'ken', text: '5.000' }, { id: 'cammy', text: '6.000' },
  ])
  const input = manifest([desc])
  const before = structuredClone({ input, result })
  const output = createMonthlyWinRateStatistics(input, selection(), [result], 'monthly')
  assert.equal(output.mode, 'monthly')
  assert.equal(output.commonUnavailable, false)
  assert.equal(output.commonCharacterCount, 3)
  const [row] = output.rows
  assert.equal(row.status, 'ready')
  assert.equal(row.listedCount, 3)
  assert.equal(row.validCount, 3)
  assert.equal(row.excludedMissingCount, 0)
  assert.equal(row.excludedLowSampleCount, 0)
  assert.equal(row.excludedNonCommonCount, 0)
  assert.deepEqual(row.characterIds, ['ryu', 'ken', 'cammy'])
  assert.equal(row.statistics?.meanPercent, 50)
  assert.equal(row.statistics?.medianPercent, 50)
  assert.ok(Math.abs(row.statistics!.standardDeviationPoints! - Math.sqrt(200 / 3)) < 1e-12)
  assert.equal(row.statistics?.minimumPercent, 40)
  assert.equal(row.statistics?.maximumPercent, 60)
  assert.equal(row.capturedAt, capturedAt)
  assert.deepEqual(row.source, result.status === 'ready' ? result.dataset.source : null)
  assert.deepEqual({ input, result }, before)
})

test('公開小数を計算前に丸めず、偶数件の中央値を中央2値の平均とする', () => {
  const desc = descriptor('2026-01')
  const output = createMonthlyWinRateStatistics(manifest([desc]), selection(), [ready(desc, [
    { id: 'ryu', text: '5.030' }, { id: 'ken', text: '5.031' },
  ])], 'monthly')
  const stats = output.rows[0].statistics!
  assert.equal(stats.meanPercent, 50.305)
  assert.equal(stats.medianPercent, 50.305)
  assert.equal(stats.standardDeviationPoints, 0.005)
  assert.equal(formatMonthlyStatistic(stats.medianPercent), '50.31')
  assert.equal(formatMonthlyStatistic(stats.standardDeviationPoints), '0.01')
})

test('欠損2形式と少数試合を常に除外し、真の0%を有効値として保つ', () => {
  const desc = descriptor('2026-01')
  const [row] = createMonthlyWinRateStatistics(manifest([desc]), selection(), [ready(desc, [
    { id: 'ryu', text: '0.000' }, { id: 'ken', text: '-' },
    { id: 'cammy', text: '-.---', lowSample: true }, { id: 'chunli', text: '10.000', lowSample: true },
  ])], 'monthly').rows
  assert.equal(row.listedCount, 4)
  assert.equal(row.validCount, 1)
  assert.equal(row.excludedMissingCount, 2)
  assert.equal(row.excludedLowSampleCount, 1)
  assert.deepEqual(row.characterIds, ['ryu'])
  assert.deepEqual(row.statistics, {
    meanPercent: 0, medianPercent: 0, standardDeviationPoints: null, minimumPercent: 0, maximumPercent: 0,
  })
})

test('有効0件は全統計量nullで、複数の同値は標準偏差0となる', () => {
  const jan = descriptor('2026-01')
  const feb = descriptor('2026-02')
  const output = createMonthlyWinRateStatistics(manifest([feb, jan]), selection({ toMonth: feb.month }), [
    ready(jan, [{ id: 'ryu', text: '-' }, { id: 'ken', text: '5.000', lowSample: true }]),
    ready(feb, [{ id: 'ryu', text: '4.500' }, { id: 'ken', text: '4.500' }]),
  ], 'monthly')
  assert.equal(output.rows[0].validCount, 0)
  assert.deepEqual(output.rows[0].statistics, {
    meanPercent: null, medianPercent: null, standardDeviationPoints: null, minimumPercent: null, maximumPercent: null,
  })
  assert.equal(output.rows[1].statistics?.meanPercent, 45)
  assert.equal(output.rows[1].statistics?.standardDeviationPoints, 0)
})

test('共通キャラは安定IDで全暦月の有効集合を交差させ、新規掲載・欠損・少数を期間全体から除外する', () => {
  const jan = descriptor('2026-01')
  const feb = descriptor('2026-02')
  const mar = descriptor('2026-03')
  const results = [
    ready(jan, [
      { id: 'ryu', text: '4.000', name: '旧表記' }, { id: 'ken', text: '6.000' }, { id: 'cammy', text: '7.000' },
    ]),
    ready(feb, [
      { id: 'ken', text: '-' }, { id: 'ryu', text: '5.000', name: '新表記' },
      { id: 'cammy', text: '7.000', lowSample: true }, { id: 'terry', text: '8.000' },
    ]),
    ready(mar, [
      { id: 'ryu', text: '6.000' }, { id: 'ken', text: '6.000' }, { id: 'cammy', text: '7.000' }, { id: 'terry', text: '8.000' },
    ]),
  ]
  const input = manifest([mar, feb, jan])
  const selected = selection({ toMonth: mar.month })
  const monthly = createMonthlyWinRateStatistics(input, selected, results, 'monthly')
  assert.deepEqual(monthly.rows.map(({ listedCount, validCount }) => [listedCount, validCount]), [[3, 3], [4, 2], [4, 4]])
  const common = createMonthlyWinRateStatistics(input, selected, results, 'common')
  assert.equal(common.commonCharacterCount, 1)
  assert.equal(common.commonUnavailable, false)
  assert.deepEqual(common.rows.map(({ characterIds }) => characterIds), [['ryu'], ['ryu'], ['ryu']])
  assert.deepEqual(common.rows.map(({ validCount }) => validCount), [1, 1, 1])
  assert.deepEqual(common.rows.map(({ excludedNonCommonCount }) => excludedNonCommonCount), [2, 1, 3])
  assert.deepEqual(common.rows.map(({ statistics }) => statistics?.meanPercent), [40, 50, 60])
  assert.equal(common.rows[1].excludedMissingCount, 1)
  assert.equal(common.rows[1].excludedLowSampleCount, 1)
  for (const row of common.rows) {
    assert.equal(row.listedCount, row.validCount! + row.excludedMissingCount! + row.excludedLowSampleCount! + row.excludedNonCommonCount!)
  }
  const shortened = createMonthlyWinRateStatistics(input, selection(), results, 'common')
  assert.equal(shortened.commonCharacterCount, 3)
})

test('共通集合が空でも取得完了と区別し、キャラ数0と統計量nullを返す', () => {
  const jan = descriptor('2026-01')
  const feb = descriptor('2026-02')
  const output = createMonthlyWinRateStatistics(manifest([jan, feb]), selection({ toMonth: feb.month }), [
    ready(jan, [{ id: 'ryu', text: '5.000' }]), ready(feb, [{ id: 'ken', text: '5.000' }]),
  ], 'common')
  assert.equal(output.commonUnavailable, false)
  assert.equal(output.commonCharacterCount, 0)
  assert.ok(output.rows.every((row) => row.status === 'ready' && row.validCount === 0 && row.statistics?.meanPercent === null))
})

test('未登録月や失敗月がある期間は共通集計を未完了とし、各月集計の成功分は保持する', () => {
  const nov = descriptor('2025-11')
  const jan = descriptor('2026-01')
  const feb = descriptor('2026-02')
  const results: HistoryDatasetResult[] = [
    ready(nov, [{ id: 'ryu', text: '5.000' }, { id: 'ken', text: '-' }]),
    { month: jan.month, descriptor: jan, status: 'error' },
    ready(feb, [{ id: 'ryu', text: '6.000' }]),
  ]
  const input = manifest([feb, jan, nov])
  const selected = selection({ fromMonth: nov.month, toMonth: feb.month })
  const common = createMonthlyWinRateStatistics(input, selected, results, 'common')
  assert.deepEqual(common.rows.map(({ month, status }) => [month, status]), [
    ['2025-11', 'incomplete'], ['2025-12', 'unavailable'], ['2026-01', 'error'], ['2026-02', 'incomplete'],
  ])
  assert.equal(common.commonUnavailable, true)
  assert.equal(common.commonCharacterCount, null)
  assert.equal(common.rows[0].listedCount, 2)
  assert.equal(common.rows[0].excludedMissingCount, 1)
  assert.equal(common.rows[0].excludedLowSampleCount, 0)
  assert.equal(common.rows[0].capturedAt, capturedAt)
  assert.ok(common.rows.every((row) => row.validCount === null && row.excludedNonCommonCount === null && row.statistics === null))
  assert.ok(common.rows.every((row) => row.characterIds.length === 0))
  assert.ok(common.rows.slice(1, 3).every((row) => row.listedCount === null && row.source === null))
  const monthly = createMonthlyWinRateStatistics(input, selected, results, 'monthly')
  assert.deepEqual(monthly.rows.map(({ status }) => status), ['ready', 'unavailable', 'error', 'ready'])
  assert.deepEqual(monthly.rows.map(({ statistics }) => statistics?.meanPercent ?? null), [50, null, null, 60])
})

test('全結果が失敗でも空rosterから全暦月の登録状態を返す', () => {
  const jan = descriptor('2026-01')
  const mar = descriptor('2026-03')
  const input = manifest([jan, mar])
  for (const results of [[], [{ month: jan.month, descriptor: jan, status: 'error' }]] as HistoryDatasetResult[][]) {
    const output = createMonthlyWinRateStatistics(input, selection({ toMonth: mar.month }), results, 'common')
    assert.deepEqual(output.rows.map(({ status }) => status), ['error', 'unavailable', 'error'])
    assert.equal(output.commonUnavailable, true)
    assert.ok(output.rows.every((row) => row.listedCount === null && row.statistics === null))
  }
})

test('操作タイプを安定IDで選び、違うリーグ・版・操作モードを代用しない', async () => {
  const separate = descriptor('2026-01', 'separate')
  const combined = descriptor('2026-01')
  const gold = descriptor('2026-01', 'separate', 'general', 'GOLD')
  const master = descriptor('2026-01', 'combined', 'master')
  const input = manifest([combined, gold, separate, master])
  const values: FixtureCharacter[] = [
    { id: 'ryu', text: '0.000', controlType: 'classic' },
    { id: 'ryu', text: '10.000', controlType: 'modern' },
    { id: 'ken', text: '4.200', controlType: 'classic', name: 'RYU' },
    { id: 'ken', text: '6.100', controlType: 'modern', name: 'RYU' },
  ]
  for (const [controlType, expected] of [['classic', 21], ['modern', 80.5]] as const) {
    const selected = selection({ controlType })
    const calls: string[] = []
    const results = await loadWinRateHistory(input, selected, async (desc) => {
      calls.push(desc.id)
      return dataset(desc, values)
    })
    assert.deepEqual(calls, [separate.id])
    const [row] = createMonthlyWinRateStatistics(input, selected, results, 'monthly').rows
    assert.equal(row.listedCount, 2)
    assert.equal(row.validCount, 2)
    assert.equal(row.statistics?.meanPercent, expected)
  }
  const results = [ready(combined, [{ id: 'ryu', text: '4.000' }]), ready(master, [{ id: 'ryu', text: '6.000' }])]
  for (const [edition, expected] of [['general', 40], ['master', 60]] as const) {
    const selected = selection({ edition })
    // Pass only the selected loader results: the existing history validator rejects duplicate months.
    const [row] = createMonthlyWinRateStatistics(input, selected, results.filter((result) => result.descriptor.edition === edition), 'monthly').rows
    assert.equal(row.statistics?.meanPercent, expected)
    assert.equal(row.source?.url, WIN_RATE_EDITION_SOURCES[edition].url)
  }
  const absent = createMonthlyWinRateStatistics(input, selection({ league: 'ROOKIE' }), results, 'monthly')
  assert.equal(absent.rows[0].status, 'unavailable')
})

test('古いdescriptor・重複結果・違うラベル・壊れたdatasetを既存履歴検証で失敗にする', () => {
  const desc = descriptor('2026-01')
  const value = ready(desc, [{ id: 'ryu', text: '5.000' }])
  const stale = { ...desc, capturedAt: '2026-10-09T00:00:00.000Z' }
  const malformed = structuredClone(value)
  if (malformed.status === 'ready') malformed.dataset.rows[0].cells = []
  const noFighters = structuredClone(value)
  if (noFighters.status === 'ready') noFighters.dataset.fighters = []
  for (const results of [
    [ready(stale, [{ id: 'ryu', text: '5.000' }])], [value, value],
    [{ ...value, month: '2026-02' }], [malformed], [noFighters],
    [ready(descriptor('2026-01', 'combined', 'master'), [{ id: 'ryu', text: '5.000' }])],
  ]) {
    const output = createMonthlyWinRateStatistics(manifest([desc]), selection(), results, 'monthly')
    assert.equal(output.rows[0].status, 'error')
    assert.equal(output.rows[0].statistics, null)
    assert.equal(output.rows[0].source, null)
  }
})

test('不正な期間・条件・集計modeを結果なしでも拒否する', () => {
  for (const selected of [
    selection({ fromMonth: '2026-13' }), selection({ fromMonth: '2026-02' }),
    selection({ controlType: 'separate' as never }), selection({ edition: 'master', controlType: 'classic' }),
    selection({ league: 'unknown' }),
  ]) assert.throws(() => createMonthlyWinRateStatistics(manifest([]), selected, [], 'monthly'))
  assert.throws(() => createMonthlyWinRateStatistics(manifest([]), selection(), [], 'unknown' as never))
  const desc = descriptor('2026-01')
  assert.throws(() => createMonthlyWinRateStatistics(manifest([desc, { ...desc, id: 'duplicate' }]), selection(), [], 'monthly'), /重複/)
})

test('表示だけ小数2桁half-upにし、算出不可・境界・負の0を安定表示する', () => {
  for (const [value, expected] of [
    [null, '算出できません'], [0, '0.00'], [100, '100.00'], [50.305, '50.31'],
    [1.005, '1.01'], [50.3049, '50.30'], [0.005, '0.01'], [-0, '0.00'], [-1.005, '-1.01'],
    [Number.NaN, '算出できません'], [Number.POSITIVE_INFINITY, '算出できません'],
  ] as const) assert.equal(formatMonthlyStatistic(value), expected)
})
