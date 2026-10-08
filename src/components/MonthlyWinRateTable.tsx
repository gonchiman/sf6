import { useEffect, useRef } from 'react'
import { formatHistoryValue, monthLabel } from '../lib/winRateHistory'
import type { WinRateHistorySeries } from '../types/winRateHistory'
import { CharacterSeriesKey } from './CharacterSeriesKey'
import '../table.css'
import '../win-rate-history-chart.css'

type Props = {
  series: readonly WinRateHistorySeries[]
  selectedMonth: string
  onSelect: (month: string) => void
}

export function MonthlyWinRateTable({ series, selectedMonth, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<HTMLTableRowElement>(null)
  const points = series[0]?.points ?? []

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
    <table className="data-table monthly-win-rate-table" style={{ minWidth: 144 + series.length * 148 }}>
      <caption className="win-rate-history-visually-hidden">月別の公式Totalを百分率に換算した一覧</caption>
      <colgroup><col style={{ width: 144 }} />{series.map(item => <col key={item.characterId} />)}</colgroup>
      <thead><tr><th scope="col">対象月</th>{series.map(item => <th key={item.characterId} scope="col">
        <span className="history-table-character"><CharacterSeriesKey characterId={item.characterId} /><span>{item.characterName}</span></span>
      </th>)}</tr></thead>
      <tbody>{points.map((point, index) => <tr key={point.month}
        ref={point.month === selectedMonth ? selectedRowRef : undefined}
        className={point.month === selectedMonth ? 'is-selected' : undefined}>
        <th scope="row" className="monthly-win-rate-month">
          <button type="button" className="monthly-win-rate-month-button" aria-pressed={point.month === selectedMonth}
            aria-label={`${monthLabel(point.month)}を選択`} onClick={() => onSelect(point.month)}>
            {monthLabel(point.month)}
          </button>
        </th>
        {series.map(item => {
          const value = item.points[index]
          return <td key={item.characterId} className={value?.status === 'value' ? 'monthly-win-rate-value' : 'monthly-win-rate-value is-unavailable'}>
            {value ? formatHistoryValue(value) : '未登録'}
          </td>
        })}
      </tr>)}</tbody>
    </table>
  </div>
}
