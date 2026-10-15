import assert from 'node:assert/strict'
import test from 'node:test'
import { createMonthlyUsageStatisticsComparison, loadMonthlyUsageStatisticsComparison } from './monthlyUsageRateStatisticsComparison.ts'
import { USAGE_RATE_EDITION_LEAGUES, USAGE_RATE_EDITION_SOURCES } from './usageRates.ts'
import type { MonthlyUsageRateStatisticsSelection } from '../types/monthlyUsageRateStatistics.ts'
import type { UsageRateControlType, UsageRateDataset, UsageRateDatasetDescriptor, UsageRateEntry, UsageRateManifest } from '../types/usageRates.ts'

const capturedAt = '2026-10-15T00:00:00.000Z'
const generatedAt = '2026-10-15T00:01:00.000Z'

function descriptor(month = '2026-01', league = 'MASTER', edition: 'general' | 'master' = 'general'): UsageRateDatasetDescriptor {
  const id = `${edition}-${month}-${league.toLowerCase()}`
  return { edition, id, month, league, path: `${id}.json`, capturedAt }
}

function entry(characterId: string, value: number): UsageRateEntry {
  return { characterId, name: characterId.toUpperCase(), percentThousandths: value, text: (value / 1000).toFixed(3) }
}

function dataset(desc: UsageRateDatasetDescriptor, entries = [entry('ryu', 20000), entry('ken', 80000)]): UsageRateDataset {
  const controls: UsageRateControlType[] = desc.edition === 'master' ? ['all'] : ['all', 'classic', 'modern']
  return {
    schemaVersion: 1, edition: desc.edition, id: desc.id, month: desc.month, league: desc.league,
    capturedAt: desc.capturedAt, generatedAt,
    source: { ...USAGE_RATE_EDITION_SOURCES[desc.edition ?? 'general'], population: '公式ランクマッチ統計', metric: 'キャラクター使用率', unit: '公開割合（%）', notes: ['件数は非公開'] },
    distributions: controls.map(controlType => ({ controlType, month: desc.month, league: desc.league, entries: entries.map(item => ({ ...item })) })),
  }
}

function manifest(descriptors = [descriptor()]): UsageRateManifest {
  return { schemaVersion: 1, generatedAt, source: USAGE_RATE_EDITION_SOURCES.general, datasets: descriptors }
}

function selection(overrides: Partial<MonthlyUsageRateStatisticsSelection> = {}): MonthlyUsageRateStatisticsSelection {
  return { edition: 'general', league: 'MASTER', controlType: 'combined', fromMonth: '2026-01', toMonth: '2026-01', ...overrides }
}

test('版・期間・リーグを絞って1ファイルから操作別値を選び、重複リーグは先頭順にまとめる', async () => {
  const master = descriptor()
  const gold = descriptor('2026-01', 'GOLD')
  const input = manifest([master, gold, descriptor('2026-02'), descriptor('2026-01', 'MASTER', 'master'), descriptor('2026-01', 'SILVER')])
  const calls: string[] = []
  const selected = selection({ controlType: 'modern' })
  const results = await loadMonthlyUsageStatisticsComparison(input, selected, ['GOLD', 'MASTER', 'GOLD', 'MASTER'], async desc => {
    calls.push(desc.id)
    const output = dataset(desc)
    if (desc.league === 'GOLD') output.distributions[2].entries = [entry('ryu', 100000)]
    return output
  })
  assert.deepEqual(calls.sort(), [master.id, gold.id].sort())
  assert.deepEqual(results.map(item => item.league), ['GOLD', 'MASTER'])
  const output = createMonthlyUsageStatisticsComparison(input, selected, results, 'monthly')
  assert.deepEqual(output.map(item => item.statistics.rows[0].validCount), [1, 2])
  assert.deepEqual(output.map(item => item.statistics.rows[0].statistics?.meanPercent), [100, 50])
  assert.deepEqual(output.map(item => item.statistics.rows[0].statistics?.standardDeviationPoints), [null, 30])
})

