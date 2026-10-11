import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculateExpectedMatches, EXPECTED_MATCH_RANK_THRESHOLDS } from './expectedMatches.ts'
import { createExpectedMatchConfig, DEFAULT_EXPECTED_MATCH_SETTINGS } from './expectedMatchModel.ts'
import type { ExpectedMatchSettings } from '../types/expectedMatchData.ts'

function settings(overrides: Partial<ExpectedMatchSettings> = {}): ExpectedMatchSettings {
  return { ...DEFAULT_EXPECTED_MATCH_SETTINGS, ...overrides }
}

function mean(config: ReturnType<typeof createExpectedMatchConfig>): number {
  const result = calculateExpectedMatches(config)
  assert.equal(result.status, 'finite', JSON.stringify(result))
  if (result.status !== 'finite') throw new Error('Expected a finite result')
  return result.expectedMatches
}

test('rank rules prevent ROOKIE LP loss and IRON league demotion', () => {
  const model = settings({ targetLp: 100, useWinStreakBonus: false })
  const rookie = [{ id: 'ROOKIE', minimumLp: 0, winProbability: 0.5 }]
  assert.ok(Math.abs(mean(createExpectedMatchConfig(model, rookie)) - 4) < 1e-9)
  assert.ok(mean(createExpectedMatchConfig({ ...model, useRankRules: false }, rookie)) > 4)

  const ranks = [
    { id: 'ROOKIE', minimumLp: 0, winProbability: 1 },
    { id: 'IRON', minimumLp: 100, winProbability: 0.5 },
  ]
  const iron = settings({ startLp: 100, targetLp: 150, useWinStreakBonus: false })
  assert.ok(Math.abs(mean(createExpectedMatchConfig(iron, ranks)) - 2) < 1e-9)
})

test('a streak crossing from GOLD to PLATINUM uses the destination rank bonus on the next win', () => {
  const ranks = [
    { id: 'GOLD', minimumLp: 0, winProbability: 1 },
    { id: 'PLATINUM', minimumLp: 100, winProbability: 1 },
  ]
  // Start at 50 LP with 8 wins. The ninth win is GOLD +50+350 => 450.
  // The next is PLATINUM, tenth consecutive win, +50+500 => 1000.
  const model = settings({ startLp: 50, targetLp: 1000, startWinStreak: 8, platinumStreakBonus: 500 })
  assert.equal(mean(createExpectedMatchConfig(model, ranks)), 2)
})

test('disabling bonuses restores fixed-step results and leaves the source ranks unchanged', () => {
  const ranks = [{ id: 'ROOKIE', minimumLp: 0, winProbability: 0.5 }]
  const source = structuredClone(ranks)
  const model = settings({ targetLp: 20, winLp: 3, lossLp: 2, startWinStreak: 9, useRankRules: false, useWinStreakBonus: false })
  const config = createExpectedMatchConfig(model, ranks)
  const original = calculateExpectedMatches({ startLp: 0, targetLp: 20, winLp: 3, lossLp: 2, ranks })
  assert.equal(original.status, 'finite')
  if (original.status === 'finite') assert.equal(mean(config), original.expectedMatches)
  assert.deepEqual(ranks, source)
  assert.equal(config.startWinStreak, 0)
})

test('reference high-rank bonuses are defaults and explicit zero excludes them', () => {
  const ranks = [{ id: 'PLATINUM', minimumLp: 0, winProbability: 1 }]
  const model = settings({ targetLp: 600, startWinStreak: 10 })
  assert.equal(mean(createExpectedMatchConfig(model, ranks)), 2)
  assert.equal(mean(createExpectedMatchConfig({ ...model, platinumStreakBonus: 0 }, ranks)), 12)
})

