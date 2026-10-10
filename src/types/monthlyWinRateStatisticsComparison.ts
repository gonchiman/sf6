import type { MonthlyWinRateStatistics } from './monthlyWinRateStatistics.ts'
import type { HistoryDatasetResult } from './winRateHistory.ts'

export interface LeagueStatisticsDatasetResults {
  league: string
  results: readonly HistoryDatasetResult[]
}

/** Every league retains its own population, exclusions, and common-character intersection. */
export interface LeagueStatisticsSeries {
  league: string
  statistics: MonthlyWinRateStatistics
}
