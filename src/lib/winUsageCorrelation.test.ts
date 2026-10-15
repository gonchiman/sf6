import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  correlationConditions, correlationHistoryRequestKey, correlationMonths, createCorrelationHistory,
  initialCorrelationSelection, loadCorrelationHistory, pearsonCorrelation, spearmanCorrelation,
} from './winUsageCorrelation.ts'
import { WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import { USAGE_RATE_EDITION_SOURCES } from './usageRates.ts'
import type { CorrelationHistoryResults, CorrelationSelection } from '../types/winUsageCorrelation.ts'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateManifest } from '../types/winRates.ts'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateManifest } from '../types/usageRates.ts'

const capturedAt = '2026-10-15T00:00:00.000Z'
const generatedAt = '2026-10-15T00:01:00.000Z'
type WValue = { id: string; text: string; lowSample?: boolean }
type UValue = { id: string; value: number | null }
const wins: WValue[] = [{ id: 'ryu', text: '4.000' }, { id: 'ken', text: '5.000' }, { id: 'cammy', text: '6.000' }]
const usages: UValue[] = [{ id: 'ryu', value: 20000 }, { id: 'ken', value: 30000 }, { id: 'cammy', value: 50000 }]

function descriptors(month = '2026-01', edition: 'general' | 'master' = 'general', control: 'combined' | 'separate' = 'combined', league = 'MASTER') {
  const id = `${edition}-${month}-${league.toLowerCase()}`
  const win: WinRateDatasetDescriptor = { edition, id: `${id}-${control}`, month, league, operationMode: control, path: `${id}-${control}.json`, capturedAt }
  const usage: UsageRateDatasetDescriptor = { edition, id, month, league, path: `${id}.json`, capturedAt }
  return { win, usage }
}

function datasets(desc = descriptors(), ws: WValue[] = wins, us: UValue[] = usages) {
  const fighters = (desc.win.operationMode === 'combined' ? [null] as const : ['classic', 'modern'] as const)
    .flatMap(controlType => ws.map(item => ({ id: `${item.id}-${controlType ?? 'all'}`, characterId: item.id, name: item.id.toUpperCase(), controlType })))
  const win: WinRateDataset = {
    schemaVersion: 1, ...desc.win, generatedAt,
    source: { ...WIN_RATE_EDITION_SOURCES[desc.win.edition ?? 'general'], population: 'ランクマッチ', metric: '掲載値', notes: ['件数不明'] },
    fighters, rows: fighters.map((fighter, index) => ({ fighterId: fighter.id,
      total: { text: ws[index % ws.length].text, lowSample: ws[index % ws.length].lowSample ?? false },
      cells: fighters.map(() => ({ text: '5.000', lowSample: false })),
    })),
  }
  const usage: UsageRateDataset = {
    schemaVersion: 1, ...desc.usage, generatedAt,
    source: { ...USAGE_RATE_EDITION_SOURCES[desc.usage.edition ?? 'general'], population: 'ランクマッチ', metric: '使用率', unit: '%', notes: ['件数不明'] },
    distributions: (desc.usage.edition === 'master' ? ['all'] as const : ['all', 'classic', 'modern'] as const).map(controlType => ({
      controlType, month: desc.usage.month, league: desc.usage.league,
      entries: us.map(item => ({ characterId: item.id, name: item.id.toUpperCase(), text: item.value === null ? '-' : (item.value / 1000).toFixed(3), percentThousandths: item.value })),
    })),
  }
  return { win, usage }
}

function manifests(desc = [descriptors()]): { win: WinRateManifest; usage: UsageRateManifest } {
  return {
    win: { schemaVersion: 1, generatedAt, source: WIN_RATE_EDITION_SOURCES.general, datasets: desc.map(item => item.win) },
    usage: { schemaVersion: 1, generatedAt, source: USAGE_RATE_EDITION_SOURCES.general, datasets: desc.map(item => item.usage) },
  }
}

function selection(overrides: Partial<CorrelationSelection> = {}): CorrelationSelection {
  return { edition: 'general', league: 'MASTER', controlType: 'combined', fromMonth: '2026-01', toMonth: '2026-01', ...overrides }
}

function results(desc = descriptors(), data = datasets(desc)): CorrelationHistoryResults {
  return {
    winResults: [{ month: desc.win.month, descriptor: desc.win, status: 'ready', dataset: data.win }],
    usageResults: [{ month: desc.usage.month, descriptor: desc.usage, status: 'ready', dataset: data.usage }],
  }
}

