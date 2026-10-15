import { useMemo } from 'react'
import { monthlyLeagueStatisticAxis, monthlyStatisticDefinition, monthlyStatisticReference } from '../lib/monthlyWinRateStatisticsChart'
import type { MonthlyWinRateStatisticMetric } from '../types/monthlyWinRateStatistics'
import type { LeagueStatisticsSeries } from '../types/monthlyWinRateStatisticsComparison'
import { MonthlyStatisticsChart } from './MonthlyStatisticsChart'

type Props = {
  series: readonly LeagueStatisticsSeries[]
  metric: MonthlyWinRateStatisticMetric
  selectedMonth: string
  onSelect: (month: string) => void
}

export function MonthlyWinRateStatisticsChart(props: Props) {
  const { series, metric } = props
  const axis = useMemo(() => monthlyLeagueStatisticAxis(series, metric), [series, metric])
  const definition = monthlyStatisticDefinition(metric)
  const reference = monthlyStatisticReference(metric)
  return <MonthlyStatisticsChart {...props} axis={axis} reference={reference}
    description={`リーグごとにキャラ別公式Totalを百分率に換算した値から求めた${definition.label}の推移。全リーグを同じ縦軸で表示します。${reference ? '破線は比較の基準となる50%。' : '縦軸の単位はポイント。'}数値がない月はそのリーグの線をつなぎません。`} />
}
