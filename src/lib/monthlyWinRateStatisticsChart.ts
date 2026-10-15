import { formatMonthlyStatistic } from './monthlyWinRateStatistics.ts'
import { monthlyPercentAxis } from './monthlyLineChart.ts'
import { leagueSeriesStyle } from './leagueSeriesColors.ts'
import { leagueLabel } from './winRateConditions.ts'
import type { MonthlyLineChartPoint, MonthlyLineChartSeries } from '../types/monthlyLineChart.ts'
import type { MonthlyWinRateStatisticMetric } from '../types/monthlyWinRateStatistics.ts'
import type { MonthlyStatisticDefinition, MonthlyStatisticsMetric, MonthlyStatisticsRow, MonthlyStatisticsSeries } from '../types/monthlyStatisticsPresentation.ts'

export const MONTHLY_STATISTIC_METRICS: readonly MonthlyStatisticDefinition<MonthlyWinRateStatisticMetric>[] = [
  { key: 'meanPercent', label: '平均', unit: '%' },
  { key: 'medianPercent', label: '中央値', unit: '%' },
  { key: 'standardDeviationPoints', label: '標準偏差', unit: 'ポイント' },
  { key: 'minimumPercent', label: '最小', unit: '%' },
  { key: 'maximumPercent', label: '最大', unit: '%' },
]

export function monthlyStatisticDefinition(metric: MonthlyStatisticsMetric): MonthlyStatisticDefinition {
  if (metric === 'coefficientOfVariation') return { key: metric, label: '変動係数', unit: '比率' }
  const definition = MONTHLY_STATISTIC_METRICS.find(item => item.key === metric)
  if (!definition) throw new Error('統計量の指定が正しくありません。')
  return definition
}

export function monthlyStatisticReference(metric: MonthlyWinRateStatisticMetric): { value: number; label: string } | undefined {
  return metric === 'standardDeviationPoints' ? undefined : { value: 50, label: '50% 基準' }
}

/** Project a retained statistic without rounding, rescaling, or replacing missing values. */
export function monthlyStatisticValue(row: MonthlyStatisticsRow, metric: MonthlyStatisticsMetric): number | null {
  if (row.status !== 'ready') return null
  const value = row.statistics?.[metric]
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null
  if (metric === 'coefficientOfVariation') {
    if (row.statistics?.meanPercent === null || row.statistics?.meanPercent === undefined
      || row.statistics.meanPercent <= 0 || row.statistics.standardDeviationPoints === null) return null
  } else if (metric !== 'standardDeviationPoints' && value > 100) return null
  return value
}

export function monthlyStatisticValueLabel(row: MonthlyStatisticsRow, metric: MonthlyStatisticsMetric): string {
  const definition = monthlyStatisticDefinition(metric)
  const value = monthlyStatisticValue(row, metric)
  if (value !== null) {
    return `${formatMonthlyStatistic(value)}${definition.unit === '%' ? '%' : definition.unit === 'ポイント' ? ' ポイント' : ''}`
  }
  if (row.status === 'unavailable') return '未登録'
  if (row.status === 'error') return '読込失敗'
  if (row.status === 'incomplete') return '共通キャラを確認できません'
  if (row.validCount === 0) return '有効データなし'
  if ((metric === 'standardDeviationPoints' || metric === 'coefficientOfVariation') && row.validCount === 1) return '算出できません（対象が1キャラ）'
  return '算出できません'
}

export function monthlyStatisticPoints(
  rows: readonly MonthlyStatisticsRow[], metric: MonthlyStatisticsMetric,
): MonthlyLineChartPoint[] {
  return rows.map(row => ({ month: row.month, value: monthlyStatisticValue(row, metric) }))
}

/** A zero-based deviation axis with headroom and readable ticks, including the all-zero case. */
export function monthlyStatisticZeroBasedAxis(values: readonly number[], limit?: number) {
  const maximum = Math.max(0, ...values)
  if (maximum === 0) return { start: 0, end: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] }
  const padded = Math.min(limit ?? Number.POSITIVE_INFINITY, maximum * 1.12)
  const roughStep = padded / 5
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const factor = [1, 2, 2.5, 5, 10].find(candidate => candidate * magnitude >= roughStep) ?? 10
  const step = factor * magnitude
  const count = Math.ceil(padded / step)
  // Remove binary decimal artifacts from ticks only; plotted values remain untouched.
  const ticks = Array.from({ length: count + 1 }, (_, index) => Number((index * step).toPrecision(12)))
    .filter(value => limit === undefined || value <= limit)
  if (limit !== undefined && ticks.at(-1)! < maximum) ticks.push(limit)
  return { start: 0, end: ticks[ticks.length - 1], step, ticks }
}

export function monthlyStatisticAxis(rows: readonly MonthlyStatisticsRow[], metric: MonthlyWinRateStatisticMetric) {
  const values = monthlyStatisticPoints(rows, metric).flatMap(point => point.value === null ? [] : [point.value])
  return metric === 'standardDeviationPoints' ? monthlyStatisticZeroBasedAxis(values) : monthlyPercentAxis(values)
}

/** Keep each league's observations separate; a missing month only splits that league. */
export function monthlyLeagueStatisticSeries(
  series: readonly MonthlyStatisticsSeries[], metric: MonthlyStatisticsMetric,
): MonthlyLineChartSeries[] {
  return series.map(item => ({
    id: item.league, label: leagueLabel(item.league), style: leagueSeriesStyle(item.league),
    points: monthlyStatisticPoints(item.statistics.rows, metric),
  }))
}

/** One axis covers every displayed league; these observations are not combined into new statistics. */
export function monthlyLeagueStatisticAxis(series: readonly MonthlyStatisticsSeries[], metric: MonthlyWinRateStatisticMetric) {
  return monthlyStatisticAxis(series.flatMap(item => item.statistics.rows), metric)
}

/** Match tick precision to the chosen step so small deviations have distinct labels. */
export function formatMonthlyStatisticTick(value: number, step: number): string {
  let decimals = 0
  while (decimals < 10 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-8) decimals += 1
  return value.toFixed(decimals)
}