function combinedResults(items: CorrelationHistoryResults[]): CorrelationHistoryResults {
  return { winResults: items.flatMap(item => item.winResults), usageResults: items.flatMap(item => item.usageResults) }
}

test('既知の正負・無相関を計算し、Spearmanは同順位の平均順位を使う', () => {
  assert.equal(pearsonCorrelation([1, 2, 3], [2, 4, 6]), 1)
  assert.equal(pearsonCorrelation([1, 2, 3], [6, 4, 2]), -1)
  assert.equal(pearsonCorrelation([1, 2, 3], [1, 0, 1]), 0)
  assert.ok(Math.abs(spearmanCorrelation([1, 1, 2, 3], [1, 2, 2, 3])! - 5 / 6) < 1e-12)
  assert.equal(spearmanCorrelation([3, 1, 2], [1, 3, 2]), -1)
})

test('3キャラ未満・定数・非有限・長さ不一致を係数0と混同しない', () => {
  for (const calculate of [pearsonCorrelation, spearmanCorrelation]) {
    assert.equal(calculate([], []), null)
    assert.equal(calculate([1, 2], [1, 2]), null)
    assert.equal(calculate([.1, .1, .1], [1, 2, 3]), null)
    assert.equal(calculate([1, 2, 3], [1, 1, 1]), null)
    assert.equal(calculate([1, NaN, 3], [1, 2, 3]), null)
    assert.equal(calculate([1, 2, 3], [1, 2, 3, 4]), null)
  }
})

test('両指標の登録条件だけを結合し、ALLや総合版とマスター版を混同しない', () => {
  const jan = descriptors()
  const feb = descriptors('2026-02')
  const separate = descriptors('2026-03', 'general', 'separate')
  const master = descriptors('2026-04', 'master')
  const input = manifests([jan, feb, separate, master])
  input.usage.datasets = [jan.usage, separate.usage, master.usage, descriptors('2026-05', 'general', 'combined', 'ALL').usage]
  const conditions = correlationConditions(input.win, input.usage)
  assert.deepEqual(conditions, [
    { edition: 'general', league: 'MASTER', controlType: 'combined', months: [jan.win.month] },
    { edition: 'general', league: 'MASTER', controlType: 'classic', months: [separate.win.month] },
    { edition: 'general', league: 'MASTER', controlType: 'modern', months: [separate.win.month] },
    { edition: 'master', league: 'MASTER', controlType: 'combined', months: [master.win.month] },
  ])
  assert.deepEqual(initialCorrelationSelection(input.win, input.usage), selection())
})

test('暦月の穴を残し、不正なリーグ・タイプ・期間・重複manifestを拒否する', () => {
  assert.deepEqual(correlationMonths(selection({ toMonth: '2026-03' })), ['2026-01', '2026-02', '2026-03'])
  for (const bad of [{ league: 'ALL' }, { edition: 'master', controlType: 'classic' }, { fromMonth: '2026-02' }, { toMonth: '2026-13' }]) {
    assert.throws(() => correlationMonths(selection(bad as Partial<CorrelationSelection>)))
  }
  const input = manifests()
  input.win.datasets.push(input.win.datasets[0])
  assert.throws(() => correlationConditions(input.win, input.usage))
})

test('公式Totalだけを%に換算しキャラ等重みで計算、精度と両出典を保存して入力を変更しない', () => {
  const input = manifests()
  const observations = results()
  if (observations.usageResults[0].status === 'ready') observations.usageResults[0].dataset.distributions[0].entries[0].name = 'リュウ'
  const before = structuredClone({ input, observations })
  const output = createCorrelationHistory(input.win, input.usage, selection(), observations, 'monthly')
  const row = output.rows[0]
  assert.equal(row.status, 'ready')
  assert.equal(row.listedCount, 3)
  assert.deepEqual(row.points, [
    { characterId: 'ryu', name: 'リュウ', winRate: 40, usageRate: 20 },
    { characterId: 'ken', name: 'KEN', winRate: 50, usageRate: 30 },
    { characterId: 'cammy', name: 'CAMMY', winRate: 60, usageRate: 50 },
  ])
  assert.equal(row.pearson, pearsonCorrelation([20, 30, 50], [40, 50, 60]))
  assert.equal(row.spearman, 1)
  assert.equal(row.winSource?.url, WIN_RATE_EDITION_SOURCES.general.url)
  assert.equal(row.usageSource?.url, USAGE_RATE_EDITION_SOURCES.general.url)
  assert.equal(row.winCapturedAt, capturedAt)
  assert.equal(row.usageCapturedAt, capturedAt)
  assert.equal(row.winGeneratedAt, generatedAt)
  assert.equal(row.usageGeneratedAt, generatedAt)
  assert.equal(row.usageTotalMismatch, null)
  assert.equal(row.usagePublishedTotal, 100)
  assert.deepEqual({ input, observations }, before)
})

