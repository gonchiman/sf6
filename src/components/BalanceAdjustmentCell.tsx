import { balanceAdjustmentsForMonth, balanceAdjustmentShortDate } from '../lib/balanceAdjustments'
import type { BalanceAdjustmentLoadState } from '../types/balanceAdjustments'

export function BalanceAdjustmentCell({ month, rowId, state, selectedId, detailsId, onSelect }: {
  month: string
  rowId: string
  state: BalanceAdjustmentLoadState
  selectedId: string | null
  detailsId: string
  onSelect: (id: string, triggerId: string) => void
}) {
  if (state.status === 'loading') return <span className="monthly-adjustment-state">読込中…</span>
  if (state.status === 'error') return <span className="monthly-adjustment-state">読込失敗</span>
  const result = balanceAdjustmentsForMonth(state.catalog, month)
  if (result.status === 'unverified') return <span className="monthly-adjustment-state">履歴未確認</span>
  if (result.events.length === 0) return <span className="monthly-adjustment-state" aria-label="確認した履歴に変更なし">—</span>

  return <div className="monthly-adjustment-events">{result.events.map(event => <div key={event.id} className="monthly-adjustment-event">
    <button type="button" id={`${detailsId}-trigger-${rowId}-${event.id}`} className="monthly-adjustment-date"
      aria-label={`${event.date}、${event.kindLabel}${event.dateBasis === 'list' ? '、リスト日' : '、実施日'}の詳細`}
      aria-expanded={selectedId === event.id} aria-controls={detailsId}
      onClick={() => onSelect(event.id, `${detailsId}-trigger-${rowId}-${event.id}`)}>
      {balanceAdjustmentShortDate(event)}
    </button>
    <span className="monthly-adjustment-kind">{event.kindLabel}</span>
  </div>)}</div>
}
