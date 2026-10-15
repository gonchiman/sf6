import type { buildBalanceAdjustmentOverview } from '../lib/balanceAdjustmentOverview'
import { COMMON_ADJUSTMENT_SCOPE } from './BalanceAdjustmentTable'
import { StatisticsPanel } from './StatisticsPanel'
import '../table.css'
import '../win-rate-history-chart.css'

type Props = {
  overview: ReturnType<typeof buildBalanceAdjustmentOverview>
  selectedScope: string | null
  detailsId: string
  dateLabel: string
  onSelect: (scope: string) => void
}

function Count({ value }: { value: number }) {
  return <td className="balance-adjustment-matrix-number" aria-label={`${value}項目`}>{value || '—'}</td>
}

export function BalanceAdjustmentOverview({ overview, selectedScope, detailsId, dateLabel, onSelect }: Props) {
  return <StatisticsPanel title="変更の概要" headerContent={<span className="monthly-statistics-panel-summary">
    {dateLabel} · 共通{overview.commonCount}項目・{overview.characterCount}キャラ・キャラ固有{overview.characterItemCount}項目
  </span>}>
    {overview.rows.length === 0 ? <p className="balance-adjustment-state">確認した変更はありません。</p> : <div
      className="data-table-scroll balance-adjustment-matrix-scroll" role="region" tabIndex={0}
      aria-label="対象・公式分類別の変更項目数・スクロール領域">
      <table className="data-table balance-adjustment-matrix-table">
        <caption className="win-rates-visually-hidden">{dateLabel}の対象・公式分類別の変更項目数</caption>
        <colgroup><col className="balance-adjustment-character-column" />{overview.categories.map(category => <col key={category.key} className="balance-adjustment-matrix-category-column" />)}<col className="balance-adjustment-count-column" /></colgroup>
        <thead><tr><th scope="col">対象</th>{overview.categories.map(category => <th key={category.key} scope="col">{category.label}</th>)}<th scope="col">項目数</th></tr></thead>
        <tbody>{overview.rows.map(row => {
          const scope = row.characterId ?? COMMON_ADJUSTMENT_SCOPE
          const selected = scope === selectedScope
          return <tr key={scope} className={selected ? 'is-selected' : undefined}>
            <th scope="row" className="monthly-win-rate-month"><button type="button" className="monthly-win-rate-month-button"
              aria-controls={detailsId} aria-pressed={selected} aria-label={`${row.name}のバトル変更詳細を表示`}
              onClick={() => onSelect(scope)}>{row.name}</button></th>
            {row.counts.map((count, index) => <Count key={overview.categories[index].key} value={count} />)}
            <Count value={row.total} />
          </tr>
        })}</tbody>
        <tfoot><tr><th scope="row">合計</th>{overview.totals.map((count, index) => <Count key={overview.categories[index].key} value={count} />)}<Count value={overview.total} /></tr></tfoot>
      </table>
    </div>}
  </StatisticsPanel>
}
