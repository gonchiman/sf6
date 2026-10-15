import type { MonthlyWinRateStatisticMetric, MonthlyWinRateStatisticsRow, MonthlyWinRateStatisticsValues } from './monthlyWinRateStatistics.ts'

export type MonthlyStatisticsMetric = MonthlyWinRateStatisticMetric | 'coefficientOfVariation'

export interface MonthlyStatisticDefinition<Metric extends MonthlyStatisticsMetric = MonthlyStatisticsMetric> {
  key: Metric
  label: string
  unit: '%' | 'ポイント' | '比率'
}

/** Shared display data without domain-specific source or exclusion metadata. */
export type MonthlyStatisticsRow = Pick<MonthlyWinRateStatisticsRow,
  'month' | 'status' | 'listedCount' | 'validCount'> & {
    statistics: (MonthlyWinRateStatisticsValues & { coefficientOfVariation?: number | null }) | null
  }

export interface MonthlyStatisticsSeries {
  league: string
  statistics: { rows: readonly MonthlyStatisticsRow[] }
}
