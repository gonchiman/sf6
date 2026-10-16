import type { RankDistributionRow } from '../types/rankDistribution'
import '../table.css'

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const percentageLabel = (value: number | null) => value === null ? '—' : value.toFixed(2)

export function RankDistributionTable({ rows, label, estimated = false, categoryLabel = 'ランク',
  percentLabel = '全体比', cumulativeLabel = 'このランク以上', denominatorDescription }: {
  rows: readonly RankDistributionRow[]
  label: string
  estimated?: boolean
  categoryLabel?: string
  percentLabel?: string
  cumulativeLabel?: string
  denominatorDescription?: string
}) {
  return <div className="data-table-scroll rank-distribution-scroll" role="region" tabIndex={0}
    aria-label={`${label}・スクロール領域`}>
    <table className="data-table rank-distribution-table">
      <caption className="win-rates-visually-hidden">{label}。{denominatorDescription ?? (estimated
        ? '件数・割合・累積割合は取得期間中の概数です。分母は取得終了時の掲載アカウント総数です。'
        : '割合と以上累積の分母は掲載アカウント全体です。')}</caption>
      <colgroup><col className="rank-distribution-rank-column" /><col /><col /><col /></colgroup>
      <thead><tr>
        <th scope="col">{categoryLabel}</th>
        <th scope="col">アカウント数<span className="rank-distribution-unit">（件）</span></th>
        <th scope="col">{percentLabel}<span className="rank-distribution-unit">（%）</span></th>
        <th scope="col">{cumulativeLabel}<span className="rank-distribution-unit">（%）</span></th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <th scope="row">{row.label}</th>
        <td>{integerFormat.format(row.count)}</td>
        <td>{percentageLabel(row.percent)}</td>
        <td title={`${cumulativeLabel}${estimated ? '（概数）' : ''}：${integerFormat.format(row.cumulativeCount)}アカウント`}>{percentageLabel(row.cumulativePercent)}</td>
      </tr>)}</tbody>
    </table>
  </div>
}