test('安定IDの3種類の別名を結合し、重複する正規化後IDはfail closedにする', () => {
  const desc = descriptors()
  const ws: WValue[] = [{ id: 'honda', text: '4.001' }, { id: 'gouki', text: '5.002' }, { id: 'vega', text: '6.003' }]
  const us: UValue[] = [{ id: 'ehonda', value: 20001 }, { id: 'gouki_akuma', value: 30000 }, { id: 'vega_mbison', value: 49999 }]
  const input = manifests()
  const output = createCorrelationHistory(input.win, input.usage, selection(), results(desc, datasets(desc, ws, us)), 'monthly').rows[0]
  assert.deepEqual(output.points.map(item => item.characterId), ['honda', 'gouki', 'vega'])
  assert.equal(output.points[0].winRate, 40.01)
  assert.equal(output.points[0].usageRate, 20.001)
  const duplicateUsage = datasets(desc, ws, [{ id: 'honda', value: 50000 }, { id: 'ehonda', value: 50000 }])
  const failedUsage = createCorrelationHistory(input.win, input.usage, selection(), results(desc, duplicateUsage), 'monthly').rows[0]
  assert.equal(failedUsage.status, 'error')
  assert.equal(failedUsage.usageStatus, 'error')
  assert.equal(failedUsage.points.length, 0)
  const duplicateWin = datasets(desc, [...ws, { id: 'ehonda', text: '5.000' }], us)
  assert.equal(createCorrelationHistory(input.win, input.usage, selection(), results(desc, duplicateWin), 'monthly').rows[0].winStatus, 'error')
})

test('欠損・少数サンプル・片側未掲載を区別し0%を残す、除外数は和集合で確認できる', () => {
  const desc = descriptors()
  const ws: WValue[] = [{ id: 'ryu', text: '0.000' }, { id: 'ken', text: '-' }, { id: 'cammy', text: '6.000', lowSample: true }, { id: 'luke', text: '5.000' }]
  const us: UValue[] = [{ id: 'ryu', value: 0 }, { id: 'ken', value: null }, { id: 'cammy', value: 50000 }, { id: 'juri', value: 50000 }]
  const input = manifests()
  const row = createCorrelationHistory(input.win, input.usage, selection(), results(desc, datasets(desc, ws, us)), 'monthly').rows[0]
  assert.equal(row.listedCount, 5)
  assert.deepEqual(row.points, [{ characterId: 'ryu', name: 'RYU', winRate: 0, usageRate: 0 }])
  assert.deepEqual(row.exclusions.map(item => [item.characterId, item.reasons]), [
    ['ken', ['win-missing', 'usage-missing']], ['cammy', ['low-sample']], ['luke', ['usage-unlisted']], ['juri', ['win-unlisted']],
  ])
  assert.equal(row.pearson, null)
  assert.equal(row.unavailableReason, 'insufficient-characters')
})

test('公式再確認済みの合計不一致を選択タイプから保存し、生の割合を補正しない・勝率失敗時も残す', () => {
  const desc = descriptors()
  const input = manifests()
  const data = datasets(desc)
  const distribution = data.usage.distributions[0]
  distribution.entries[2] = { ...distribution.entries[2], text: '49.000', percentThousandths: 49000 }
  distribution.totalMismatch = { observedPercentThousandths: 99000, verifiedAt: capturedAt,
    sourceUrl: USAGE_RATE_EDITION_SOURCES.general.url, reason: '公式掲載値の合計を再確認。補正しない。' }
  const before = structuredClone(data)
  const row = createCorrelationHistory(input.win, input.usage, selection(), results(desc, data), 'monthly').rows[0]
  assert.equal(row.status, 'ready')
  assert.equal(row.usagePublishedTotal, 99)
  assert.deepEqual(row.usageTotalMismatch, distribution.totalMismatch)
  assert.deepEqual(row.points.map(point => point.usageRate), [20, 30, 49])
  assert.deepEqual(data, before)
  const observations = results(desc, data)
  observations.winResults = [{ month: desc.win.month, descriptor: desc.win, status: 'error' }]
  const failed = createCorrelationHistory(input.win, input.usage, selection(), observations, 'monthly').rows[0]
  assert.equal(failed.status, 'error')
  assert.equal(failed.usageStatus, 'ready')
  assert.equal(failed.usagePublishedTotal, 99)
  assert.deepEqual(failed.usageTotalMismatch, distribution.totalMismatch)
  assert.equal(failed.usageSource?.url, USAGE_RATE_EDITION_SOURCES.general.url)
})