test('PLATINUM star bands share the original probability and GOLD floor without mutating inputs', () => {
  const ranks = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => ({ ...rank, winProbability: rank.id === 'PLATINUM' ? 0.43 : 0.5 }))
  const model = settings()
  const sourceRanks = structuredClone(ranks)
  const sourceSettings = structuredClone(model)
  const config = createExpectedMatchConfig(model, ranks)
  const platinum = config.ranks.filter(rank => rank.id.startsWith('PLATINUM'))
  assert.deepEqual(platinum.map(rank => [rank.id, rank.minimumLp, rank.winProbability, rank.lossFloorLp]), [
    ['PLATINUM', 13_000, 0.43, 9_000],
    ['PLATINUM_STAR_3_5', 15_400, 0.43, 9_000],
  ])
  assert.equal(new Set(config.ranks.map(rank => rank.id)).size, config.ranks.length)
  assert.deepEqual(ranks, sourceRanks)
  assert.deepEqual(model, sourceSettings)
})

test('a PLATINUM star boundary uses pre-match LP and the upper bonus on the next win', () => {
  const ranks = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => ({ ...rank, winProbability: 1 }))
  // The first win begins below 15,400: +50+500 => 15,949.
  // The second begins above it: +50+1000 => 16,999.
  const below = settings({ startLp: 15_399, targetLp: 16_999, startWinStreak: 9 })
  const config = createExpectedMatchConfig(below, ranks.filter(rank => rank.minimumLp < below.targetLp))
  assert.equal(mean(config), 2)
  assert.equal(mean({ ...config, targetLp: 15_950 }), 2)
  assert.equal(mean({ ...config, startLp: 15_400, targetLp: 16_450 }), 1)
})

test('high-rank bonuses start on the tenth win, using the streak after victory', () => {
  const ranks = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => ({ ...rank, winProbability: 1 }))
  const model = settings({ startLp: 15_400, targetLp: 15_600, startWinStreak: 8 })
  const config = createExpectedMatchConfig(model, ranks.filter(rank => rank.minimumLp < model.targetLp))
  assert.equal(mean(config), 2)
  assert.equal(mean({ ...config, startWinStreak: 9 }), 1)
})

test('the PLATINUM split is omitted outside its interval and when bonuses are disabled', () => {
  const ranks = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => ({ ...rank, winProbability: 1 }))
  const beforeBoundary = settings({ targetLp: 15_400 })
  const truncated = ranks.filter(rank => rank.minimumLp < beforeBoundary.targetLp)
  assert.equal(createExpectedMatchConfig(beforeBoundary, truncated).ranks.length, truncated.length)
  const artificial = [{ id: 'ROOKIE', minimumLp: 0, winProbability: 1 }, { id: 'PLATINUM', minimumLp: 100, winProbability: 1 }]
  assert.equal(createExpectedMatchConfig(settings({ targetLp: 1000 }), artificial).ranks.length, 2)
  const withoutBonuses = createExpectedMatchConfig(settings({ useWinStreakBonus: false, startWinStreak: 9 }), ranks)
  assert.equal(withoutBonuses.ranks.length, ranks.length)
  assert.ok(withoutBonuses.ranks.every(rank => rank.winStreakBonuses === undefined))
  assert.equal(withoutBonuses.startWinStreak, 0)
  const shortPlatinum = ranks.map(rank => rank.id === 'DIAMOND' ? { ...rank, minimumLp: 15_000 } : rank)
  assert.equal(createExpectedMatchConfig(settings(), shortPlatinum).ranks.length, shortPlatinum.length)
})

test('zero can independently exclude upper PLATINUM and DIAMOND bonuses', () => {
  const ranks = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => ({ ...rank, winProbability: 1 }))
  for (const [startLp, targetLp, zeroBonus] of [
    [15_400, 15_600, { platinumUpperStreakBonus: 0 }],
    [19_000, 19_200, { diamondStreakBonus: 0 }],
  ] as const) {
    const source = ranks.filter(rank => rank.minimumLp < targetLp)
    const model = settings({ startLp, targetLp, startWinStreak: 10 })
    assert.equal(mean(createExpectedMatchConfig(model, source)), 1)
    assert.equal(mean(createExpectedMatchConfig({ ...model, ...zeroBonus }, source)), 4)
  }
})
