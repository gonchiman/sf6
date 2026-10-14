import type { RankDistributionRow } from '../types/rankDistribution'
import '../table.css'

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const percentageLabel = (value: number | null) => value === null ? '—' : value.toFixed(2)

export function RankDistributionTable({ rows, label }: { rows: readonly RankDistributionRow[]; label: string }) {
  return <div className="data-table-scroll rank-distribution-scroll" role="region" tabIndex={0}
    aria-label={`${label}・スクロール領域`}>
    <table className="data-table rank-distribution-table">
      <caption className="win-rates-visually-hidden">{label}。割合と以上累積の分母は掲載アカウント全体です。</caption>
      <colgroup><col className="rank-distribution-rank-column" /><col /><col /><col /></colgroup>
      <thead><tr>
        <th scope="col">ランク</th>
        <th scope="col">掲載アカウント数<span className="rank-distribution-unit">（件）</span></th>
        <th scope="col">全体に占める割合<span className="rank-distribution-unit">（%）</span></th>
        <th scope="col">このランク以上<span className="rank-distribution-unit">累積割合（%）</span></th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <th scope="row">{row.label}</th>
        <td>{integerFormat.format(row.count)}</td>
        <td>{percentageLabel(row.percent)}</td>
        <td title={`このランク以上：${integerFormat.format(row.cumulativeCount)}アカウント`}>{percentageLabel(row.cumulativePercent)}</td>
      </tr>)}</tbody>
    </table>
  </div>
}