test('3キャラ以上でも定数軸を区別して理由を返す', () => {
  const input = manifests()
  const desc = descriptors()
  const row = createCorrelationHistory(input.win, input.usage, selection(), results(desc, datasets(desc, wins.map(item => ({ ...item, text: '5.000' })))), 'monthly').rows[0]
  assert.equal(row.unavailableReason, 'constant-win-rate')
  assert.equal(row.pearson, null)
  const equalUsage = datasets(desc, wins, usages.map(item => ({ ...item, value: 33333 })))
  const constantUsage = createCorrelationHistory(input.win, input.usage, selection(), results(desc, equalUsage), 'monthly').rows[0]
  assert.equal(constantUsage.unavailableReason, 'constant-usage-rate')
})

test('C/Mは指定タイプだけを比較し、合算や他タイプで補わない', () => {
  const desc = descriptors('2026-01', 'general', 'separate')
  const input = manifests([desc])
  const data = datasets(desc)
  data.win.rows.slice(3).forEach(row => { row.total.text = '5.000' })
  data.usage.distributions[1].entries.reverse()
  const classic = createCorrelationHistory(input.win, input.usage, selection({ controlType: 'classic' }), results(desc, data), 'monthly').rows[0]
  const modern = createCorrelationHistory(input.win, input.usage, selection({ controlType: 'modern' }), results(desc, data), 'monthly').rows[0]
  assert.equal(classic.spearman, 1)
  assert.equal(modern.unavailableReason, 'constant-win-rate')
  assert.deepEqual(classic.points.map(point => point.winRate), [40, 50, 60])
})

test('共通キャラは全暦月の両指標が有効なIDの交差とし、再正規化しない', () => {
  const jan = descriptors()
  const feb = descriptors('2026-02')
  const input = manifests([feb, jan])
  const febData = datasets(feb, [...wins, { id: 'luke', text: '7.000' }], [{ id: 'ryu', value: 10000 }, { id: 'ken', value: 20000 }, { id: 'cammy', value: 30000 }, { id: 'luke', value: 40000 }])
  const observations = combinedResults([results(feb, febData), results(jan)])
  const output = createCorrelationHistory(input.win, input.usage, selection({ toMonth: feb.win.month }), observations, 'common')
  assert.equal(output.commonUnavailable, false)
  assert.equal(output.commonCharacterCount, 3)
  assert.deepEqual(output.rows.map(row => row.points.length), [3, 3])
  assert.deepEqual(output.rows[1].points.map(point => point.usageRate), [10, 20, 30])
  assert.deepEqual(output.rows[1].exclusions.at(-1)?.reasons, ['non-common'])
  assert.equal(createCorrelationHistory(input.win, input.usage, selection({ toMonth: feb.win.month }), observations, 'monthly').rows[1].points.length, 4)
})

test('全月読込済みでも共通IDが空なら0キャラ・係数nullで表し、取得失敗とは区別する', () => {
  const jan = descriptors()
  const feb = descriptors('2026-02')
  const input = manifests([jan, feb])
  const febData = datasets(feb, [{ id: 'juri', text: '5.000' }], [{ id: 'juri', value: 100000 }])
  const output = createCorrelationHistory(input.win, input.usage, selection({ toMonth: feb.win.month }), combinedResults([results(jan), results(feb, febData)]), 'common')
  assert.equal(output.commonUnavailable, false)
  assert.equal(output.commonCharacterCount, 0)
  assert.ok(output.rows.every(row => row.status === 'ready' && row.points.length === 0 && row.pearson === null && row.unavailableReason === 'insufficient-characters'))
})

