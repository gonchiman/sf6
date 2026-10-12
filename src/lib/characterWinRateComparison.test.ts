import assert from 'node:assert/strict'
import test from 'node:test'
import { createCharacterWinRateComparison } from './characterWinRateComparison.ts'
import { createLeagueTotalWinRates } from './leagueTotalWinRates.ts'
import { WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import type { LeagueTotalWinRates, LeagueTotalWinRateSelection } from '../types/leagueTotalWinRates.ts'
import type { HistoryDatasetResult } from '../types/winRateHistory.ts'
import type { WinRateControlType, WinRateDatasetDescriptor, WinRateManifest } from '../types/winRates.ts'

const capturedAt = '2026-10-08T00:00:00.000Z'
const selected: LeagueTotalWinRateSelection = { edition: 'general', month: '2026-08', operationMode: 'combined' }

function descriptor(league: string, selection = selected): WinRateDatasetDescriptor {
  const id = `${selection.edition}-${selection.month}-${league.toLowerCase()}-${selection.operationMode}`
  return { edition: selection.edition, id, month: selection.month, league, operationMode: selection.operationMode, path: `${id}.json`, capturedAt }
}

function manifest(datasets: WinRateDatasetDescriptor[]): WinRateManifest {
  return { schemaVersion: 1, generatedAt: capturedAt, source: WIN_RATE_EDITION_SOURCES.general, datasets }
}

interface Character { id: string; name?: string; text: string; controlType?: WinRateControlType; lowSample?: boolean }

function ready(desc: WinRateDatasetDescriptor, characters: Character[]): Extract<HistoryDatasetResult, { status: 'ready' }> {
  const fighters = characters.map((character, index) => ({
    id: `${desc.league.toLowerCase()}-slot-${index}`, characterId: character.id, name: character.name ?? character.id.toUpperCase(),
    controlType: character.controlType ?? null,
  }))
  return {
    month: desc.month, descriptor: desc, status: 'ready',
    dataset: {
      edition: desc.edition, schemaVersion: 1, id: desc.id, month: desc.month, league: desc.league, operationMode: desc.operationMode,
      capturedAt: desc.capturedAt, generatedAt: capturedAt,
      source: { ...WIN_RATE_EDITION_SOURCES[desc.edition ?? 'general'], population: 'ランクマッチ', metric: '公式Total', notes: [] },
      fighters, rows: fighters.map((fighter, index) => ({
        fighterId: fighter.id, total: { text: characters[index].text, lowSample: characters[index].lowSample ?? false },
        cells: fighters.map(() => ({ text: '9.999', lowSample: false })),
      })).reverse(),
    },
  }
}

function combinedComparison(): LeagueTotalWinRates {
  const rookie = descriptor('ROOKIE')
  const master = descriptor('MASTER')
  return createLeagueTotalWinRates(manifest([rookie, master]), selected, [
    { league: 'ROOKIE', results: [ready(rookie, [
      { id: 'ryu', text: '5.000' }, { id: 'ken', text: '5.000' }, { id: 'cammy', text: '5.000' },
      { id: 'gouki', text: '5.000' }, { id: 'luke', text: '5.000' }, { id: 'honda', text: '5.000' },
    ])] },
    { league: 'MASTER', results: [ready(master, [
      { id: 'honda', text: '6.000', lowSample: true }, { id: 'gouki', text: '6.000' },
      { id: 'ryu', text: '-' }, { id: 'ken', text: '0.000' }, { id: 'cammy', text: '-.---' },
    ])] },
  ])
}

test('合算の掲載値で昇降順にし、0%を有効として欠損・未掲載を最後に保ち公式順へ復帰する', () => {
  const comparison = combinedComparison()
  const before = structuredClone(comparison)
  const desc = createCharacterWinRateComparison(comparison, selected, 'MASTER')
  assert.deepEqual(desc.rows.map(row => row.characterId), ['gouki', 'honda', 'ken', 'ryu', 'cammy', 'luke'])
  assert.deepEqual(desc.rows.map(row => row.order), [3, 5, 1, 0, 2, 4])
  assert.equal(desc.rows[1].series[0].point.total?.lowSample, true)
  assert.equal(desc.rows[2].series[0].point.percentHundredths, 0)
  assert.deepEqual(desc.rows.slice(3).map(row => row.series[0].point.status), ['missing', 'missing', 'unlisted'])
  const asc = createCharacterWinRateComparison(comparison, selected, 'MASTER', 'ascending')
  assert.deepEqual(asc.rows.map(row => row.characterId), ['ken', 'gouki', 'honda', 'ryu', 'cammy', 'luke'])
  const official = createCharacterWinRateComparison(comparison, selected, 'MASTER', 'official')
  assert.deepEqual(official.rows.map(row => row.characterId), ['ryu', 'ken', 'cammy', 'gouki', 'luke', 'honda'])
  for (const row of desc.rows) {
    const source = comparison.rows.find(item => item.characterId === row.characterId)!
    assert.equal(row.series[0].point, source.values[comparison.leagues.indexOf('MASTER')])
    assert.equal(row.series[0].controlType, 'combined')
  }
  assert.deepEqual(comparison, before)
})

test('C/M行が交互・別順・同名でも安定IDでペア化し、classicだけでソートしてmodernを代用・平均しない', () => {
  const selection: LeagueTotalWinRateSelection = { ...selected, operationMode: 'separate' }
  const master = descriptor('MASTER', selection)
  const comparison = createLeagueTotalWinRates(manifest([master]), selection, [{ league: 'MASTER', results: [ready(master, [
    { id: 'ryu', name: 'SAME', text: '4.000', controlType: 'classic' },
    { id: 'ken', name: 'SAME', text: '8.000', controlType: 'modern' },
    { id: 'ryu', name: 'SAME', text: '9.000', controlType: 'modern' },
    { id: 'ken', name: 'SAME', text: '5.000', controlType: 'classic' },
    { id: 'cammy', text: '10.000', controlType: 'modern' },
    { id: 'gouki', text: '-', controlType: 'classic' },
    { id: 'gouki', text: '10.000', controlType: 'modern' },
  ])] }])
  const byKey = new Map(comparison.rows.map(row => [row.key, row]))
  comparison.rows = [byKey.get('ryu:modern')!, byKey.get('ken:classic')!, byKey.get('cammy:modern')!,
    byKey.get('gouki:modern')!, byKey.get('ryu:classic')!, byKey.get('ken:modern')!, byKey.get('gouki:classic')!]
  const before = structuredClone(comparison)
  const output = createCharacterWinRateComparison(comparison, selection, 'MASTER')
  assert.deepEqual(output.rows.map(row => row.characterId), ['ken', 'ryu', 'cammy', 'gouki'])
  assert.deepEqual(output.rows.map(row => row.name), ['SAME', 'SAME', 'CAMMY', 'GOUKI'])
  assert.deepEqual(output.rows.map(row => row.series.map(series => series.controlType)), [
    ['classic', 'modern'], ['classic', 'modern'], ['classic', 'modern'], ['classic', 'modern'],
  ])
  assert.deepEqual(output.rows.slice(0, 2).map(row => row.series.map(series => series.point.percentHundredths)), [[5000, 8000], [4000, 9000]])
  assert.equal(output.rows[2].series[0].point.status, 'unlisted')
  assert.equal(output.rows[2].series[0].point.source?.url, WIN_RATE_EDITION_SOURCES.general.url)
  assert.equal(output.rows[2].series[1].point.percentHundredths, 10000)
  assert.equal(output.rows[3].series[0].point.status, 'missing')
  assert.equal(output.rows[3].series[1].point.percentHundredths, 10000)
  for (const row of output.rows) for (const series of row.series) {
    const source = comparison.rows.find(item => item.characterId === row.characterId && item.controlType === series.controlType)
    if (source) assert.equal(series.point, source.values[7])
  }
  assert.deepEqual(createCharacterWinRateComparison(comparison, selection, 'MASTER', 'ascending').rows.map(row => row.characterId), ['ryu', 'ken', 'cammy', 'gouki'])
  assert.deepEqual(createCharacterWinRateComparison(comparison, selection, 'MASTER', 'official').rows.map(row => row.characterId), ['ryu', 'ken', 'cammy', 'gouki'])
  assert.deepEqual(comparison, before)
})

test('欠けたpointは選択リーグのメタデータから補い、source・取得日時・月を保持する', () => {
  const comparison = combinedComparison()
  const column = comparison.leagues.indexOf('MASTER')
  const row = comparison.rows.find(item => item.characterId === 'ken')!
  delete row.values[column]
  comparison.metadata.reverse()
  const before = structuredClone(comparison)
  const point = createCharacterWinRateComparison(comparison, selected, 'MASTER').rows.find(item => item.characterId === 'ken')!.series[0].point
  assert.equal(point.status, 'unlisted')
  assert.equal(point.month, selected.month)
  assert.equal(point.percentHundredths, null)
  assert.equal(point.total, null)
  assert.equal(point.capturedAt, capturedAt)
  assert.equal(point.source?.url, WIN_RATE_EDITION_SOURCES.general.url)
  assert.deepEqual(comparison, before)
})

test('選択リーグの未登録・読込失敗を保ち、メタデータ欠落でも0%へ補完しない', () => {
  const comparison = combinedComparison()
  for (const league of ['IRON', 'DIAMOND']) {
    const column = comparison.leagues.indexOf(league)
    comparison.rows.forEach(row => { delete row.values[column] })
    const metadata = comparison.metadata.find(item => item.league === league)!
    metadata.status = league === 'IRON' ? 'unavailable' : 'error'
    const output = createCharacterWinRateComparison(comparison, selected, league)
    assert.deepEqual(output.rows.map(row => row.characterId), ['ryu', 'ken', 'cammy', 'gouki', 'luke', 'honda'])
    assert.ok(output.rows.every(row => row.series[0].point.status === metadata.status && row.series[0].point.percentHundredths === null
      && row.series[0].point.capturedAt === null && row.series[0].point.source === null))
  }
  comparison.metadata = []
  const output = createCharacterWinRateComparison(comparison, selected, 'IRON')
  assert.ok(output.rows.every(row => row.series[0].point.status === 'unavailable'))
  const empty = { leagues: ['MASTER'], rows: [], metadata: [] }
  assert.deepEqual(createCharacterWinRateComparison(empty, selected, 'MASTER').rows, [])
})

test('値なしstatusに残った古い数値をソートに使わない', () => {
  const comparison = combinedComparison()
  const ryu = comparison.rows.find(item => item.characterId === 'ryu')!
  ryu.values[7].percentHundredths = 10000
  assert.equal(ryu.values[7].status, 'missing')
  const output = createCharacterWinRateComparison(comparison, selected, 'MASTER')
  assert.deepEqual(output.rows.map(row => row.characterId), ['gouki', 'honda', 'ken', 'ryu', 'cammy', 'luke'])
  assert.equal(output.rows[3].series[0].point, ryu.values[7])
})

test('マスター版の同名MASTERを独立したデータとして使い、未知リーグや選択条件違いを拒否する', () => {
  const selection: LeagueTotalWinRateSelection = { ...selected, edition: 'master' }
  const high = descriptor('HIGH_MASTER', selection)
  const master = descriptor('MASTER', selection)
  const comparison = createLeagueTotalWinRates(manifest([master, high]), selection, [
    { league: 'MASTER', results: [ready(master, [{ id: 'ryu', text: '4.944' }])] },
    { league: 'HIGH_MASTER', results: [ready(high, [{ id: 'ryu', text: '4.934' }])] },
  ])
  const output = createCharacterWinRateComparison(comparison, selection, 'HIGH_MASTER')
  assert.equal(output.rows[0].series[0].point.percentHundredths, 4934)
  assert.equal(output.rows[0].series[0].point.source?.url, WIN_RATE_EDITION_SOURCES.master.url)
  assert.throws(() => createCharacterWinRateComparison(comparison, selection, 'DIAMOND'), /リーグ/)
  assert.throws(() => createCharacterWinRateComparison(comparison, selection, 'UNKNOWN'), /リーグ/)
  assert.throws(() => createCharacterWinRateComparison(comparison, { ...selection, operationMode: 'separate' }, 'MASTER'), /操作タイプ/)
  assert.throws(() => createCharacterWinRateComparison(comparison, selected, 'MASTER'), /一致/)
  assert.throws(() => createCharacterWinRateComparison(comparison, { ...selection, month: '2026-07' }, 'MASTER'), /一致/)
  assert.throws(() => createCharacterWinRateComparison(comparison, selection, 'MASTER', 'unknown' as never), /並び順/)
})
