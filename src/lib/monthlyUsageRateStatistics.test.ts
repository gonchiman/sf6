import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createMonthlyUsageRateStatistics } from './monthlyUsageRateStatistics.ts'
import { parseUsageRateManifest, USAGE_RATE_EDITION_SOURCES } from './usageRates.ts'
import type { MonthlyUsageRateStatisticsSelection } from '../types/monthlyUsageRateStatistics.ts'
import type {
  UsageRateControlType, UsageRateDataset, UsageRateDatasetDescriptor, UsageRateEntry,
  UsageRateHistoryResult, UsageRateManifest,
} from '../types/usageRates.ts'

const capturedAt = '2026-10-15T00:00:00.000Z'
const generatedAt = '2026-10-15T00:01:00.000Z'

function descriptor(month = '2026-01', league = 'MASTER', edition: 'general' | 'master' = 'general'): UsageRateDatasetDescriptor {
  const id = `${edition}-${month}-${league.toLowerCase()}`
  return { edition, id, month, league, path: `${id}.json`, capturedAt }
}

function entry(characterId: string, value: number | null, text?: string): UsageRateEntry {
  return { characterId, name: characterId.toUpperCase(), percentThousandths: value, text: text ?? (value === null ? '-' : (value / 1000).toFixed(3)) }
}

function dataset(desc = descriptor(), entries = [entry('ryu', 40000), entry('ken', 60000)]): UsageRateDataset {
  const controls: UsageRateControlType[] = desc.edition === 'master' ? ['all'] : ['all', 'classic', 'modern']
  return {
    schemaVersion: 1, edition: desc.edition, id: desc.id, month: desc.month, league: desc.league,
    capturedAt: desc.capturedAt, generatedAt,
    source: { ...USAGE_RATE_EDITION_SOURCES[desc.edition ?? 'general'], population: '公式ランクマッチ統計', metric: 'キャラクター使用率', unit: '公開された割合（%）', notes: ['件数は非公開'] },
    distributions: controls.map(controlType => ({ controlType, month: desc.month, league: desc.league, entries: entries.map(item => ({ ...item })) })),
  }
}

function manifest(descriptors = [descriptor()]): UsageRateManifest {
  return { schemaVersion: 1, generatedAt, source: USAGE_RATE_EDITION_SOURCES.general, datasets: descriptors }
}

function selection(overrides: Partial<MonthlyUsageRateStatisticsSelection> = {}): MonthlyUsageRateStatisticsSelection {
  return { edition: 'general', league: 'MASTER', controlType: 'combined', fromMonth: '2026-01', toMonth: '2026-01', ...overrides }
}

function ready(desc = descriptor(), input = dataset(desc)): UsageRateHistoryResult {
  return { month: desc.month, descriptor: desc, status: 'ready', dataset: input }
}

test('公開使用率をキャラ等重み・N除算で集計し、0.001%精度と出典を保つ', () => {
  const desc = descriptor()
  const observation = ready(desc, dataset(desc, [entry('ryu', 20000), entry('ken', 30000), entry('cammy', 50000)]))
  const input = manifest([desc])
  const before = structuredClone({ input, observation })
  const output = createMonthlyUsageRateStatistics(input, selection(), [observation], 'monthly')
  const [row] = output.rows
  assert.equal(row.status, 'ready')
  assert.equal(row.listedCount, 3)
  assert.equal(row.validCount, 3)
  assert.equal(row.excludedMissingCount, 0)
  assert.equal(row.excludedNonCommonCount, 0)
  assert.deepEqual(row.characterIds, ['ryu', 'ken', 'cammy'])
  assert.equal(row.publishedTotalPercent, 100)
  assert.equal(row.statistics?.meanPercent, 100 / 3)
  assert.equal(row.statistics?.medianPercent, 30)
  assert.ok(Math.abs(row.statistics!.standardDeviationPoints! - Math.sqrt(1400 / 9)) < 1e-12)
  assert.equal(row.statistics?.minimumPercent, 20)
  assert.equal(row.statistics?.maximumPercent, 50)
  assert.equal(row.capturedAt, capturedAt)
  assert.equal(row.generatedAt, generatedAt)
  assert.equal(row.source?.url, USAGE_RATE_EDITION_SOURCES.general.url)
  assert.equal('excludedLowSampleCount' in row, false)
  assert.equal(output.commonCharacterCount, 3)
  assert.deepEqual({ input, observation }, before)
})

