import { useMemo } from 'react'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { formatMonthlyStatistic } from '../lib/monthlyWinRateStatistics'
import { MONTHLY_STATISTIC_METRICS, monthlyStatisticValue } from '../lib/monthlyWinRateStatisticsChart'
import { leagueLabel } from '../lib/winRateConditions'
import { monthLabel } from '../lib/winRateHistory'
import type { BalanceAdjustmentLoadState } from '../types/balanceAdjustments'
import type { MonthlyStatisticDefinition, MonthlyStatisticsMetric, MonthlyStatisticsRow, MonthlyStatisticsSeries } from '../types/monthlyStatisticsPresentation'
import { LeagueSeriesKey } from './LeagueSeriesKey'
import { BalanceAdjustmentCell } from './BalanceAdjustmentCell'
import '../table.css'
import '../win-rate-history-chart.css'

export type MonthlyStatisticsTableProps = {
  series: readonly MonthlyStatisticsSeries[]
  regionLabel: string
  caption: string
  selectedMonth: string | null
  onSelect: (month: string) => void
  selectedMetric?: MonthlyStatisticsMetric
  metricDefinitions?: readonly MonthlyStatisticDefinition[]
  adjustmentState: BalanceAdjustmentLoadState
  selectedAdjustmentId: string | null
  adjustmentDetailsId: string
  onSelectAdjustment: (id: string, triggerId: string) => void
}

function unavailableLabel(row: MonthlyStatisticsRow): string {
  if (row.status === 'unavailable') return '未登録'
  if (row.status === 'error') return '読込失敗'
  if (row.status === 'incomplete') return '共通キャラを確認できません'
  return '有効データなし'
}

function statisticValue(value: number | null) {
  return value === null ? <span aria-label="算出できません">—</span> : formatMonthlyStatistic(value)
}

export function MonthlyStatisticsTable({ series, selectedMonth, onSelect, selectedMetric, regionLabel, caption,
  metricDefinitions = MONTHLY_STATISTIC_METRICS,
  adjustmentState, selectedAdjustmentId, adjustmentDetailsId, onSelectAdjustment }: MonthlyStatisticsTableProps) {
  const rows = useMemo(() => series.flatMap((item, leagueIndex) => item.statistics.rows.map(row => ({
    league: item.league, leagueIndex, row,
  }))).sort((left, right) => left.row.month.localeCompare(right.row.month) || left.leagueIndex - right.leagueIndex), [series])
  const firstSelectedRowIndex = rows.findIndex(item => item.row.month === selectedMonth)
  const { scrollRef, selectedRowRef } = useSelectedRowScroll(rows, selectedMonth, true, series.length)
  const metricClass = (metric: MonthlyStatisticsMetric) => selectedMetric === metric ? 'is-metric' : undefined

  return <div ref={scrollRef} className="data-table-scroll monthly-statistics-scroll" role="region"
    tabIndex={0} aria-label={regionLabel}>
    <table className={`data-table monthly-statistics-table${metricDefinitions.length > 5 ? ' has-additional-metrics' : ''}`}>
      <caption className="win-rates-visually-hidden">{caption}</caption>
      <colgroup><col className="monthly-statistics-month-column" />
        <col className="monthly-statistics-league-column" />
        {metricDefinitions.map(metric => <col key={metric.key} />)}
        <col className="monthly-statistics-count-column" />
        <col className="monthly-statistics-adjustment-column" />
      </colgroup>
      <thead><tr>
        <th scope="col">対象月</th>
        <th scope="col">リーグ</th>
        {metricDefinitions.map(metric => <th key={metric.key} scope="col" className={metricClass(metric.key)}>
          {metric.label}{metric.unit === '%' ? '（%）' : <span className="monthly-statistics-unit">（{metric.unit}）</span>}
        </th>)}
        <th scope="col">対象／掲載<span className="monthly-statistics-unit">（キャラ数）</span></th>
        <th scope="col">バランス調整</th>
      </tr></thead>
      <tbody>{rows.map(({ league, row }, index) => <tr key={`${row.month}:${league}`}
        ref={index === firstSelectedRowIndex ? selectedRowRef : undefined}
        className={row.month === selectedMonth ? 'is-selected' : undefined}>
        <th scope="row" className="monthly-win-rate-month">
          <button type="button" className="monthly-win-rate-month-button" aria-pressed={row.month === selectedMonth}
            aria-label={`${monthLabel(row.month)} ${leagueLabel(league)}の月を選択`} onClick={() => onSelect(row.month)}>
            {monthLabel(row.month)}
          </button>
        </th>
        <th scope="row" className="monthly-statistics-league-cell">
          <span className="monthly-statistics-league-label"><LeagueSeriesKey league={league} /><span>{leagueLabel(league)}</span></span>
        </th>
        {row.statistics && row.statistics.meanPercent !== null ? metricDefinitions.map(metric =>
          <td key={metric.key} className={metricClass(metric.key)}>{statisticValue(monthlyStatisticValue(row, metric.key))}</td>)
          : <td colSpan={metricDefinitions.length} className="monthly-statistics-unavailable">{unavailableLabel(row)}</td>}
        <td>{row.listedCount === null ? '—' : `${row.validCount ?? '—'}／${row.listedCount}`}</td>
        <td className="monthly-statistics-adjustment-cell"><BalanceAdjustmentCell month={row.month} rowId={`${row.month}-${league}`} state={adjustmentState}
          selectedId={selectedAdjustmentId} detailsId={adjustmentDetailsId} onSelect={onSelectAdjustment} /></td>
      </tr>)}</tbody>
    </table>
  </div>
}
