import { DEFAULT_EXPECTED_MATCH_MODEL } from './expectedMatches.ts'
import type { ExpectedMatchRank, ExpectedMatchesConfig } from '../types/expectedMatches.ts'
import type { ExpectedMatchSettings } from '../types/expectedMatchData.ts'

/** Editable reference assumptions; zero high-rank bonuses mean they are excluded. */
export const DEFAULT_EXPECTED_MATCH_SETTINGS: ExpectedMatchSettings = {
  ...DEFAULT_EXPECTED_MATCH_MODEL,
  startWinStreak: 0,
  useRankRules: true,
  useWinStreakBonus: true,
  lowRankBonusStep: 50,
  platinumStreakBonus: 500,
  platinumUpperStreakBonus: 1_000,
  diamondStreakBonus: 1_000,
}

export const EXPECTED_MATCH_RULE_SOURCES = {
  rankRules: 'https://news.capcomusa.com/2023/04/20/street-fighter-6-showcase-recap/',
  bonusAssumptions: 'https://kakuge-focus.com/ranked-match-system/',
} as const

const LOW_RANKS = new Set(['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD'])
export const EXPECTED_MATCH_PLATINUM_UPPER_MINIMUM_LP = 15_400

export function createExpectedMatchConfig(
  settings: ExpectedMatchSettings,
  ranks: readonly ExpectedMatchRank[],
): ExpectedMatchesConfig {
  const goldFloor = ranks.find(rank => rank.id === 'GOLD')?.minimumLp ?? 0
  return {
    startLp: settings.startLp,
    targetLp: settings.targetLp,
    winLp: settings.winLp,
    lossLp: settings.lossLp,
    startWinStreak: settings.useWinStreakBonus ? settings.startWinStreak : 0,
    ranks: ranks.flatMap((rank, index) => {
      const lowRank = LOW_RANKS.has(rank.id)
      const highRankBonus = rank.id === 'PLATINUM'
        ? rank.minimumLp >= EXPECTED_MATCH_PLATINUM_UPPER_MINIMUM_LP
          ? settings.platinumUpperStreakBonus : settings.platinumStreakBonus
        : rank.id === 'DIAMOND' ? settings.diamondStreakBonus : 0
      const configuredRank = {
        ...rank,
        ...(settings.useRankRules ? {
          lossLp: rank.id === 'ROOKIE' ? 0 : settings.lossLp,
          lossFloorLp: lowRank ? rank.minimumLp : Math.min(rank.minimumLp, goldFloor),
        } : {}),
        ...(settings.useWinStreakBonus ? {
          winStreakBonuses: Array.from({ length: 11 }, (_, streak) => lowRank
            ? Math.max(0, streak - 2) * settings.lowRankBonusStep
            : streak >= 10 ? highRankBonus : 0),
        } : {}),
      }
      // Split only the modeled PLATINUM interval. The data still provides one
      // PLATINUM probability, shared by both star bands; no extra source is inferred.
      const upperMinimumLp = EXPECTED_MATCH_PLATINUM_UPPER_MINIMUM_LP
      const intervalEnd = Math.min(ranks[index + 1]?.minimumLp ?? settings.targetLp, settings.targetLp)
      if (settings.useWinStreakBonus && rank.id === 'PLATINUM'
        && rank.minimumLp < upperMinimumLp && upperMinimumLp < intervalEnd) {
        return [configuredRank, {
          ...configuredRank,
          id: 'PLATINUM_STAR_3_5',
          minimumLp: upperMinimumLp,
          winStreakBonuses: Array.from({ length: 11 }, (_, streak) => streak >= 10 ? settings.platinumUpperStreakBonus : 0),
        }]
      }
      return [configuredRank]
    }),
  }
}
