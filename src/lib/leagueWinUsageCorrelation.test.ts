import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createLeagueCorrelationRows, leagueCorrelationRequestKey, loadLeagueCorrelationComparison,
} from './leagueWinUsageCorrelation.ts'
import { WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import { USAGE_RATE_EDITION_SOURCES } from './usageRates.ts'
import type { LeagueCorrelationResults } from './leagueWinUsageCorrelation.ts'
import type { CorrelationHistoryResults, CorrelationSelection } from '../types/winUsageCorrelation.ts'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateManifest } from '../types/winRates.ts'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateManifest } from '../types/usageRates.ts'

const capturedAt = '2026-10-15T00:00:00.000Z'
const generatedAt = '2026-10-15T00:01:00.000Z'

function descriptors(league = 'MASTER', month = '2026-01', edition: 'general' | 'master' = 'general', separate = false) {
  const id = `${edition}-${month}-${league.toLowerCase()}`
  const operationMode = separate ? 'separate' : 'combined'
  const win: WinRateDatasetDescriptor = { edition, id: `${id}-${operationMode}`, month, league, operationMode,
    path: `${id}-${operationMode}.json`, capturedAt }
  const usage: UsageRateDatasetDescriptor = { edition, id, month, league, path: `${id}.json`, capturedAt }
  return { win, usage }
}

