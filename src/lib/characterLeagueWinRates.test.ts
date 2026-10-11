import assert from 'node:assert/strict'
import test from 'node:test'
import { createCharacterLeagueWinRates } from './characterLeagueWinRates.ts'
import { createLeagueTotalWinRates } from './leagueTotalWinRates.ts'
import { WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import type { LeagueTotalWinRateSelection } from '../types/leagueTotalWinRates.ts'
import type { HistoryDatasetResult, WinRateHistoryPoint } from '../types/winRateHistory.ts'
import type { WinRateControlType, WinRateDatasetDescriptor, WinRateManifest } from '../types/winRates.ts'

const capturedAt = '2026-10-08T00:00:00.000Z'
const selection: LeagueTotalWinRateSelection = { edition: 'general', month: '2026-08', operationMode: 'combined' }

function descriptor(league: string, selected = selection): WinRateDatasetDescriptor {
  const id = `${selected.edition}-${selected.month}-${league.toLowerCase()}-${selected.operationMode}`
  return { edition: selected.edition, id, month: selected.month, league, operationMode: selected.operationMode, path: `${id}.json`, capturedAt }
}

function manifest(datasets: WinRateDatasetDescriptor[]): WinRateManifest {
  return { schemaVersion: 1, generatedAt: capturedAt, source: WIN_RATE_EDITION_SOURCES.general, datasets }
}

interface Character {
  id: string
  name?: string
  text: string
  controlType?: WinRateControlType
  lowSample?: boolean
}

function ready(desc: WinRateDatasetDescriptor, characters: Character[]): Extract<HistoryDatasetResult, { status: 'ready' }> {
  const fighters = characters.map((character, index) => ({
    id: `slot-${index}`, characterId: character.id, name: character.name ?? character.id.toUpperCase(), controlType: character.controlType ?? null,
  }))
  return {
    month: desc.month, descriptor: desc, status: 'ready',
    dataset: {
      edition: desc.edition, schemaVersion: 1, id: desc.id, month: desc.month, league: desc.league,
      operationMode: desc.operationMode, capturedAt: desc.capturedAt, generatedAt: capturedAt,
      source: { ...WIN_RATE_EDITION_SOURCES[desc.edition ?? 'general'], population: 'ランクマッチ', metric: '公式Total', notes: [] },
      fighters, rows: fighters.map((fighter, index) => ({
        fighterId: fighter.id, total: { text: characters[index].text, lowSample: characters[index].lowSample ?? false },
        cells: fighters.map(() => ({ text: '9.999', lowSample: false })),
      })).reverse(),
    },
  }
}

test('安定キャラIDで合算行を選び、名前・表のソート順に依存せず0%・欠損・少数試合をそのまま保持する', () => {
  const rookie = descriptor('ROOKIE')
  const diamond = descriptor('DIAMOND')
  const master = descriptor('MASTER')
  const comparison = createLeagueTotalWinRates(manifest([rookie, diamond, master]), selection, [
    { league: 'ROOKIE', results: [ready(rookie, [{ id: 'ryu', name: 'SAME NAME', text: '0.000' }, { id: 'ken', name: 'SAME NAME', text: '10.000' }])] },
    { league: 'DIAMOND', results: [ready(diamond, [{ id: 'ken', text: '10.000' }, { id: 'ryu', name: 'RENAMED RYU', text: '4.524', lowSample: true }])] },
    { league: 'MASTER', results: [ready(master, [{ id: 'ryu', text: '-' }])] },
  ])
  comparison.rows.reverse()
  const before = structuredClone(comparison)
  const row = comparison.rows.find(item => item.characterId === 'ryu')!
  const result = createCharacterLeagueWinRates(comparison, selection, 'ryu', 'fallback')
  assert.equal(result.characterId, 'ryu')
  assert.equal(result.characterName, 'SAME NAME')
  assert.deepEqual(result.leagues, WIN_RATE_EDITION_LEAGUES.general)
  assert.deepEqual(result.series.map(item => item.controlType), ['combined'])
  assert.equal(result.series[0].points, row.values)
  assert.equal(result.series[0].points[0].percentHundredths, 0)
  assert.equal(result.series[0].points[6].total?.lowSample, true)
  assert.equal(result.series[0].points[6].percentHundredths, 4524)
  assert.equal(result.series[0].points[7].status, 'missing')
  assert.equal(result.series[0].points[7].total?.text, '-')
  assert.deepEqual(comparison, before)
})

test('操作タイプ別はクラシック・モダン順の2系列にし、行順が違っても各掲載値を参照する', () => {
  const selected: LeagueTotalWinRateSelection = { ...selection, operationMode: 'separate' }
  const master = descriptor('MASTER', selected)
  const comparison = createLeagueTotalWinRates(manifest([master]), selected, [{ league: 'MASTER', results: [ready(master, [
    { id: 'gouki', text: '4.743', controlType: 'modern' },
    { id: 'ryu', text: '4.871', controlType: 'modern' },
    { id: 'gouki', text: '4.892', controlType: 'classic', lowSample: true },
    { id: 'ryu', text: '4.934', controlType: 'classic' },
  ])] }])
  comparison.rows.reverse()
  const result = createCharacterLeagueWinRates(comparison, selected, 'gouki', '豪鬼')
  assert.deepEqual(result.series.map(item => item.controlType), ['classic', 'modern'])
  assert.deepEqual(result.series.map(item => item.points[7].percentHundredths), [4892, 4743])
  for (const item of result.series) {
    const row = comparison.rows.find(row => row.characterId === 'gouki' && row.controlType === item.controlType)!
    assert.equal(item.points, row.values)
  }
  assert.equal(result.series[0].points[7].total?.lowSample, true)
})

test('キャラ未掲載でもリーグごとのready/error/unavailableを保持し、readyの出典と取得日時を残す', () => {
  const rookie = descriptor('ROOKIE')
  const diamond = descriptor('DIAMOND')
  const master = descriptor('MASTER')
  const rookieResult = ready(rookie, [{ id: 'ryu', text: '5.000' }])
  const comparison = createLeagueTotalWinRates(manifest([rookie, diamond, master]), selection, [
    { league: 'ROOKIE', results: [rookieResult] },
    { league: 'DIAMOND', results: [{ month: diamond.month, descriptor: diamond, status: 'error' }] },
  ])
  // Metadata lookup must follow the league ID, rather than assuming its array order.
  comparison.metadata.reverse()
  const before = structuredClone(comparison)
  const result = createCharacterLeagueWinRates(comparison, selection, 'not-yet-listed', '未掲載キャラ')
  assert.equal(result.characterName, '未掲載キャラ')
  assert.deepEqual(result.series[0].points.map(point => point.status), [
    'unlisted', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'error', 'error',
  ])
  assert.ok(result.series[0].points.every(point => point.month === selection.month && point.total === null && point.percentHundredths === null))
  assert.equal(result.series[0].points[0].capturedAt, capturedAt)
  assert.equal(result.series[0].points[0].source, rookieResult.dataset.source)
  assert.ok(result.series[0].points.slice(1).every(point => point.capturedAt === null && point.source === null))
  assert.deepEqual(comparison, before)
})

test('片方の操作タイプ行がない場合も他方を保持し、欠けた系列だけメタデータから未掲載にする', () => {
  const selected: LeagueTotalWinRateSelection = { ...selection, operationMode: 'separate' }
  const master = descriptor('MASTER', selected)
  const comparison = createLeagueTotalWinRates(manifest([master]), selected, [{ league: 'MASTER', results: [ready(master, [
    { id: 'ryu', text: '0.000', controlType: 'classic' },
  ])] }])
  const classic = comparison.rows.find(row => row.controlType === 'classic')!
  comparison.rows = [classic]
  const result = createCharacterLeagueWinRates(comparison, selected, 'ryu', 'fallback')
  assert.deepEqual(result.series.map(item => item.controlType), ['classic', 'modern'])
  assert.equal(result.series[0].points, classic.values)
  assert.equal(result.series[0].points[7].percentHundredths, 0)
  assert.equal(result.series[1].points[7].status, 'unlisted')
  assert.equal(result.series[1].points[7].source?.url, WIN_RATE_EDITION_SOURCES.general.url)
})

test('全結果失敗でも選択キャラIDを保持して空棒と0%を混同しない', () => {
  const selected: LeagueTotalWinRateSelection = { ...selection, operationMode: 'separate' }
  const master = descriptor('MASTER', selected)
  const comparison = createLeagueTotalWinRates(manifest([master]), selected, [])
  const result = createCharacterLeagueWinRates(comparison, selected, 'gouki', '豪鬼')
  assert.equal(result.characterId, 'gouki')
  assert.equal(result.characterName, '豪鬼')
  assert.equal(result.series.length, 2)
  assert.ok(result.series.every(item => item.points.length === 8 && item.points[7].status === 'error'
    && item.points.every(point => point.percentHundredths === null)))
})

test('マスター版は4区分の合算1系列であり、並びと掲載欠損状態を保持する', () => {
  const selected: LeagueTotalWinRateSelection = { ...selection, edition: 'master' }
  const descriptors = WIN_RATE_EDITION_LEAGUES.master.map(league => descriptor(league, selected))
  const comparison = createLeagueTotalWinRates(manifest(descriptors), selected, descriptors.map((desc, index) => ({
    league: desc.league, results: [ready(desc, [{ id: 'honda', text: index === 2 ? '-.---' : ['5.153', '5.120', '', '4.968'][index] }])],
  })))
  const result = createCharacterLeagueWinRates(comparison, selected, 'honda', '本田')
  assert.deepEqual(result.leagues, ['MASTER', 'HIGH_MASTER', 'GRAND_MASTER', 'ULTIMATE_MASTER'])
  assert.deepEqual(result.series.map(item => item.controlType), ['combined'])
  assert.deepEqual(result.series[0].points.map(point => point.percentHundredths), [5153, 5120, null, 4968])
  assert.equal(result.series[0].points[2].status, 'missing')
  assert.equal(result.series[0].points[2].total?.text, '-.---')
  assert.ok(result.series[0].points.every(point => point.source?.url === WIN_RATE_EDITION_SOURCES.master.url))
})

test('欠けたメタデータは未登録とし、入力のリーグ順を変更しない', () => {
  const point: WinRateHistoryPoint = { month: selection.month, status: 'value', total: { text: '5.000', lowSample: false }, percentHundredths: 5000, capturedAt, source: null }
  const comparison = { leagues: ['DIAMOND', 'MASTER'], rows: [{ key: 'ryu:combined', characterId: 'ryu', name: 'RYU', controlType: null, values: [point, point] }], metadata: [] }
  const present = createCharacterLeagueWinRates(comparison, selection, 'ryu', 'fallback')
  assert.deepEqual(present.leagues, comparison.leagues)
  assert.equal(present.series[0].points[0], point)
  const absent = createCharacterLeagueWinRates(comparison, selection, 'gouki', '豪鬼')
  assert.deepEqual(absent.leagues, comparison.leagues)
  assert.deepEqual(absent.series[0].points.map(item => item.status), ['unavailable', 'unavailable'])
})