test('総合版はALLを含む9リーグ、マスター版は専用4リーグを独立分布として取得する', async () => {
  for (const edition of ['general', 'master'] as const) {
    const leagues = USAGE_RATE_EDITION_LEAGUES[edition]
    const descriptors = leagues.map(league => descriptor('2026-01', league, edition))
    const calls: string[] = []
    const selected = selection({ edition })
    const results = await loadMonthlyUsageStatisticsComparison(manifest(descriptors), selected, leagues, async desc => {
      calls.push(desc.id)
      return dataset(desc)
    })
    assert.equal(results.length, edition === 'general' ? 9 : 4)
    assert.deepEqual(calls.sort(), descriptors.map(desc => desc.id).sort())
    const output = createMonthlyUsageStatisticsComparison(manifest(descriptors), selected, results, 'monthly')
    assert.deepEqual(output.map(item => item.league), leagues)
    assert.ok(output.every(item => item.statistics.rows[0].source?.url === USAGE_RATE_EDITION_SOURCES[edition].url))
  }
})

test('全リーグ合計で同時取得を4に制限し、失敗しても残りの待機月を取得する', async () => {
  const leagues = ['MASTER', 'GOLD', 'SILVER']
  const months = ['2026-01', '2026-02', '2026-03', '2026-04']
  const descriptors = leagues.flatMap(league => months.map(month => descriptor(month, league)))
  let active = 0
  let maximum = 0
  let calls = 0
  const output = await loadMonthlyUsageStatisticsComparison(manifest(descriptors), selection({ toMonth: months.at(-1)! }), leagues, async desc => {
    active += 1
    maximum = Math.max(maximum, active)
    calls += 1
    try {
      await new Promise(resolve => setTimeout(resolve, 2))
      if (desc.month === '2026-02' && desc.league === 'GOLD') throw new Error('expected failure')
      return dataset(desc)
    } finally {
      active -= 1
    }
  })
  assert.equal(maximum, 4)
  assert.equal(active, 0)
  assert.equal(calls, descriptors.length)
  assert.equal(output.find(item => item.league === 'GOLD')!.results[1].status, 'error')
  assert.equal(output.flatMap(item => item.results).filter(item => item.status === 'ready').length, descriptors.length - 1)
})

test('共通キャラ集合はリーグ内の全月だけで交差し、他リーグのIDと交差・合算しない', async () => {
  const descriptors = ['GOLD', 'MASTER'].flatMap(league => ['2026-01', '2026-02'].map(month => descriptor(month, league)))
  const input = manifest(descriptors)
  const selected = selection({ toMonth: '2026-02' })
  const results = await loadMonthlyUsageStatisticsComparison(input, selected, ['GOLD', 'MASTER'], async desc => dataset(desc,
    desc.league === 'GOLD' ? [entry('ryu', 100000)]
      : desc.month === '2026-01' ? [entry('ken', 100000)] : [entry('ken', 50000), entry('cammy', 50000)],
  ))
  const output = createMonthlyUsageStatisticsComparison(input, selected, results, 'common')
  assert.deepEqual(output.map(item => item.statistics.commonCharacterCount), [1, 1])
  assert.deepEqual(output.map(item => item.statistics.rows.map(row => row.characterIds)), [[['ryu'], ['ryu']], [['ken'], ['ken']]])
  assert.deepEqual(output.map(item => item.statistics.rows.map(row => row.statistics?.meanPercent)), [[100, 100], [100, 50]])
  assert.equal(output[1].statistics.rows[1].publishedTotalPercent, 100)
})

