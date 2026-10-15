import type {
  MonthlyWinRateStatisticMetric, MonthlyWinRateStatisticsMode, MonthlyWinRateStatisticsValues,
} from './monthlyWinRateStatistics.ts'
import type { UsageRateHistorySelection } from './usageRateHistory.ts'
import type { UsageRateDataset, UsageRateHistoryResult, UsageRateTotalMismatch } from './usageRates.ts'

export type MonthlyUsageRateStatisticsMode = MonthlyWinRateStatisticsMode
export type MonthlyUsageRateStatisticMetric = MonthlyWinRateStatisticMetric | 'coefficientOfVariation'

export interface MonthlyUsageRateStatisticsValues extends MonthlyWinRateStatisticsValues {
  /** Dimensionless population SD / actual retained mean, before display rounding. */
  coefficientOfVariation: number | null
}

export interface MonthlyUsageRateStatisticsSelection extends UsageRateHistorySelection {
  controlType: 'combined' | 'classic' | 'modern'
}

export interface MonthlyUsageRateStatisticsRow {
  month: string
  status: 'ready' | 'unavailable' | 'error' | 'incomplete'
  listedCount: number | null
  /** Number of retained character values, never a player or match count. */
  validCount: number | null
  excludedMissingCount: number | null
  excludedNonCommonCount: number | null
  characterIds: string[]
  statistics: MonthlyUsageRateStatisticsValues | null
  /** Sum of all valid source-distribution values, before common-character filtering. */
  publishedTotalPercent: number | null
  capturedAt: string | null
  generatedAt: string | null
  source: UsageRateDataset['source'] | null
  totalMismatch?: UsageRateTotalMismatch
}

export interface MonthlyUsageRateStatistics {
  mode: MonthlyUsageRateStatisticsMode
  commonCharacterCount: number | null
  commonUnavailable: boolean
  rows: MonthlyUsageRateStatisticsRow[]
}

export interface LeagueUsageStatisticsDatasetResults {
  league: string
  results: readonly UsageRateHistoryResult[]
}

export interface LeagueUsageStatisticsSeries {
  league: string
  statistics: MonthlyUsageRateStatistics
}