test('計算前に丸めず、偶数件の中央値を中央2値の平均とする', () => {
  const desc = descriptor()
  const [row] = createMonthlyUsageRateStatistics(manifest(), selection(), [ready(desc, dataset(desc, [entry('ryu', 49999), entry('ken', 50001)]))], 'monthly').rows
  assert.deepEqual(row.statistics, { meanPercent: 50, medianPercent: 50, standardDeviationPoints: 0.001, minimumPercent: 49.999, maximumPercent: 50.001, coefficientOfVariation: 0.001 / 50 })
})

test('欠損2形式は除外し、実際の0%は残し、有効0件と1件のSDを区別する', () => {
  const desc = descriptor()
  const zero = dataset(desc, [entry('ryu', 0), entry('ken', null), entry('cammy', null, '-.---')])
  const [row] = createMonthlyUsageRateStatistics(manifest(), selection(), [ready(desc, zero)], 'monthly').rows
  assert.equal(row.listedCount, 3)
  assert.equal(row.validCount, 1)
  assert.equal(row.excludedMissingCount, 2)
  assert.equal(row.publishedTotalPercent, 0)
  assert.deepEqual(row.characterIds, ['ryu'])
  assert.deepEqual(row.statistics, { meanPercent: 0, medianPercent: 0, standardDeviationPoints: null, minimumPercent: 0, maximumPercent: 0, coefficientOfVariation: null })
  const missing = dataset(desc, [entry('ryu', null), entry('ken', null, '-.---')])
  const [empty] = createMonthlyUsageRateStatistics(manifest(), selection(), [ready(desc, missing)], 'monthly').rows
  assert.equal(empty.validCount, 0)
  assert.equal(empty.publishedTotalPercent, null)
  assert.deepEqual(empty.statistics, { meanPercent: null, medianPercent: null, standardDeviationPoints: null, minimumPercent: null, maximumPercent: null, coefficientOfVariation: null })
  const [equal] = createMonthlyUsageRateStatistics(manifest(), selection(), [ready(desc, dataset(desc, [entry('ryu', 50000), entry('ken', 50000)]))], 'monthly').rows
  assert.equal(equal.statistics?.standardDeviationPoints, 0)
  assert.equal(equal.statistics?.coefficientOfVariation, 0)
})

test('C/Mは独立分布の掲載数で集計し、未掲載キャラを0で補わない', () => {
  const desc = descriptor()
  const input = dataset(desc)
  input.distributions[1].entries = [entry('ken', 100000)]
  input.distributions[2].entries = [entry('ryu', 0), entry('cammy', 50000), entry('ken', 50000)]
  const classic = createMonthlyUsageRateStatistics(manifest(), selection({ controlType: 'classic' }), [ready(desc, input)], 'monthly').rows[0]
  const modern = createMonthlyUsageRateStatistics(manifest(), selection({ controlType: 'modern' }), [ready(desc, input)], 'monthly').rows[0]
  assert.equal(classic.validCount, 1)
  assert.equal(classic.statistics?.meanPercent, 100)
  assert.equal(classic.statistics?.standardDeviationPoints, null)
  assert.equal(classic.statistics?.coefficientOfVariation, null)
  assert.deepEqual(classic.characterIds, ['ken'])
  assert.equal(modern.validCount, 3)
  assert.equal(modern.statistics?.meanPercent, 100 / 3)
  assert.equal(modern.statistics?.minimumPercent, 0)
  assert.equal(createMonthlyUsageRateStatistics(manifest(), selection(), [ready(desc, input)], 'monthly').rows[0].validCount, 2)
})