test('他版・他リーグの結果と重複月を代用せず、同じリーグ内の失敗だけに留める', async () => {
  const master = descriptor()
  const gold = descriptor('2026-01', 'GOLD')
  const input = manifest([master, gold])
  const results = await loadMonthlyUsageStatisticsComparison(input, selection(), ['MASTER', 'GOLD'], async desc => dataset(desc))
  const duplicated = createMonthlyUsageStatisticsComparison(input, selection(), [
    { league: 'MASTER', results: [results[0].results[0], results[0].results[0]] }, results[1],
  ], 'monthly')
  assert.deepEqual(duplicated.map(item => item.statistics.rows[0].status), ['error', 'ready'])
  const injected = createMonthlyUsageStatisticsComparison(input, selection(), [{ league: 'MASTER', results: results[1].results }], 'monthly')
  assert.equal(injected[0].statistics.rows[0].status, 'error')
  const wrongEdition = await loadMonthlyUsageStatisticsComparison(input, selection(), ['MASTER'], async () => dataset(descriptor('2026-01', 'MASTER', 'master')))
  assert.equal(wrongEdition[0].results[0].status, 'error')
})

test('未登録月は失敗と区別し、共通モードの算出不能を他リーグへ波及させない', async () => {
  const descriptors = [descriptor('2026-01', 'GOLD'), descriptor('2026-01'), descriptor('2026-02')]
  const input = manifest(descriptors)
  const selected = selection({ toMonth: '2026-02' })
  const results = await loadMonthlyUsageStatisticsComparison(input, selected, ['GOLD', 'MASTER'], async desc => dataset(desc))
  assert.equal(results[0].results[1].status, 'missing')
  const output = createMonthlyUsageStatisticsComparison(input, selected, results, 'common')
  assert.deepEqual(output[0].statistics.rows.map(row => row.status), ['incomplete', 'unavailable'])
  assert.ok(output[1].statistics.rows.every(row => row.status === 'ready'))
})

test('不正な版・リーグ・操作・期間・重複manifestを通信前に拒否する', async () => {
  let calls = 0
  const loader = async (desc: UsageRateDatasetDescriptor) => { calls += 1; return dataset(desc) }
  const input = manifest()
  for (const [selected, leagues] of [
    [selection(), ['MASTER', 'UNKNOWN']], [selection(), ['MASTER', 'HIGH_MASTER']],
    [selection({ edition: 'master' }), ['MASTER', 'GOLD']],
    [selection({ edition: 'master', controlType: 'classic' }), ['MASTER']],
    [selection({ edition: 'unknown' as never }), ['MASTER']], [selection({ controlType: 'separate' as never }), ['MASTER']],
    [selection({ fromMonth: '2026-13' }), []], [selection({ fromMonth: '2026-02' }), ['MASTER']],
  ] as const) {
    await assert.rejects(loadMonthlyUsageStatisticsComparison(input, selected, leagues, loader))
    assert.throws(() => createMonthlyUsageStatisticsComparison(input, selected, leagues.map(league => ({ league, results: [] })), 'monthly'))
  }
  const desc = descriptor()
  await assert.rejects(loadMonthlyUsageStatisticsComparison(manifest([desc, { ...desc, id: 'duplicate' }]), selection(), ['MASTER'], loader))
  assert.equal(calls, 0)
  assert.throws(() => createMonthlyUsageStatisticsComparison(input, selection(), [], 'unknown' as never), /集計対象/)
})

test('空のリーグ選択は通信せず空配列を返し、重複リーグ結果は先頭を使う', async () => {
  const input = manifest()
  assert.deepEqual(await loadMonthlyUsageStatisticsComparison(input, selection(), [], async () => assert.fail('unexpected request')), [])
  assert.deepEqual(createMonthlyUsageStatisticsComparison(input, selection(), [], 'monthly'), [])
  const first = await loadMonthlyUsageStatisticsComparison(input, selection(), ['MASTER'], async desc => dataset(desc, [entry('ryu', 100000)]))
  const second = await loadMonthlyUsageStatisticsComparison(input, selection(), ['MASTER'], async desc => dataset(desc))
  const [output] = createMonthlyUsageStatisticsComparison(input, selection(), [...first, ...second], 'monthly')
  assert.equal(output.statistics.rows[0].validCount, 1)
})
