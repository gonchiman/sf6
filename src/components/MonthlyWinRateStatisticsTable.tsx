import { useMemo } from 'react'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { formatMonthlyStatistic } from '../lib/monthlyWinRateStatistics'
import { leagueLabel } from '../lib/winRateConditions'
import { monthLabel } from '../lib/winRateHistory'
import type { MonthlyWinRateStatisticMetric, MonthlyWinRateStatisticsRow } from '../types/monthlyWinRateStatistics'
import type { LeagueStatisticsSeries } from '../types/monthlyWinRateStatisticsComparison'
import { LeagueSeriesKey } from './LeagueSeriesKey'
import '../table.css'
import '../win-rate-history-chart.css'

type Props = {
  series: readonly LeagueStatisticsSeries[]
  selectedMonth: string | null
  onSelect: (month: string) => void
  selectedMetric?: MonthlyWinRateStatisticMetric
}

function unavailableLabel(row: MonthlyWinRateStatisticsRow): string {
  if (row.status === 'unavailable') return '未登録'
  if (row.status === 'error') return '読込失敗'
  if (row.status === 'incomplete') return '共通キャラを確認できません'
  return '有効データなし'
}

function statisticValue(value: number | null) {
  return value === null ? <span aria-label="算出できません">—</span> : formatMonthlyStatistic(value)
}

export function MonthlyWinRateStatisticsTable({ series, selectedMonth, onSelect, selectedMetric }: Props) {
  const rows = useMemo(() => series.flatMap((item, leagueIndex) => item.statistics.rows.map(row => ({
    league: item.league, leagueIndex, row,
  }))).sort((left, right) => left.row.month.localeCompare(right.row.month) || left.leagueIndex - right.leagueIndex), [series])
  const firstSelectedRowIndex = rows.findIndex(item => item.row.month === selectedMonth)
  const { scrollRef, selectedRowRef } = useSelectedRowScroll(rows, selectedMonth, true, series.length)
  const metricClass = (metric: MonthlyWinRateStatisticMetric) => selectedMetric === metric ? 'is-metric' : undefined

  return <div ref={scrollRef} className="data-table-scroll monthly-statistics-scroll" role="region"
    tabIndex={0} aria-label="月別勝率統計・スクロール領域">
    <table className="data-table monthly-statistics-table">
      <caption className="win-rates-visually-hidden">各月・リーグのキャラ別公式Totalを百分率に換算した統計量</caption>
      <colgroup><col className="monthly-statistics-month-column" />
        <col className="monthly-statistics-league-column" />
        {Array.from({ length: 5 }, (_, index) => <col key={index} />)}
        <col className="monthly-statistics-count-column" />
      </colgroup>
      <thead><tr>
        <th scope="col">対象月</th>
        <th scope="col">リーグ</th>
        <th scope="col" className={metricClass('meanPercent')}>平均（%）</th>
        <th scope="col" className={metricClass('medianPercent')}>中央値（%）</th>
        <th scope="col" className={metricClass('standardDeviationPoints')}>標準偏差<span className="monthly-statistics-unit">（ポイント）</span></th>
        <th scope="col" className={metricClass('minimumPercent')}>最小（%）</th>
        <th scope="col" className={metricClass('maximumPercent')}>最大（%）</th>
        <th scope="col">対象／掲載<span className="monthly-statistics-unit">（キャラ数）</span></th>
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
        {row.statistics && row.statistics.meanPercent !== null ? <>
          <td className={metricClass('meanPercent')}>{statisticValue(row.statistics.meanPercent)}</td>
          <td className={metricClass('medianPercent')}>{statisticValue(row.statistics.medianPercent)}</td>
          <td className={metricClass('standardDeviationPoints')}>{statisticValue(row.statistics.standardDeviationPoints)}</td>
          <td className={metricClass('minimumPercent')}>{statisticValue(row.statistics.minimumPercent)}</td>
          <td className={metricClass('maximumPercent')}>{statisticValue(row.statistics.maximumPercent)}</td>
        </> : <td colSpan={5} className="monthly-statistics-unavailable">{unavailableLabel(row)}</td>}
        <td>{row.listedCount === null ? '—' : `${row.validCount ?? '—'}／${row.listedCount}`}</td>
      </tr>)}</tbody>
    </table>
  </div>
}