test('共通キャラは全暦月の有効IDの交差とし、掲載名変更や配列順に依存せず、再正規化しない', () => {
  const jan = descriptor('2026-01')
  const feb = descriptor('2026-02')
  const mar = descriptor('2026-03')
  const febData = dataset(feb, [entry('cammy', 30000), entry('ken', 30000), entry('ryu', 40000)])
  febData.distributions[0].entries[2].name = '別名'
  const results = [ready(mar, dataset(mar, [entry('ken', null), entry('ryu', 10000), entry('cammy', 90000)])), ready(jan, dataset(jan, [entry('ryu', 50000), entry('ken', 50000)])), ready(feb, febData)]
  const selected = selection({ toMonth: mar.month })
  const common = createMonthlyUsageRateStatistics(manifest([mar, jan, feb]), selected, results, 'common')
  assert.equal(common.commonCharacterCount, 1)
  assert.equal(common.commonUnavailable, false)
  assert.deepEqual(common.rows.map(row => row.month), [jan.month, feb.month, mar.month])
  assert.deepEqual(common.rows.map(row => row.characterIds), [['ryu'], ['ryu'], ['ryu']])
  assert.deepEqual(common.rows.map(row => row.statistics?.meanPercent), [50, 40, 10])
  assert.deepEqual(common.rows.map(row => row.excludedNonCommonCount), [1, 2, 1])
  assert.deepEqual(common.rows.map(row => row.publishedTotalPercent), [100, 100, 100])
  assert.deepEqual(createMonthlyUsageRateStatistics(manifest([jan, feb, mar]), selected, results, 'monthly').rows.map(row => row.validCount), [2, 3, 2])
})

test('共通IDが空なら全月0キャラ・統計量nullとし、集計不能と0%を混同しない', () => {
  const jan = descriptor('2026-01')
  const feb = descriptor('2026-02')
  const output = createMonthlyUsageRateStatistics(manifest([jan, feb]), selection({ toMonth: feb.month }), [ready(jan, dataset(jan, [entry('ryu', 100000)])), ready(feb, dataset(feb, [entry('ken', 100000)]))], 'common')
  assert.equal(output.commonCharacterCount, 0)
  assert.equal(output.commonUnavailable, false)
  assert.ok(output.rows.every(row => row.status === 'ready' && row.validCount === 0 && row.statistics?.meanPercent === null))
})

test('未登録・取得失敗・結果不足は暦月を保ち、共通キャラを確定できない全月を集計不能にする', () => {
  const jan = descriptor('2026-01')
  const mar = descriptor('2026-03')
  const apr = descriptor('2026-04')
  const input = manifest([jan, mar, apr])
  const results: UsageRateHistoryResult[] = [ready(jan), { month: mar.month, status: 'error', descriptor: mar }]
  const selected = selection({ toMonth: apr.month })
  const monthly = createMonthlyUsageRateStatistics(input, selected, results, 'monthly')
  assert.deepEqual(monthly.rows.map(row => row.status), ['ready', 'unavailable', 'error', 'error'])
  assert.equal(monthly.commonCharacterCount, null)
  assert.equal(monthly.commonUnavailable, true)
  assert.deepEqual(monthly.rows.map(row => row.statistics?.coefficientOfVariation ?? null), [0.2, null, null, null])
  const common = createMonthlyUsageRateStatistics(input, selected, results, 'common')
  assert.deepEqual(common.rows.map(row => row.status), ['incomplete', 'unavailable', 'error', 'error'])
  assert.ok(common.rows.every(row => row.statistics === null && row.validCount === null))
  assert.equal(common.rows[0].publishedTotalPercent, 100)
  assert.equal(common.rows[0].capturedAt, capturedAt)
  assert.equal(common.rows[1].capturedAt, null)
})

test('CVは無単位のSD/平均とし、集中した分布で1以上も切り捨てず返す', () => {
  const desc = descriptor()
  const two = dataset(desc, [entry('ryu', 100000), entry('ken', 0)])
  const four = dataset(desc, [entry('ryu', 100000), entry('ken', 0), entry('cammy', 0), entry('luke', 0)])
  const twoStats = createMonthlyUsageRateStatistics(manifest(), selection(), [ready(desc, two)], 'monthly').rows[0].statistics!
  const fourStats = createMonthlyUsageRateStatistics(manifest(), selection(), [ready(desc, four)], 'monthly').rows[0].statistics!
  assert.equal(twoStats.coefficientOfVariation, 1)
  assert.ok(Math.abs(fourStats.coefficientOfVariation! - Math.sqrt(3)) < 1e-12)
  assert.equal(twoStats.meanPercent, 50)
  assert.equal(fourStats.meanPercent, 25)
})

