import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedMatchLpBands, expectedMatchLpRankStyle } from './expectedMatchLpRange.ts'
import { createExpectedMatchConfig, DEFAULT_EXPECTED_MATCH_SETTINGS } from './expectedMatchModel.ts'
import { EXPECTED_MATCH_RANK_THRESHOLDS } from './expectedMatches.ts'
import { LEAGUE_SERIES_STYLES } from './leagueSeriesColors.ts'

const rankIds = ['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER']
const referenceRanks = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => ({ ...rank, winProbability: 0.5 }))

function contrastAgainstWhite(color: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return 1.05 / (luminance + 0.05)
}

test('LP帯の番号・日本語名とB配色を固定し、白番号のコントラストを維持する', () => {
  const names = ['ルーキー', 'アイアン', 'ブロンズ', 'シルバー', 'ゴールド', 'プラチナ', 'ダイヤ', 'マスター']
  const sourceStyles = structuredClone(LEAGUE_SERIES_STYLES)
  for (const [index, rankId] of rankIds.entries()) {
    const style = expectedMatchLpRankStyle(rankId)
    assert.equal(style.league, rankId)
    assert.equal(style.number, index === 7 ? 'M' : String(index + 1))
    assert.equal(style.name, names[index])
    assert.match(style.color, /^#[0-9a-f]{6}$/)
    assert.ok(contrastAgainstWhite(style.color) >= 4.5, `${rankId}: ${style.color}`)
  }
  assert.equal(expectedMatchLpRankStyle('GOLD').color, '#77705a')
  assert.equal(expectedMatchLpRankStyle('PLATINUM_STAR_3_5'), expectedMatchLpRankStyle('PLATINUM'))
  assert.deepEqual(LEAGUE_SERIES_STYLES, sourceStyles)
})

test('色の対応は入力順に依存せず、未登録IDには既知ランクを借りない', () => {
  const original = new Map(rankIds.map(rankId => [rankId, expectedMatchLpRankStyle(rankId).color]))
  for (const rankId of [...rankIds].reverse()) assert.equal(expectedMatchLpRankStyle(rankId).color, original.get(rankId))
  for (const rankId of ['UNKNOWN', 'master', 'HIGH_MASTER', 'toString', '__proto__']) {
    const style = expectedMatchLpRankStyle(rankId)
    assert.deepEqual(style, { league: rankId, number: '?', name: rankId, color: '#6e6e6e' })
    assert.ok(![...original.values()].includes(style.color))
    assert.ok(contrastAgainstWhite(style.color) >= 4.5)
  }
})

test('帯の区間は計算設定に一致し、PLATINUM分割とMASTER端点を区別する', () => {
  const config = createExpectedMatchConfig(DEFAULT_EXPECTED_MATCH_SETTINGS, referenceRanks)
  const source = structuredClone(config.ranks)
  const bands = expectedMatchLpBands(config.ranks, config.targetLp)
  assert.deepEqual(bands.map(({ minimumLp, endLp }) => [minimumLp, endLp]), [
    [0, 1_000], [1_000, 3_000], [3_000, 5_000], [5_000, 9_000], [9_000, 13_000],
    [13_000, 15_400], [15_400, 19_000], [19_000, 25_000],
  ])
  assert.equal(bands[5].style, bands[6].style)
  assert.ok(bands.every(band => band.id !== 'MASTER'))
  assert.deepEqual(config.ranks, source)
  const noBonus = createExpectedMatchConfig({ ...DEFAULT_EXPECTED_MATCH_SETTINGS, useWinStreakBonus: false }, referenceRanks)
  assert.deepEqual(expectedMatchLpBands(noBonus.ranks, noBonus.targetLp).filter(band => band.style.league === 'PLATINUM')
    .map(({ minimumLp, endLp }) => [minimumLp, endLp]), [[13_000, 19_000]])
})

test('目標LPで範囲を切り詰め、幅ゼロ・目標以降の区間は返さない', () => {
  const config = createExpectedMatchConfig(DEFAULT_EXPECTED_MATCH_SETTINGS, referenceRanks)
  const clipped = expectedMatchLpBands(config.ranks, 14_000)
  assert.equal(clipped.at(-1)?.id, 'PLATINUM')
  assert.equal(clipped.at(-1)?.endLp, 14_000)
  assert.ok(clipped.every(band => band.endLp > band.minimumLp && band.endLp <= 14_000))
  const exactBoundary = expectedMatchLpBands(config.ranks, 15_400)
  assert.equal(exactBoundary.at(-1)?.id, 'PLATINUM')
  assert.equal(exactBoundary.at(-1)?.endLp, 15_400)
  const masterEndpoint = { id: 'MASTER', minimumLp: 25_000, winProbability: 0 }
  assert.equal(expectedMatchLpBands([...config.ranks, masterEndpoint], 25_000).length, 8)
  for (const target of [0, -1, Number.NaN, Infinity]) assert.deepEqual(expectedMatchLpBands(config.ranks, target), [])
  assert.deepEqual(expectedMatchLpBands([], 25_000), [])
})
