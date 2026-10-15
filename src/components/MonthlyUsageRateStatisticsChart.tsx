import { useMemo } from 'react'
import { monthlyUsageLeagueStatisticAxis } from '../lib/monthlyUsageRateStatisticsChart'
import { monthlyStatisticDefinition } from '../lib/monthlyWinRateStatisticsChart'
import type { LeagueUsageStatisticsSeries, MonthlyUsageRateStatisticMetric } from '../types/monthlyUsageRateStatistics'
import { MonthlyStatisticsChart } from './MonthlyStatisticsChart'

type Props = {
  series: readonly LeagueUsageStatisticsSeries[]
  metric: MonthlyUsageRateStatisticMetric
  selectedMonth: string
  onSelect: (month: string) => void
}

export function MonthlyUsageRateStatisticsChart(props: Props) {
  const { series, metric } = props
  const axis = useMemo(() => monthlyUsageLeagueStatisticAxis(series, metric), [series, metric])
  const definition = monthlyStatisticDefinition(metric)
  return <MonthlyStatisticsChart {...props} axis={axis}
    description={`リーグごとに各キャラの公式使用率から求めた${definition.label}の推移。全リーグを同じ縦軸で表示し、縦軸は0から始まります。${definition.unit === '比率' ? '値は標準偏差を平均で割った比率です。' : `縦軸の単位は${definition.unit}です。`}数値がない月はそのリーグの線をつなぎません。`} />
}
