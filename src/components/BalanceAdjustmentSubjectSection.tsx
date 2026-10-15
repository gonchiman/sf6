import { useId } from 'react'
import type { BalanceAdjustmentSource } from '../types/balanceAdjustments'
import type { BalanceAdjustmentChange } from '../types/balanceAdjustmentDetails'

type Props = {
  name: string
  changes: readonly BalanceAdjustmentChange[]
  source: BalanceAdjustmentSource
}

export function BalanceAdjustmentSubjectSection({ name, changes, source }: Props) {
  const titleId = useId()
  return <section className="balance-adjustment-subject" aria-labelledby={titleId}>
    <header className="balance-adjustment-subject-heading">
      <h3 id={titleId}>{name}</h3>
      <div className="balance-adjustment-subject-summary"><span>{changes.length}項目</span>
        <a href={source.url} target="_blank" rel="noreferrer" aria-label={`${name}の公式変更リスト（新しいタブ）`}>公式</a>
      </div>
    </header>
    <BalanceAdjustmentChangeTable name={name} changes={changes} />
  </section>
}

function BalanceAdjustmentChangeTable({ name, changes }: Pick<Props, 'name' | 'changes'>) {
  return <div className="data-table-scroll balance-adjustment-detail-scroll" role="region" tabIndex={0} aria-label={`${name}のバトル変更詳細・スクロール領域`}>
    <table className="data-table balance-adjustment-detail-table">
      <caption className="win-rates-visually-hidden">{name}の公式の変更箇所、分類、変更内容</caption>
      <colgroup><col className="balance-adjustment-target-column" /><col className="balance-adjustment-category-column" /><col /></colgroup>
      <thead><tr><th scope="col">変更箇所</th><th scope="col">分類</th><th scope="col">変更内容</th></tr></thead>
      <tbody>{changes.map(change => <tr key={change.id}>
        <th scope="row" className="balance-adjustment-description">{change.target || '—'}</th>
        <td>{change.categoryLabel || '—'}</td><td className="balance-adjustment-description">{change.description}</td>
      </tr>)}</tbody>
    </table>
  </div>
}
