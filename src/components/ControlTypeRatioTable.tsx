import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { monthLabel } from '../lib/winRateHistory'
import type { ControlTypeRatioRow } from '../types/controlTypeRatio'
import { ratioErrorLabel, ratioPercentLabel } from './controlTypeRatioFormatting'
import '../table.css'
import '../win-rate-history-chart.css'

type Props = {
  rows: readonly ControlTypeRatioRow[]
  selectedMonth: string | null
  onSelect: (month: string) => void
}

export function controlTypeRatioRowLabel(row: ControlTypeRatioRow): string {
  if (row.status === 'missing') return '未登録'
  if (row.status === 'error') return '読込失敗'
  if (row.status === 'unavailable') return `推定不可：${row.estimate?.reason ?? '条件を確認できません。'}`
  return '推定値'
}

export function ControlTypeRatioTable({ rows, selectedMonth, onSelect }: Props) {
  const { scrollRef, selectedRowRef } = useSelectedRowScroll(rows, selectedMonth, true)

  return <div ref={scrollRef} className="data-table-scroll control-ratio-scroll" role="region"
    tabIndex={0} aria-label="月別の操作タイプ比率・スクロール領域">
    <table className="data-table control-ratio-table">
      <caption className="win-rates-visually-hidden">公開された使用率から推定した月別のモダン・クラシック比率</caption>
      <colgroup><col className="control-ratio-month-column" /><col /><col /><col /><col /><col className="control-ratio-status-column" /></colgroup>
      <thead><tr>
        <th scope="col">対象月</th>
        <th scope="col">モダン<span className="control-ratio-unit">推定比率（%）</span></th>
        <th scope="col">クラシック<span className="control-ratio-unit">推定比率（%）</span></th>
        <th scope="col">比較キャラ数</th>
        <th scope="col">最大再現誤差<span className="control-ratio-unit">（ポイント）</span></th>
        <th scope="col">推定状態・理由</th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.month}
        ref={row.month === selectedMonth ? selectedRowRef : undefined}
        className={row.month === selectedMonth ? 'is-selected' : undefined}>
        <th scope="row" className="monthly-win-rate-month">
          <button type="button" className="monthly-win-rate-month-button" aria-pressed={row.month === selectedMonth}
            aria-label={`${monthLabel(row.month)}の計算根拠を選択`} onClick={() => onSelect(row.month)}>
            {monthLabel(row.month)}
          </button>
        </th>
        <td>{ratioPercentLabel(row.estimate?.modernRatio ?? null)}</td>
        <td>{ratioPercentLabel(row.estimate?.classicRatio ?? null)}</td>
        <td>{row.estimate?.characterCount ?? '—'}</td>
        <td>{ratioErrorLabel(row.estimate?.maxAbsoluteErrorPoints ?? null)}</td>
        <td className={`control-ratio-status${row.status !== 'estimated' ? ' is-unavailable' : ''}`}>
          {controlTypeRatioRowLabel(row)}
        </td>
      </tr>)}</tbody>
    </table>
  </div>
}
