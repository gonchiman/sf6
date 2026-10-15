import { useMemo } from 'react'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { formatUsageRateHistoryPoint } from '../lib/usageRateHistory'
import { monthLabel } from '../lib/winRateHistory'
import type { UsageRateComparisonSeries } from '../types/usageRateComparison'
import { UsageRateHistorySeriesKey } from './UsageRateHistoryChart'
import '../table.css'
import '../win-rate-history-chart.css'

export function MonthlyUsageRateTable({ series, selectedMonth, onSelect }: {
  series: readonly UsageRateComparisonSeries[]
  selectedMonth: string
  onSelect: (month: string) => void
}) {
  const newestFirst = useMemo(() => {
    const months = [...new Set(series.flatMap(item => item.points.map(point => point.month)))].sort().reverse()
    return months.map(month => ({ month, points: series.map(item => item.points.find(point => point.month === month)) }))
  }, [series])
  const { scrollRef, selectedRowRef } = useSelectedRowScroll(newestFirst, selectedMonth)
  return <div ref={scrollRef} className="data-table-scroll monthly-win-rate-scroll" role="region"
    tabIndex={0} aria-label="月別使用率一覧・スクロール領域">
    <table className="data-table monthly-win-rate-table usage-rate-comparison-table" style={{ minWidth: 144 + series.length * 200 }}>
      <caption className="win-rate-history-visually-hidden">系列ごとの月別公式使用率（%）</caption>
      <colgroup><col style={{ width: 144 }} />{series.map(item => <col key={item.seriesId} />)}</colgroup>
      <thead><tr><th scope="col">対象月</th>{series.map(item => <th key={item.seriesId} scope="col">
        <span className="history-table-character"><UsageRateHistorySeriesKey colorSlot={item.colorSlot} />
          <span>{item.label}（%）</span></span>
      </th>)}</tr></thead>
      <tbody>{newestFirst.map(({ month, points }) => <tr key={month}
        ref={month === selectedMonth ? selectedRowRef : undefined}
        className={month === selectedMonth ? 'is-selected' : undefined}>
        <th scope="row" className="monthly-win-rate-month">
          <button type="button" className="monthly-win-rate-month-button" aria-pressed={month === selectedMonth}
            aria-label={`${monthLabel(month)}を選択`} onClick={() => onSelect(month)}>{monthLabel(month)}</button>
        </th>
        {series.map((item, index) => {
          const value = points[index]
          return <td key={item.seriesId} className={`monthly-win-rate-value${value?.status === 'value' ? '' : ' is-unavailable'}`}>
            {value ? formatUsageRateHistoryPoint(value) : '未登録'}
          </td>
        })}
      </tr>)}</tbody>
    </table>
  </div>
}