test('部分掲載の有効使用率を一律倍してもCVは変わらず、公表値の合計を補正しない', () => {
  const desc = descriptor()
  const original = dataset(desc, [entry('ryu', 10000), entry('ken', 30000), entry('cammy', null)])
  const doubled = dataset(desc, [entry('ryu', 20000), entry('ken', 60000), entry('cammy', null)])
  const [first, second] = [original, doubled].map(input => createMonthlyUsageRateStatistics(manifest(), selection(), [ready(desc, input)], 'monthly').rows[0])
  assert.equal(first.statistics?.coefficientOfVariation, 0.5)
  assert.equal(second.statistics?.coefficientOfVariation, 0.5)
  assert.deepEqual([first.publishedTotalPercent, second.publishedTotalPercent], [40, 80])
  assert.deepEqual([first.statistics?.meanPercent, second.statistics?.meanPercent], [20, 40])
  assert.deepEqual([first.excludedMissingCount, second.excludedMissingCount], [1, 1])
})

test('平均0はSD0でもCVを算出せず、真の0%・欠損をそのまま保つ', () => {
  const desc = descriptor()
  const input = dataset(desc, [entry('ryu', 0), entry('ken', 0), entry('cammy', null)])
  const [row] = createMonthlyUsageRateStatistics(manifest(), selection(), [ready(desc, input)], 'monthly').rows
  assert.equal(row.validCount, 2)
  assert.equal(row.statistics?.meanPercent, 0)
  assert.equal(row.statistics?.standardDeviationPoints, 0)
  assert.equal(row.statistics?.coefficientOfVariation, null)
  assert.equal(row.excludedMissingCount, 1)
})

test('共通キャラのCVは100/Nで代用せず、実際の部分集合のSDと平均から計算する', () => {
  const jan = descriptor('2026-01')
  const feb = descriptor('2026-02')
  const output = createMonthlyUsageRateStatistics(manifest([jan, feb]), selection({ toMonth: feb.month }), [
    ready(jan, dataset(jan, [entry('ryu', 10000), entry('ken', 30000), entry('cammy', 60000)])),
    ready(feb, dataset(feb, [entry('ryu', 20000), entry('ken', 60000), entry('luke', 20000)])),
  ], 'common')
  assert.equal(output.commonCharacterCount, 2)
  assert.deepEqual(output.rows.map(row => row.characterIds), [['ryu', 'ken'], ['ryu', 'ken']])
  assert.deepEqual(output.rows.map(row => row.statistics?.meanPercent), [20, 40])
  assert.deepEqual(output.rows.map(row => row.statistics?.standardDeviationPoints), [10, 20])
  assert.deepEqual(output.rows.map(row => row.statistics?.coefficientOfVariation), [0.5, 0.5])
  assert.deepEqual(output.rows.map(row => row.publishedTotalPercent), [100, 100])
})

test('重複・古いdescriptor・別版やリーグ・出典違い・破損データを有効値へ混ぜない', () => {
  const desc = descriptor()
  const good = ready(desc)
  const stale = ready({ ...desc, path: 'stale.json' })
  const wrongDate = dataset(desc)
  wrongDate.capturedAt = '2026-10-14T00:00:00.000Z'
  const wrongSource = dataset(desc)
  wrongSource.source.url = USAGE_RATE_EDITION_SOURCES.master.url
  const badValue = dataset(desc)
  badValue.distributions[0].entries[0].percentThousandths = 123
  const injected = ready(descriptor(desc.month, 'GOLD'))
  const wrongEdition = ready(descriptor(desc.month, 'MASTER', 'master'))
  for (const observations of [[good, good], [stale], [ready(desc, wrongDate)], [ready(desc, wrongSource)], [ready(desc, badValue)], [injected], [wrongEdition]]) {
    const [row] = createMonthlyUsageRateStatistics(manifest(), selection(), observations, 'monthly').rows
    assert.equal(row.status, 'error')
    assert.equal(row.statistics, null)
    assert.equal(row.publishedTotalPercent, null)
  }
})

