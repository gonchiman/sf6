import { useMemo } from 'react'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { controlTypeBarStyle } from '../lib/controlTypeBarStyles'
import { formatUsageRateHistoryPoint, type createCharacterUsageRateHistory } from '../lib/usageRateHistory'
import { monthLabel } from '../lib/winRateHistory'
import { UsageRateHistorySeriesKey } from './UsageRateHistoryChart'
import '../table.css'
import '../win-rate-history-chart.css'

export function MonthlyUsageRateTable({ history, selectedMonth, onSelect }: {
  history: ReturnType<typeof createCharacterUsageRateHistory>
  selectedMonth: string
  onSelect: (month: string) => void
}) {
  const points = history.series[0]?.points ?? []
  const newestFirst = useMemo(() => points.map((point, index) => ({ point, index })).reverse(), [points])
  const { scrollRef, selectedRowRef } = useSelectedRowScroll(newestFirst, selectedMonth)
  return <div ref={scrollRef} className="data-table-scroll monthly-win-rate-scroll" role="region"
    tabIndex={0} aria-label="月別使用率一覧・スクロール領域">
    <table className="data-table monthly-win-rate-table" style={{ minWidth: 144 + history.series.length * 148 }}>
      <caption className="win-rate-history-visually-hidden">{history.characterName}の月別公式使用率（%）</caption>
      <colgroup><col style={{ width: 144 }} />{history.series.map(item => <col key={item.controlType} />)}</colgroup>
      <thead><tr><th scope="col">対象月</th>{history.series.map(item => <th key={item.controlType} scope="col">
        <span className="history-table-character"><UsageRateHistorySeriesKey controlType={item.controlType} />
          {controlTypeBarStyle(item.controlType).label}（%）</span>
      </th>)}</tr></thead>
      <tbody>{newestFirst.map(({ point, index }) => <tr key={point.month}
        ref={point.month === selectedMonth ? selectedRowRef : undefined}
        className={point.month === selectedMonth ? 'is-selected' : undefined}>
        <th scope="row" className="monthly-win-rate-month">
          <button type="button" className="monthly-win-rate-month-button" aria-pressed={point.month === selectedMonth}
            aria-label={`${monthLabel(point.month)}を選択`} onClick={() => onSelect(point.month)}>{monthLabel(point.month)}</button>
        </th>
        {history.series.map(item => {
          const value = item.points[index]
          return <td key={item.controlType} className={`monthly-win-rate-value${value?.status === 'value' ? '' : ' is-unavailable'}`}>
            {value ? formatUsageRateHistoryPoint(value) : '未登録'}
          </td>
        })}
      </tr>)}</tbody>
    </table>
  </div>
}
