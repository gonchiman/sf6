import assert from 'node:assert/strict'
import test from 'node:test'
import { createLeagueTotalWinRates, sortLeagueTotalWinRateRows } from './leagueTotalWinRates.ts'
import { WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import type { LeagueTotalWinRateSelection } from '../types/leagueTotalWinRates.ts'
import type { LeagueStatisticsDatasetResults } from '../types/monthlyWinRateStatisticsComparison.ts'
import type { HistoryDatasetResult } from '../types/winRateHistory.ts'
import type { WinRateControlType, WinRateDataset, WinRateDatasetDescriptor, WinRateEdition, WinRateManifest } from '../types/winRates.ts'

const capturedAt = '2026-10-08T00:00:00.000Z'
const selected: LeagueTotalWinRateSelection = { edition: 'general', month: '2026-08', operationMode: 'combined' }

function descriptor(league: string, overrides: Partial<WinRateDatasetDescriptor> = {}): WinRateDatasetDescriptor {
  const edition: WinRateEdition = overrides.edition ?? 'general'
  const month = overrides.month ?? selected.month
  const operationMode = overrides.operationMode ?? 'combined'
  const id = `${edition}-${month}-${league.toLowerCase()}-${operationMode}`
  return { edition, id, month, league, operationMode, path: `${id}.json`, capturedAt, ...overrides }
}

function manifest(datasets: WinRateDatasetDescriptor[]): WinRateManifest {
  return { schemaVersion: 1, generatedAt: capturedAt, source: WIN_RATE_EDITION_SOURCES.general, datasets }
}

interface Character {
  characterId: string
  text: string
  name?: string
  fighterId?: string
  controlType?: WinRateControlType
  lowSample?: boolean
}

function ready(desc: WinRateDatasetDescriptor, characters: Character[]): Extract<HistoryDatasetResult, { status: 'ready' }> {
  const fighters = characters.map((character, index) => ({
    id: character.fighterId ?? `${desc.league.toLowerCase()}-slot-${index}`,
    characterId: character.characterId,
    name: character.name ?? character.characterId.toUpperCase(),
    controlType: character.controlType ?? null,
  }))
  const dataset: WinRateDataset = {
    edition: desc.edition, schemaVersion: 1, id: desc.id, month: desc.month, league: desc.league,
    operationMode: desc.operationMode, capturedAt: desc.capturedAt, generatedAt: capturedAt,
    source: { ...WIN_RATE_EDITION_SOURCES[desc.edition ?? 'general'], population: 'ランクマッチ', metric: '公式Total', notes: [] },
    fighters,
    // Deliberately disagree with Total and reverse the rows to detect accidental cell averaging or index joins.
    rows: fighters.map((fighter, index) => ({
      fighterId: fighter.id, total: { text: characters[index].text, lowSample: characters[index].lowSample ?? false },
      cells: fighters.map(() => ({ text: '9.999', lowSample: false })),
    })).reverse(),
  }
  return { month: desc.month, descriptor: desc, status: 'ready', dataset }
}

function group(league: string, ...results: HistoryDatasetResult[]): LeagueStatisticsDatasetResults {
  return { league, results }
}

test('全8リーグを定義順に並べ、公式順のキャラ和集合を安定IDで結合する', () => {
  const rookie = descriptor('ROOKIE')
  const diamond = descriptor('DIAMOND')
  const master = descriptor('MASTER')
  const results = [
    group('MASTER', ready(master, [
      { characterId: 'cammy', name: 'KEN', text: '6.000', fighterId: 'master-other-slot' },
      { characterId: 'ryu', name: 'RENAMED RYU', text: '5.000' },
    ])),
    group('DIAMOND', ready(diamond, [
      { characterId: 'ken', name: 'KEN NEW', text: '4.321' },
      { characterId: 'cammy', name: 'KEN', text: '4.876' },
      { characterId: 'ryu', name: 'RENAMED RYU', text: '4.524', lowSample: true },
    ])),
    group('ROOKIE', ready(rookie, [
      { characterId: 'ryu', text: '0.000', fighterId: 'first-source-id' }, { characterId: 'ken', text: '5.000' },
    ])),
  ]
  const input = manifest([master, diamond, rookie])
  const before = structuredClone({ input, results })
  const output = createLeagueTotalWinRates(input, selected, results)
  assert.deepEqual(output.leagues, WIN_RATE_EDITION_LEAGUES.general)
  assert.deepEqual(output.rows.map(row => [row.key, row.name, row.controlType]), [
    ['ryu:combined', 'RYU', null], ['ken:combined', 'KEN', null], ['cammy:combined', 'KEN', null],
  ])
  const diamondColumn = output.leagues.indexOf('DIAMOND')
  assert.deepEqual(output.rows.map(row => row.values[diamondColumn].percentHundredths), [4524, 4321, 4876])
  assert.equal(output.rows[0].values[0].percentHundredths, 0)
  assert.equal(output.rows[0].values[diamondColumn].total?.lowSample, true)
  assert.equal(output.rows[1].values[7].status, 'unlisted')
  assert.equal(output.rows[2].values[0].status, 'unlisted')
  assert.deepEqual({ input, results }, before)
})

test('操作タイプ別では各キャラのC/Mを独立した隣接行にし、同じファイルの各Totalを保持する', () => {
  const rookie = descriptor('ROOKIE', { operationMode: 'separate' })
  const master = descriptor('MASTER', { operationMode: 'separate' })
  const output = createLeagueTotalWinRates(manifest([master, rookie]), { ...selected, operationMode: 'separate' }, [
    group('ROOKIE', ready(rookie, [
      { characterId: 'ryu', text: '10.000', controlType: 'modern' },
      { characterId: 'ken', text: '4.000', controlType: 'classic' },
      { characterId: 'ryu', text: '0.000', controlType: 'classic' },
    ])),
    group('MASTER', ready(master, [
      { characterId: 'ken', text: '9.000', controlType: 'modern' },
      { characterId: 'ryu', text: '1.000', controlType: 'classic' },
      { characterId: 'ryu', text: '8.000', controlType: 'modern' },
    ])),
  ])
  assert.deepEqual(output.rows.map(row => row.key), ['ryu:classic', 'ryu:modern', 'ken:classic', 'ken:modern'])
  assert.deepEqual(output.rows.map(row => row.values[0].percentHundredths), [0, 10000, 4000, null])
  assert.deepEqual(output.rows.map(row => row.values[7].percentHundredths), [1000, 8000, null, 9000])
  assert.equal(output.rows[3].values[0].status, 'unlisted')
  assert.equal(output.rows[2].values[7].status, 'unlisted')
  assert.ok(output.metadata.filter(item => item.status === 'ready').every(item => item.result?.dataset.operationMode === 'separate'))
})

test('0%・両欠損表記・未掲載・未登録・読込失敗を別の状態として保ち、一部失敗で他列を消さない', () => {
  const rookie = descriptor('ROOKIE')
  const gold = descriptor('GOLD')
  const diamond = descriptor('DIAMOND')
  const master = descriptor('MASTER')
  const output = createLeagueTotalWinRates(manifest([rookie, gold, diamond, master]), selected, [
    group('ROOKIE', ready(rookie, [
      { characterId: 'ryu', text: '0.000' }, { characterId: 'ken', text: '-', lowSample: true }, { characterId: 'cammy', text: '-.---' },
    ])),
    group('GOLD', ready(gold, [{ characterId: 'ryu', text: '5.001' }])),
    group('DIAMOND', { month: diamond.month, descriptor: diamond, status: 'error' }),
    // A registered league with no matching result must also remain visibly failed.
  ])
  assert.deepEqual(output.rows.map(row => row.values[0].status), ['value', 'missing', 'missing'])
  assert.equal(output.rows[0].values[0].percentHundredths, 0)
  assert.equal(output.rows[1].values[0].total?.text, '-')
  assert.equal(output.rows[2].values[0].total?.text, '-.---')
  assert.equal(output.rows[1].values[0].total?.lowSample, true)
  assert.equal(output.rows[0].values[4].percentHundredths, 5001)
  assert.equal(output.rows[1].values[4].status, 'unlisted')
  assert.ok(output.rows.every(row => row.values[1].status === 'unavailable' && row.values[6].status === 'error' && row.values[7].status === 'error'))
  assert.deepEqual(output.metadata.map(item => item.status), ['ready', 'unavailable', 'unavailable', 'unavailable', 'ready', 'unavailable', 'error', 'error'])
  assert.ok(output.metadata.filter(item => item.status !== 'ready').every(item => item.result === undefined))
})

test('別月・別リーグ・別版・別モード・不正データを代用せず、誤ったキャラも和集合へ追加しない', () => {
  const master = descriptor('MASTER')
  const gold = descriptor('GOLD')
  const badDescriptors = [
    descriptor('MASTER', { month: '2026-07' }), descriptor('DIAMOND'),
    descriptor('MASTER', { edition: 'master' }), descriptor('MASTER', { operationMode: 'separate' }),
    { ...master, id: 'changed-source-id' }, { ...master, capturedAt: '2026-10-09T00:00:00.000Z' },
  ]
  const malformed = ready(master, [{ characterId: 'phantom', text: '9.000' }])
  malformed.dataset.rows[0].cells = []
  const mislabeledDataset = ready(master, [{ characterId: 'phantom', text: '9.000' }])
  mislabeledDataset.dataset.edition = 'master'
  const wrongResults = badDescriptors.map(desc => ready(desc, [{
    characterId: 'phantom', text: '9.000', controlType: desc.operationMode === 'separate' ? 'classic' : null,
  }]))
  for (const bad of [...wrongResults, malformed, mislabeledDataset]) {
    const output = createLeagueTotalWinRates(manifest([master, gold]), selected, [
      group('MASTER', bad), group('GOLD', ready(gold, [{ characterId: 'ryu', text: '5.000' }])),
    ])
    assert.deepEqual(output.rows.map(row => row.characterId), ['ryu'])
    assert.equal(output.rows[0].values[7].status, 'error')
    assert.equal(output.rows[0].values[4].percentHundredths, 5000)
    assert.equal(output.metadata[7].status, 'error')
    assert.equal(output.metadata[7].result, undefined)
  }
})

test('マスター版4リーグを独立表示し、総合版MASTERと混在しない', () => {
  const general = descriptor('MASTER')
  const descriptors = WIN_RATE_EDITION_LEAGUES.master.map(league => descriptor(league, { edition: 'master' }))
  const output = createLeagueTotalWinRates(manifest([general, ...descriptors]), { ...selected, edition: 'master' }, [
    ...descriptors.slice(1).reverse().map((desc, index) => group(desc.league, ready(desc, [{ characterId: 'ryu', text: `${index + 4}.000` }]))),
    group('MASTER', ready(general, [{ characterId: 'phantom', text: '9.000' }])),
  ])
  assert.deepEqual(output.leagues, WIN_RATE_EDITION_LEAGUES.master)
  assert.deepEqual(output.rows.map(row => row.characterId), ['ryu'])
  assert.deepEqual(output.rows[0].values.map(point => point.status), ['error', 'value', 'value', 'value'])
  assert.ok(output.metadata.slice(1).every(item => item.result?.dataset.source.url === WIN_RATE_EDITION_SOURCES.master.url))
  assert.throws(() => createLeagueTotalWinRates(manifest(descriptors), { ...selected, edition: 'master', operationMode: 'separate' }, []), /操作タイプ/)
})

test('重複結果は該当リーグの失敗として扱い、全列失敗でもメタデータを残す', () => {
  const master = descriptor('MASTER')
  const item = ready(master, [{ characterId: 'phantom', text: '5.000' }])
  for (const results of [[group('MASTER', item, item)], [group('MASTER', item), group('MASTER', item)], []]) {
    const output = createLeagueTotalWinRates(manifest([master]), selected, results)
    assert.deepEqual(output.rows, [])
    assert.equal(output.metadata[7].status, 'error')
    assert.equal(output.metadata[7].result, undefined)
    assert.equal(output.leagues.length, 8)
  }
  const empty = createLeagueTotalWinRates(manifest([]), selected, [])
  assert.deepEqual(empty.rows, [])
  assert.ok(empty.metadata.every(item => item.status === 'unavailable'))
})

test('列ごとのソートは0を含む掲載値を昇降順にし、欠損を常に最後に置き、公式順へ復帰できる', () => {
  const master = descriptor('MASTER')
  const rookie = descriptor('ROOKIE')
  const output = createLeagueTotalWinRates(manifest([master, rookie]), selected, [
    group('ROOKIE', ready(rookie, [
      { characterId: 'ryu', text: '5.000' }, { characterId: 'ken', text: '5.000' },
      { characterId: 'cammy', text: '5.000' }, { characterId: 'gouki', text: '5.000' }, { characterId: 'luke', text: '5.000' },
    ])),
    group('MASTER', ready(master, [
      { characterId: 'ryu', text: '-' }, { characterId: 'ken', text: '0.000' },
      { characterId: 'cammy', text: '6.000' }, { characterId: 'gouki', text: '6.000', lowSample: true },
    ])),
  ])
  const before = structuredClone(output)
  const sort = (league: string | null, direction: 'ascending' | 'descending') =>
    sortLeagueTotalWinRateRows(output.rows, output.leagues, { league, direction }).map(row => row.characterId)
  assert.deepEqual(sort('MASTER', 'ascending'), ['ken', 'cammy', 'gouki', 'ryu', 'luke'])
  assert.deepEqual(sort('MASTER', 'descending'), ['cammy', 'gouki', 'ken', 'ryu', 'luke'])
  assert.deepEqual(sort(null, 'descending'), ['ryu', 'ken', 'cammy', 'gouki', 'luke'])
  assert.deepEqual(sort('DIAMOND', 'ascending'), ['ryu', 'ken', 'cammy', 'gouki', 'luke'])
  assert.deepEqual(output, before)
})

test('不正な月・版・操作モード・重複descriptorを拒否する', () => {
  const desc = descriptor('MASTER')
  for (const invalid of [
    { ...selected, month: '2026-13' }, { ...selected, edition: 'unknown' as never },
    { ...selected, operationMode: 'unknown' as never },
  ]) assert.throws(() => createLeagueTotalWinRates(manifest([desc]), invalid, []))
  assert.throws(() => createLeagueTotalWinRates(manifest([desc, { ...desc, id: 'duplicate' }]), selected, []), /重複/)
})