function datasets(desc = descriptors(), ids = ['ryu', 'ken', 'cammy']) {
  const fighters = (desc.win.operationMode === 'combined' ? [null] as const : ['classic', 'modern'] as const)
    .flatMap(controlType => ids.map(characterId => ({ id: `${characterId}-${controlType ?? 'all'}`, characterId,
      name: characterId.toUpperCase(), controlType })))
  const win: WinRateDataset = {
    schemaVersion: 1, ...desc.win, generatedAt,
    source: { ...WIN_RATE_EDITION_SOURCES[desc.win.edition ?? 'general'], population: 'ランクマッチ', metric: '掲載値', notes: ['件数不明'] },
    fighters, rows: fighters.map((fighter, index) => ({ fighterId: fighter.id,
      total: { text: (4 + index % ids.length).toFixed(3), lowSample: false },
      cells: fighters.map(() => ({ text: '5.000', lowSample: false })),
    })),
  }
  const usageValues = ids.length === 4 ? [10000, 20000, 30000, 40000]
    : ids.length === 3 ? [20000, 30000, 50000] : ids.map((_, index) => index ? 60000 : 40000)
  const usage: UsageRateDataset = {
    schemaVersion: 1, ...desc.usage, generatedAt,
    source: { ...USAGE_RATE_EDITION_SOURCES[desc.usage.edition ?? 'general'], population: 'ランクマッチ', metric: '使用率', unit: '%', notes: ['件数不明'] },
    distributions: (desc.usage.edition === 'master' ? ['all'] as const : ['all', 'classic', 'modern'] as const)
      .map(controlType => ({ controlType, month: desc.usage.month, league: desc.usage.league,
        entries: ids.map((characterId, index) => ({ characterId, name: characterId.toUpperCase(),
          text: (usageValues[index] / 1000).toFixed(3), percentThousandths: usageValues[index] })),
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

function combine(...items: CorrelationHistoryResults[]): CorrelationHistoryResults {
  return { winResults: items.flatMap(item => item.winResults), usageResults: items.flatMap(item => item.usageResults) }
}

test('総合8リーグを公式順に残し、未登録リーグを0やALLで補わない', () => {
  const input = manifests()
  input.usage.datasets.push(descriptors('ALL').usage)
  const output = createLeagueCorrelationRows(input.win, input.usage, selection(), '2026-01', { MASTER: results() }, 'monthly')
  assert.deepEqual(output.map(item => item.league), WIN_RATE_EDITION_LEAGUES.general)
  assert.ok(output.slice(0, 7).every(item => item.row.status === 'unavailable' && item.row.pearson === null
    && item.row.winStatus === 'unavailable' && item.row.usageStatus === 'unavailable'))
  assert.equal(output[7].row.status, 'ready')
  assert.equal(output[7].row.spearman, 1)
  assert.equal(output[7].row.points.length, 3)
  assert.equal(output.some(item => item.league === 'ALL'), false)
})

test('マスター4リーグは同名MASTERの総合版と独立し、専用出典を保持する', async () => {
  const general = descriptors()
  const master = descriptors('MASTER', '2026-01', 'master')
  const input = manifests([general, master])
  const data = datasets(master)
  data.win.rows.reverse()
  const observations = await loadLeagueCorrelationComparison(input.win, input.usage,
    selection({ edition: 'master' }), '2026-01', 'monthly', { win: async () => data.win, usage: async () => data.usage })
  const output = createLeagueCorrelationRows(input.win, input.usage, selection({ edition: 'master' }), '2026-01', observations, 'monthly')
  assert.deepEqual(output.map(item => item.league), WIN_RATE_EDITION_LEAGUES.master)
  assert.equal(output[0].row.status, 'ready')
  assert.equal(output[0].row.winSource?.url, WIN_RATE_EDITION_SOURCES.master.url)
  assert.equal(output[0].row.usageSource?.url, USAGE_RATE_EDITION_SOURCES.master.url)
  assert.ok(output.slice(1).every(item => item.row.status === 'unavailable'))
  const wrongEdition = createLeagueCorrelationRows(input.win, input.usage,
    selection({ edition: 'master' }), '2026-01', { MASTER: results(general) }, 'monthly')
  assert.equal(wrongEdition[0].row.status, 'error')
})

test('月別モードは対象月だけを取得し、両指標・全8リーグ合計で最大4並列にする', async () => {
  const desc = WIN_RATE_EDITION_LEAGUES.general.flatMap(league => ['2026-01', '2026-02'].map(month => descriptors(league, month)))
  const input = manifests(desc)
  let active = 0
  let peak = 0
  const calls: string[] = []
  async function tracked<T>(id: string, value: T): Promise<T> {
    calls.push(id)
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active -= 1
    return value
  }
  const output = await loadLeagueCorrelationComparison(input.win, input.usage,
    selection({ fromMonth: '2025-01', toMonth: '2026-02' }), '2026-02', 'monthly', {
      win: descriptor => tracked(descriptor.id, datasets(desc.find(item => item.win.id === descriptor.id)!).win),
      usage: descriptor => tracked(descriptor.id, datasets(desc.find(item => item.usage.id === descriptor.id)!).usage),
    })
  assert.equal(peak, 4)
  assert.equal(active, 0)
  assert.equal(calls.length, 16)
  assert.ok(calls.every(id => id.includes('2026-02')))
  assert.deepEqual(Object.keys(output), WIN_RATE_EDITION_LEAGUES.general)
  assert.ok(Object.values(output).every(item => item?.winResults.length === 1 && item.usageResults.length === 1))
  assert.ok(createLeagueCorrelationRows(input.win, input.usage, selection(), '2026-02', output, 'monthly')
    .every(item => item.row.status === 'ready'))
})

test('共通モードは各リーグ内の期間共通IDを使い、他リーグとの交差や使用率の再正規化を行わない', async () => {
  const ironJan = descriptors('IRON')
  const ironFeb = descriptors('IRON', '2026-02')
  const masterJan = descriptors()
  const masterFeb = descriptors('MASTER', '2026-02')
  const desc = [ironJan, ironFeb, masterJan, masterFeb]
  const data = [datasets(ironJan, ['ryu', 'ken', 'cammy', 'ed']), datasets(ironFeb, ['ryu', 'ken', 'cammy', 'aki']),
    datasets(masterJan, ['juri', 'luke', 'guile']), datasets(masterFeb, ['juri', 'luke', 'guile'])]
  const input = manifests(desc)
  const selected = selection({ toMonth: '2026-02' })
  const output = await loadLeagueCorrelationComparison(input.win, input.usage, selected, '2026-02', 'common', {
    win: async descriptor => data[desc.findIndex(item => item.win.id === descriptor.id)].win,
    usage: async descriptor => data[desc.findIndex(item => item.usage.id === descriptor.id)].usage,
  })
  assert.equal(output.IRON?.winResults.length, 2)
  assert.equal(output.MASTER?.usageResults.length, 2)
  const rows = createLeagueCorrelationRows(input.win, input.usage, selected, '2026-02', output, 'common')
  const iron = rows.find(item => item.league === 'IRON')!.row
  const master = rows.find(item => item.league === 'MASTER')!.row
  assert.deepEqual(iron.points.map(point => point.characterId), ['ryu', 'ken', 'cammy'])
  assert.deepEqual(iron.points.map(point => point.usageRate), [10, 20, 30])
  assert.deepEqual(iron.exclusions, [{ characterId: 'aki', name: 'AKI', reasons: ['non-common'] }])
  assert.deepEqual(master.points.map(point => point.characterId), ['juri', 'luke', 'guile'])
  assert.equal(iron.status, 'ready')
  assert.equal(master.status, 'ready')
  assert.equal(iron.spearman, 1)
  assert.equal(master.spearman, 1)
})

test('共通期間の暦月欠損はそのリーグだけをincompleteにし、対象月の未登録・読込失敗を区別する', () => {
  const ironJan = descriptors('IRON')
  const ironMar = descriptors('IRON', '2026-03')
  const goldMar = descriptors('GOLD', '2026-03')
  const masters = ['2026-01', '2026-02', '2026-03'].map(month => descriptors('MASTER', month))
  const input = manifests([ironJan, ironMar, goldMar, ...masters])
  input.usage.datasets = input.usage.datasets.filter(item => item.league !== 'GOLD')
  const observations: LeagueCorrelationResults = {
    IRON: combine(results(ironJan), results(ironMar)), MASTER: combine(...masters.map(item => results(item))),
    GOLD: results(goldMar),
  }
  const selected = selection({ toMonth: '2026-03' })
  const output = createLeagueCorrelationRows(input.win, input.usage, selected, '2026-03', observations, 'common')
  const iron = output.find(item => item.league === 'IRON')!.row
  assert.equal(iron.status, 'incomplete')
  assert.equal(iron.winStatus, 'ready')
  assert.equal(iron.usageStatus, 'ready')
  assert.equal(iron.pearson, null)
  assert.equal(iron.points.length, 0)
  assert.equal(output.find(item => item.league === 'MASTER')!.row.status, 'ready')
  const gold = output.find(item => item.league === 'GOLD')!.row
  assert.equal(gold.status, 'unavailable')
  assert.equal(gold.winStatus, 'ready')
  assert.equal(gold.usageStatus, 'unavailable')
  const missingResults = createLeagueCorrelationRows(input.win, input.usage, selected, '2026-03', {}, 'monthly')
  assert.equal(missingResults.find(item => item.league === 'IRON')!.row.status, 'error')
  assert.equal(missingResults.find(item => item.league === 'ROOKIE')!.row.status, 'unavailable')
})

test('あるリーグの取得失敗を別リーグで補わず、失敗後の再試行で回復できる', async () => {
  const desc = [descriptors('IRON'), descriptors()]
  const input = manifests(desc)
  let shouldFail = true
  let calls = 0
  const loaders = {
    win: async (descriptor: WinRateDatasetDescriptor) => {
      calls += 1
      if (descriptor.league === 'IRON' && shouldFail) throw new Error('network')
      return datasets(desc.find(item => item.win.id === descriptor.id)!).win
    },
    usage: async (descriptor: UsageRateDatasetDescriptor) => datasets(desc.find(item => item.usage.id === descriptor.id)!).usage,
  }
  const first = await loadLeagueCorrelationComparison(input.win, input.usage, selection(), '2026-01', 'monthly', loaders)
  const rows = createLeagueCorrelationRows(input.win, input.usage, selection(), '2026-01', first, 'monthly')
  assert.equal(rows.find(item => item.league === 'IRON')!.row.status, 'error')
  assert.equal(rows.find(item => item.league === 'IRON')!.row.usageStatus, 'ready')
  assert.equal(rows.find(item => item.league === 'MASTER')!.row.status, 'ready')
  shouldFail = false
  const retry = await loadLeagueCorrelationComparison(input.win, input.usage, selection(), '2026-01', 'monthly', loaders)
  assert.equal(retry.IRON?.winResults[0].status, 'ready')
  assert.equal(calls, 4)
})

test('C/Mの選択は既存の個別操作タイプ処理を使い、古い合算結果や別リーグ結果を拒否する', () => {
  const combined = descriptors()
  const separate = descriptors('MASTER', '2026-01', 'general', true)
  const iron = descriptors('IRON', '2026-01', 'general', true)
  const input = manifests([combined])
  input.win.datasets.push(separate.win, iron.win)
  input.usage.datasets.push(iron.usage)
  const data = datasets(separate)
  data.win.rows.slice(3).forEach(row => { row.total.text = '5.000' })
  const observations = { MASTER: results(separate, data), IRON: results(separate, data) }
  const classic = createLeagueCorrelationRows(input.win, input.usage, selection({ controlType: 'classic' }), '2026-01', observations, 'monthly')
  const modern = createLeagueCorrelationRows(input.win, input.usage, selection({ controlType: 'modern' }), '2026-01', observations, 'monthly')
  assert.equal(classic[7].row.spearman, 1)
  assert.equal(modern[7].row.unavailableReason, 'constant-win-rate')
  assert.equal(modern[7].row.pearson, null)
  assert.equal(classic[1].row.status, 'error')
  const stale = createLeagueCorrelationRows(input.win, input.usage, selection({ controlType: 'classic' }), '2026-01', { MASTER: results(combined) }, 'monthly')
  assert.equal(stale[7].row.status, 'error')
})

test('3キャラ未満の算出不能を未登録や0係数と区別する', () => {
  const desc = descriptors()
  const input = manifests([desc])
  const observations = { MASTER: results(desc, datasets(desc, ['ryu', 'ken'])) }
  const output = createLeagueCorrelationRows(input.win, input.usage, selection(), '2026-01', observations, 'monthly')
  assert.equal(output[7].row.status, 'ready')
  assert.equal(output[7].row.points.length, 2)
  assert.equal(output[7].row.unavailableReason, 'insufficient-characters')
  assert.equal(output[7].row.pearson, null)
  assert.equal(output[7].row.spearman, null)
})

test('キーは選択中リーグを含まず、monthlyでは履歴期間にも依存しない', () => {
  const input = manifests([descriptors(), descriptors('IRON', '2026-02')])
  const key = leagueCorrelationRequestKey(input.win, input.usage, selection(), '2026-01', 'monthly')
  assert.equal(leagueCorrelationRequestKey(input.win, input.usage, selection({ league: 'IRON' }), '2026-01', 'monthly'), key)
  assert.equal(leagueCorrelationRequestKey(input.win, input.usage,
    selection({ fromMonth: '2025-01', toMonth: '2026-02' }), '2026-01', 'monthly'), key)
  assert.notEqual(leagueCorrelationRequestKey(input.win, input.usage, selection(), '2026-02', 'monthly'), key)
  assert.notEqual(leagueCorrelationRequestKey(input.win, input.usage, selection(), '2026-01', 'common'), key)
  assert.notEqual(leagueCorrelationRequestKey(input.win, input.usage, selection({ controlType: 'classic' }), '2026-01', 'monthly'), key)
  assert.notEqual(leagueCorrelationRequestKey(input.win, input.usage, selection({ edition: 'master' }), '2026-01', 'monthly'), key)
  const common = leagueCorrelationRequestKey(input.win, input.usage, selection(), '2026-01', 'common')
  assert.notEqual(leagueCorrelationRequestKey(input.win, input.usage,
    selection({ toMonth: '2026-02' }), '2026-01', 'common'), common)
})

test('キーは対象データの両publication・記述子変更を検出し、対象外月の記述子は除外する', () => {
  const input = manifests([descriptors(), descriptors('IRON', '2026-02')])
  const key = () => leagueCorrelationRequestKey(input.win, input.usage, selection(), '2026-01', 'monthly')
  const original = key()
  input.win.datasets[1].capturedAt = '2026-10-15T00:02:00.000Z'
  assert.equal(key(), original)
  for (const metric of ['win', 'usage'] as const) {
    const before = key()
    input[metric].generatedAt = '2026-10-15T00:03:00.000Z'
    assert.notEqual(key(), before)
    const afterPublication = key()
    input[metric].datasets[0].capturedAt = '2026-10-15T00:04:00.000Z'
    assert.notEqual(key(), afterPublication)
    const afterCapture = key()
    input[metric].datasets[0].path = 'changed-path.json'
    assert.notEqual(key(), afterCapture)
  }
})

test('不正な対象月・共通期間外・マスターC/Mは取得開始前に拒否する', async () => {
  const input = manifests()
  let calls = 0
  const loaders = { win: async () => { calls += 1; return datasets().win } }
  for (const [selected, month, mode] of [
    [selection(), '2026-13', 'monthly'],
    [selection(), '2026-02', 'common'],
    [selection({ fromMonth: '2026-02' }), '2026-01', 'common'],
    [selection({ edition: 'master', controlType: 'classic' }), '2026-01', 'monthly'],
  ] as const) {
    await assert.rejects(loadLeagueCorrelationComparison(input.win, input.usage, selected, month, mode, loaders))
  }
  assert.equal(calls, 0)
})

test('既存ローダーのキャッシュと使用率のpublication/source指定を維持する', async () => {
  const desc = descriptors('GOLD', '2025-12')
  const input = manifests([desc])
  const data = datasets(desc)
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  let failUsage = true
  globalThis.fetch = async request => {
    const url = String(request)
    urls.push(url)
    if (url.includes('/usage-rates/')) {
      if (failUsage) return new Response('', { status: 503 })
      return Response.json(data.usage)
    }
    return Response.json(data.win)
  }
  try {
    const first = await loadLeagueCorrelationComparison(input.win, input.usage, selection(), '2025-12', 'monthly')
    assert.equal(first.GOLD?.usageResults[0].status, 'error')
    failUsage = false
    const retry = await loadLeagueCorrelationComparison(input.win, input.usage, selection(), '2025-12', 'monthly')
    assert.equal(retry.GOLD?.usageResults[0].status, 'ready')
    await loadLeagueCorrelationComparison(input.win, input.usage, selection(), '2025-12', 'monthly')
    assert.equal(urls.filter(url => url.includes('/win-rates/')).length, 1)
    assert.equal(urls.filter(url => url.includes('/usage-rates/')).length, 2)
    const usageUrl = new URL(urls.find(url => url.includes('/usage-rates/'))!, 'https://example.com')
    assert.equal(usageUrl.searchParams.get('published'), generatedAt)
    assert.equal(usageUrl.searchParams.get('source'), USAGE_RATE_EDITION_SOURCES.general.url)
    assert.equal(usageUrl.searchParams.get('v'), capturedAt)
  } finally { globalThis.fetch = originalFetch }
})

test('保存済み2026年8月は総合全8リーグを計算し、既知のMASTER係数を維持する', async () => {
  const win = JSON.parse(await readFile(new URL('../../public/data/win-rates/index.json', import.meta.url), 'utf8')) as WinRateManifest
  const usage = JSON.parse(await readFile(new URL('../../public/data/usage-rates/index.json', import.meta.url), 'utf8')) as UsageRateManifest
  const output = await loadLeagueCorrelationComparison(win, usage, selection(), '2026-08', 'monthly', {
    win: async descriptor => JSON.parse(await readFile(new URL(`../../public/data/win-rates/${descriptor.path}`, import.meta.url), 'utf8')),
    usage: async descriptor => JSON.parse(await readFile(new URL(`../../public/data/usage-rates/${descriptor.path}`, import.meta.url), 'utf8')),
  })
  const rows = createLeagueCorrelationRows(win, usage, selection(), '2026-08', output, 'monthly')
  assert.equal(rows.length, 8)
  assert.ok(rows.every(item => item.row.status === 'ready' && item.row.points.length === 31))
  assert.ok(Math.abs(rows[7].row.pearson! - -.445875740395718) < 1e-12)
  assert.ok(Math.abs(rows[7].row.spearman! - -.5460227873297797) < 1e-12)
})