test('版・リーグ・操作タイプ・期間・重複manifest・集計モードの不正を拒否する', () => {
  for (const selected of [selection({ edition: 'unknown' as never }), selection({ league: 'UNKNOWN' }), selection({ controlType: 'all' as never }), selection({ edition: 'master', controlType: 'modern' }), selection({ fromMonth: '2026-13' }), selection({ toMonth: '2025-12' })]) {
    assert.throws(() => createMonthlyUsageRateStatistics(manifest(), selected, [], 'monthly'))
  }
  const desc = descriptor()
  assert.throws(() => createMonthlyUsageRateStatistics(manifest([desc, { ...desc, id: 'duplicate' }]), selection(), [], 'monthly'))
  assert.throws(() => createMonthlyUsageRateStatistics(manifest(), selection(), [], 'unknown' as never), /集計対象/)
})

async function published(month: string, league: string, edition: 'general' | 'master' = 'general') {
  const input = parseUsageRateManifest(JSON.parse(await readFile(new URL('../../public/data/usage-rates/index.json', import.meta.url), 'utf8')))
  const desc = input.datasets.find(item => item.month === month && item.league === league && (item.edition ?? 'general') === edition)!
  const data = JSON.parse(await readFile(new URL(`../../public/data/usage-rates/${desc.path}`, import.meta.url), 'utf8')) as UsageRateDataset
  return { input, desc, result: ready(desc, data) }
}

test('公開MASTER最新月の31キャラの平均・中央値・SDを原値から再現する', async () => {
  const { input, desc, result } = await published('2026-09', 'MASTER')
  const [row] = createMonthlyUsageRateStatistics(input, selection({ fromMonth: desc.month, toMonth: desc.month }), [result], 'monthly').rows
  assert.equal(row.status, 'ready')
  assert.equal(row.validCount, 31)
  assert.equal(row.publishedTotalPercent, 99.999)
  assert.equal(row.statistics?.meanPercent, 99999 / 31 / 1000)
  assert.equal(row.statistics?.medianPercent, 2.848)
  assert.ok(Math.abs(row.statistics!.standardDeviationPoints! - 1.9971648567758442) < 1e-12)
  assert.ok(Math.abs(row.statistics!.coefficientOfVariation! - 0.6191272968734804) < 1e-12)
  assert.equal(row.statistics?.minimumPercent, 0.798)
  assert.equal(row.statistics?.maximumPercent, 9.566)
})

test('公式確認済み合計100.135%を補正せず保持し、モダンの掲載16キャラで別集計する', async () => {
  const { input, desc, result } = await published('2023-06', 'MASTER')
  const selected = selection({ fromMonth: desc.month, toMonth: desc.month })
  const [combined] = createMonthlyUsageRateStatistics(input, selected, [result], 'monthly').rows
  assert.equal(combined.validCount, 18)
  assert.equal(combined.publishedTotalPercent, 100.135)
  assert.equal(combined.statistics?.meanPercent, 100135 / 18 / 1000)
  assert.equal(combined.totalMismatch?.observedPercentThousandths, 100135)
  const [modern] = createMonthlyUsageRateStatistics(input, { ...selected, controlType: 'modern' }, [result], 'monthly').rows
  assert.equal(modern.validCount, 16)
  assert.equal(modern.listedCount, 16)
  assert.equal(modern.publishedTotalPercent, 100.001)
  assert.equal(modern.statistics?.meanPercent, 100001 / 16 / 1000)
  assert.equal(modern.totalMismatch, undefined)
})

test('公開マスター版の同月MASTER値を総合版MASTERで代用しない', async () => {
  const { input, desc, result } = await published('2026-09', 'MASTER', 'master')
  const selected = selection({ edition: 'master', fromMonth: desc.month, toMonth: desc.month })
  const [row] = createMonthlyUsageRateStatistics(input, selected, [result], 'monthly').rows
  assert.equal(row.status, 'ready')
  assert.equal(row.source?.url, USAGE_RATE_EDITION_SOURCES.master.url)
  const general = await published(desc.month, 'MASTER')
  assert.equal(createMonthlyUsageRateStatistics(input, selected, [general.result], 'monthly').rows[0].status, 'error')
})
