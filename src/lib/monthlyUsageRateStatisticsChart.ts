import { MONTHLY_STATISTIC_METRICS, monthlyStatisticDefinition, monthlyStatisticPoints, monthlyStatisticZeroBasedAxis } from './monthlyWinRateStatisticsChart.ts'
import type { MonthlyUsageRateStatisticMetric } from '../types/monthlyUsageRateStatistics.ts'
import type { MonthlyStatisticDefinition, MonthlyStatisticsRow, MonthlyStatisticsSeries } from '../types/monthlyStatisticsPresentation.ts'

export const MONTHLY_USAGE_STATISTIC_METRICS: readonly MonthlyStatisticDefinition<MonthlyUsageRateStatisticMetric>[] = [
  ...MONTHLY_STATISTIC_METRICS.slice(0, 3),
  monthlyStatisticDefinition('coefficientOfVariation'),
  ...MONTHLY_STATISTIC_METRICS.slice(3),
]

/** Usage statistics start at zero; they have no win-rate 50% reference. */
export function monthlyUsageStatisticAxis(rows: readonly MonthlyStatisticsRow[], metric: MonthlyUsageRateStatisticMetric) {
  const values = monthlyStatisticPoints(rows, metric).flatMap(point => point.value === null ? [] : [point.value])
  return monthlyStatisticZeroBasedAxis(values,
    metric === 'standardDeviationPoints' || metric === 'coefficientOfVariation' ? undefined : 100)
}

/** Share the same scale across leagues without pooling their character distributions. */
export function monthlyUsageLeagueStatisticAxis(series: readonly MonthlyStatisticsSeries[], metric: MonthlyUsageRateStatisticMetric) {
  return monthlyUsageStatisticAxis(series.flatMap(item => item.statistics.rows), metric)
}
