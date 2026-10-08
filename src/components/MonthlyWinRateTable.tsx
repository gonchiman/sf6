import { useEffect, useRef } from 'react'
import { formatHistoryValue, monthLabel } from '../lib/winRateHistory'
import type { WinRateHistoryPoint } from '../types/winRateHistory'
import '../table.css'
import '../win-rate-history-chart.css'

type Props = {
  points: readonly WinRateHistoryPoint[]
  selectedMonth: string
  onSelect: (month: string) => void
}

export function MonthlyWinRateTable({ points, selectedMonth, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<HTMLTableRowElement>(null)

  useEffect(() => {
    const viewport = scrollRef.current
    const row = selectedRowRef.current
    if (!viewport || !row) return
    const viewportBounds = viewport.getBoundingClientRect()
    const rowBounds = row.getBoundingClientRect()
    const headingHeight = viewport.querySelector('thead')?.getBoundingClientRect().height ?? 0
    const visibleTop = viewportBounds.top + viewport.clientTop + headingHeight
    const visibleBottom = viewportBounds.top + viewport.clientTop + viewport.clientHeight
    if (rowBounds.top < visibleTop) viewport.scrollTop += rowBounds.top - visibleTop
    else if (rowBounds.bottom > visibleBottom) viewport.scrollTop += rowBounds.bottom - visibleBottom
  }, [points, selectedMonth])

  return <div ref={scrollRef} className="data-table-scroll monthly-win-rate-scroll" role="region"
    tabIndex={0} aria-label="月別Total一覧・スクロール領域">
    <table className="data-table monthly-win-rate-table">
      <caption className="win-rate-history-visually-hidden">月別の公式Totalを百分率に換算した一覧</caption>
      <thead><tr><th scope="col">対象月</th><th scope="col">Total（%換算）</th></tr></thead>
      <tbody>{points.map((point) => <tr key={point.month}
        ref={point.month === selectedMonth ? selectedRowRef : undefined}
        className={point.month === selectedMonth ? 'is-selected' : undefined}>
        <th scope="row" className="monthly-win-rate-month">
          <button type="button" className="monthly-win-rate-month-button" aria-pressed={point.month === selectedMonth}
            aria-label={`${monthLabel(point.month)}を選択`} onClick={() => onSelect(point.month)}>
            {monthLabel(point.month)}
          </button>
        </th>
        <td className={point.status === 'value' ? 'monthly-win-rate-value' : 'monthly-win-rate-value is-unavailable'}>
          {formatHistoryValue(point)}
        </td>
      </tr>)}</tbody>
    </table>
  </div>
}
