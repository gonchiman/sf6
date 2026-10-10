import type { WinRateDataset } from './winRates.ts'

export type MonthlyWinRateStatisticsMode = 'monthly' | 'common'

export type MonthlyWinRateStatisticMetric =
  | 'meanPercent'
  | 'medianPercent'
  | 'standardDeviationPoints'
  | 'minimumPercent'
  | 'maximumPercent'

export interface MonthlyWinRateStatisticsValues {
  meanPercent: number | null
  medianPercent: number | null
  standardDeviationPoints: number | null
  minimumPercent: number | null
  maximumPercent: number | null
}

export interface MonthlyWinRateStatisticsRow {
  month: string
  status: 'ready' | 'unavailable' | 'error' | 'incomplete'
  listedCount: number | null
  /** Number of characters used in the statistics, not a match count. */
  validCount: number | null
  /** Exclusion reasons are disjoint: missing values take priority over low-sample flags. */
  excludedMissingCount: number | null
  excludedLowSampleCount: number | null
  excludedNonCommonCount: number | null
  characterIds: string[]
  statistics: MonthlyWinRateStatisticsValues | null
  capturedAt: string | null
  source: WinRateDataset['source'] | null
}

export interface MonthlyWinRateStatistics {
  mode: MonthlyWinRateStatisticsMode
  /** Also available in monthly mode, for the period's common-character information. */
  commonCharacterCount: number | null
  commonUnavailable: boolean
  rows: MonthlyWinRateStatisticsRow[]
}