test('マスター版は同名MASTERの総合版と混ぜず専用出典と合算値で比較する', () => {
  const general = descriptors()
  const master = descriptors('2026-01', 'master')
  const input = manifests([general, master])
  const observations = combinedResults([results(general), results(master, datasets(master, [...wins].reverse()))])
  const row = createCorrelationHistory(input.win, input.usage, selection({ edition: 'master' }), observations, 'monthly').rows[0]
  // Results contain two same-month observations from different populations; fail closed instead of choosing one.
  assert.equal(row.status, 'error')
  const correct = createCorrelationHistory(input.win, input.usage, selection({ edition: 'master' }), results(master, datasets(master, [...wins].reverse())), 'monthly').rows[0]
  assert.equal(correct.status, 'ready')
  assert.equal(correct.winSource?.url, WIN_RATE_EDITION_SOURCES.master.url)
  assert.equal(correct.usageSource?.url, USAGE_RATE_EDITION_SOURCES.master.url)
})

test('片側の未登録・取得失敗・結果不足を区別し、共通対象を確定しない', () => {
  const jan = descriptors()
  const mar = descriptors('2026-03')
  const apr = descriptors('2026-04')
  const input = manifests([jan, mar, apr])
  input.usage.datasets = [jan.usage, apr.usage]
  const output = createCorrelationHistory(input.win, input.usage, selection({ toMonth: apr.win.month }), results(), 'monthly')
  assert.deepEqual(output.rows.map(row => row.status), ['ready', 'unavailable', 'error', 'error'])
  assert.equal(output.rows[2].winStatus, 'error')
  assert.equal(output.rows[2].usageStatus, 'unavailable')
  assert.equal(output.commonUnavailable, true)
  assert.equal(output.commonCharacterCount, null)
  const common = createCorrelationHistory(input.win, input.usage, selection({ toMonth: apr.win.month }), results(), 'common')
  assert.equal(common.rows[0].status, 'incomplete')
  assert.equal(common.rows[0].points.length, 0)
  assert.equal(common.rows[0].pearson, null)
})

test('重複結果・別条件・別出典・壊れた投入データを再検証して集計から除く', () => {
  const input = manifests()
  const fixtures: CorrelationHistoryResults[] = []
  const duplicate = results()
  duplicate.winResults.push(duplicate.winResults[0])
  fixtures.push(duplicate)
  const wrongDescriptor = results()
  wrongDescriptor.winResults[0].descriptor = { ...wrongDescriptor.winResults[0].descriptor, path: 'wrong.json' }
  fixtures.push(wrongDescriptor)
  const wrongSource = results()
  if (wrongSource.winResults[0].status === 'ready') wrongSource.winResults[0].dataset.source.url = WIN_RATE_EDITION_SOURCES.general.url.replace('ja-jp', 'en-us')
  fixtures.push(wrongSource)
  const wrongConditions = results()
  if (wrongConditions.usageResults[0].status === 'ready') wrongConditions.usageResults[0].dataset.league = 'DIAMOND'
  fixtures.push(wrongConditions)
  const wrongValue = results()
  if (wrongValue.usageResults[0].status === 'ready') wrongValue.usageResults[0].dataset.distributions[0].entries[0].percentThousandths = 42
  fixtures.push(wrongValue)
  for (const observations of fixtures) {
    const row = createCorrelationHistory(input.win, input.usage, selection(), observations, 'monthly').rows[0]
    assert.equal(row.status, 'error')
    assert.equal(row.points.length, 0)
  }
})

test('全読込を共有の最大4並列に制限し、失敗を残して再試行できる', async () => {
  const descs = ['01', '02', '03', '04', '05'].map(month => descriptors(`2026-${month}`))
  const input = manifests(descs)
  let active = 0
  let peak = 0
  let shouldFail = true
  async function tracked<T>(value: T, fail = false): Promise<T> {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    if (fail) throw new Error('network')
    return value
  }
  const loaders = {
    win: (descriptor: WinRateDatasetDescriptor) => tracked(datasets(descs.find(item => item.win.id === descriptor.id)!).win, descriptor.month === '2026-03' && shouldFail),
    usage: (descriptor: UsageRateDatasetDescriptor) => tracked(datasets(descs.find(item => item.usage.id === descriptor.id)!).usage),
  }
  const selected = selection({ toMonth: '2026-05' })
  const first = await loadCorrelationHistory(input.win, input.usage, selected, loaders)
  assert.ok(peak <= 4 && peak > 1)
  assert.equal(first.winResults[2].status, 'error')
  assert.equal(first.usageResults.length, 5)
  assert.equal(createCorrelationHistory(input.win, input.usage, selected, first, 'monthly').rows[2].status, 'error')
  shouldFail = false
  const retried = await loadCorrelationHistory(input.win, input.usage, selected, loaders)
  assert.ok(retried.winResults.every(item => item.status === 'ready'))
})

