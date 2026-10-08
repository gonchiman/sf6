import { useEffect, useRef } from 'react'
import { formatMonthlyStatistic } from '../lib/monthlyWinRateStatistics'
import { monthLabel } from '../lib/winRateHistory'
import type { MonthlyWinRateStatisticsRow } from '../types/monthlyWinRateStatistics'
import '../table.css'

function unavailableLabel(row: MonthlyWinRateStatisticsRow): string {
  if (row.status === 'unavailable') return '未登録'
  if (row.status === 'error') return '読込失敗'
  if (row.status === 'incomplete') return '共通キャラを確認できません'
  return '有効データなし'
}

function statisticValue(value: number | null) {
  return value === null ? <span aria-label="算出できません">—</span> : formatMonthlyStatistic(value)
}

export function MonthlyWinRateStatisticsTable({ rows }: { rows: readonly MonthlyWinRateStatisticsRow[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
      scrollRef.current.scrollLeft = 0
    }
  }, [rows])

  return <div ref={scrollRef} className="data-table-scroll monthly-statistics-scroll" role="region"
    tabIndex={0} aria-label="月別勝率統計・スクロール領域">
    <table className="data-table monthly-statistics-table">
      <caption className="win-rates-visually-hidden">各月のキャラ別公式Totalを百分率に換算した統計量</caption>
      <colgroup><col className="monthly-statistics-month-column" />
        {Array.from({ length: 5 }, (_, index) => <col key={index} />)}
        <col className="monthly-statistics-count-column" />
      </colgroup>
      <thead><tr>
        <th scope="col">対象月</th>
        <th scope="col">平均（%）</th>
        <th scope="col">中央値（%）</th>
        <th scope="col">標準偏差<span className="monthly-statistics-unit">（ポイント）</span></th>
        <th scope="col">最小（%）</th>
        <th scope="col">最大（%）</th>
        <th scope="col">対象／掲載<span className="monthly-statistics-unit">（キャラ数）</span></th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.month}>
        <th scope="row">{monthLabel(row.month)}</th>
        {row.statistics && row.statistics.meanPercent !== null ? <>
          <td>{statisticValue(row.statistics.meanPercent)}</td>
          <td>{statisticValue(row.statistics.medianPercent)}</td>
          <td>{statisticValue(row.statistics.standardDeviationPoints)}</td>
          <td>{statisticValue(row.statistics.minimumPercent)}</td>
          <td>{statisticValue(row.statistics.maximumPercent)}</td>
        </> : <td colSpan={5} className="monthly-statistics-unavailable">{unavailableLabel(row)}</td>}
        <td>{row.listedCount === null ? '—' : `${row.validCount ?? '—'}／${row.listedCount}`}</td>
      </tr>)}</tbody>
    </table>
  </div>
}