test('読込段階でも注入された別条件・出典のデータは失敗にする', async () => {
  const input = manifests()
  const data = datasets()
  data.win.month = '2026-02'
  data.usage.source.url = USAGE_RATE_EDITION_SOURCES.general.url.replace('ja-jp', 'en-us')
  const output = await loadCorrelationHistory(input.win, input.usage, selection(), { win: async () => data.win, usage: async () => data.usage })
  assert.equal(output.winResults[0].status, 'error')
  assert.equal(output.usageResults[0].status, 'error')
})

test('既存データローダーのキャッシュを使い、使用率のpublication/sourceを指定し失敗だけ再取得する', async () => {
  const original = globalThis.fetch
  const input = manifests()
  const data = datasets()
  const urls: string[] = []
  let usageFails = true
  globalThis.fetch = async request => {
    const url = String(request)
    urls.push(url)
    if (url.includes('/usage-rates/')) {
      if (usageFails) return new Response('', { status: 503 })
      return Response.json(data.usage)
    }
    return Response.json(data.win)
  }
  try {
    const first = await loadCorrelationHistory(input.win, input.usage, selection())
    assert.equal(first.winResults[0].status, 'ready')
    assert.equal(first.usageResults[0].status, 'error')
    usageFails = false
    const second = await loadCorrelationHistory(input.win, input.usage, selection())
    assert.equal(second.usageResults[0].status, 'ready')
    const third = await loadCorrelationHistory(input.win, input.usage, selection())
    assert.equal(third.usageResults[0].status, 'ready')
    assert.equal(urls.filter(url => url.includes('/win-rates/')).length, 1)
    assert.equal(urls.filter(url => url.includes('/usage-rates/')).length, 2)
    const usageUrl = new URL(urls.find(url => url.includes('/usage-rates/'))!, 'http://localhost')
    assert.equal(usageUrl.searchParams.get('published'), generatedAt)
    assert.equal(usageUrl.searchParams.get('source'), USAGE_RATE_EDITION_SOURCES.general.url)
    assert.equal(usageUrl.searchParams.get('v'), capturedAt)
  } finally { globalThis.fetch = original }
})

test('リクエストキーは両方のpublicationと対象条件・記述子を含む', () => {
  const input = manifests()
  const key = correlationHistoryRequestKey(input.win, input.usage, selection())
  input.usage.generatedAt = '2026-10-15T00:02:00.000Z'
  assert.notEqual(correlationHistoryRequestKey(input.win, input.usage, selection()), key)
  input.usage.datasets[0].capturedAt = '2026-10-15T00:03:00.000Z'
  assert.notEqual(correlationHistoryRequestKey(input.win, input.usage, selection()), key)
})

test('保存済み2026年8月MASTERは31キャラ、独立試算のPearson・Spearmanに一致する', async () => {
  const win = JSON.parse(await readFile(new URL('../../public/data/win-rates/index.json', import.meta.url), 'utf8')) as WinRateManifest
  const usage = JSON.parse(await readFile(new URL('../../public/data/usage-rates/index.json', import.meta.url), 'utf8')) as UsageRateManifest
  const selected = selection({ fromMonth: '2026-08', toMonth: '2026-08' })
  const observations = await loadCorrelationHistory(win, usage, selected, {
    win: async descriptor => JSON.parse(await readFile(new URL(`../../public/data/win-rates/${descriptor.path}`, import.meta.url), 'utf8')),
    usage: async descriptor => JSON.parse(await readFile(new URL(`../../public/data/usage-rates/${descriptor.path}`, import.meta.url), 'utf8')),
  })
  const row = createCorrelationHistory(win, usage, selected, observations, 'monthly').rows[0]
  assert.equal(row.status, 'ready')
  assert.equal(row.points.length, 31)
  assert.equal(row.exclusions.length, 0)
  assert.ok(Math.abs(row.pearson! - -.445875740395718) < 1e-12)
  assert.ok(Math.abs(row.spearman! - -.5460227873297797) < 1e-12)
  assert.equal(initialCorrelationSelection(win, usage).toMonth, '2026-08')
})
