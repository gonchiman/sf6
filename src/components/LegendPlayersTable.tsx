import { useMemo, useState } from 'react'
import { sortLegendPlayers } from '../lib/legendPlayers'
import type { LegendPlayerRow, LegendPlayerSortDirection, LegendPlayerSortKey } from '../types/legendPlayers'
import '../table.css'

type Props = {
  rows: readonly LegendPlayerRow[]
  names: ReadonlyMap<string, string> | null
  emptyMessage?: string
  loading?: boolean
}

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const HEADINGS: { key: LegendPlayerSortKey; label: string }[] = [
  { key: 'rank', label: '順位' },
  { key: 'playerName', label: 'プレイヤー' },
  { key: 'characterId', label: 'キャラ' },
  { key: 'masterRating', label: 'MR' },
]

export function LegendPlayersTable({ rows, names, emptyMessage = '0件（取得確認済み）', loading = false }: Props) {
  const [sort, setSort] = useState<{ key: LegendPlayerSortKey; direction: LegendPlayerSortDirection }>({ key: 'rank', direction: 'asc' })
  const sorted = useMemo(() => sortLegendPlayers(rows, sort.key, sort.direction, names ?? undefined), [rows, sort, names])

  return <div className="data-table-scroll legend-players-scroll" role="region" tabIndex={0}
    aria-label="レジェンド帯のプレイヤー一覧・スクロール領域" aria-busy={loading || undefined}>
    <table className="data-table legend-players-table">
      <caption className="win-rates-visually-hidden">レジェンド帯のプレイヤー一覧（アカウント×キャラ単位）</caption>
      <colgroup><col className="legend-players-rank-column" /><col /><col className="legend-players-character-column" /><col className="legend-players-mr-column" /></colgroup>
      <thead><tr>{HEADINGS.map(heading => {
        const active = sort.key === heading.key
        const nextDirection = active ? sort.direction === 'asc' ? 'desc' : 'asc' : heading.key === 'masterRating' ? 'desc' : 'asc'
        return <th key={heading.key} scope="col" aria-sort={active ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
          <button className="legend-players-sort" type="button" disabled={rows.length === 0}
            aria-label={`${heading.label}を${nextDirection === 'asc' ? '昇順' : '降順'}に並べる`}
            onClick={() => setSort({ key: heading.key, direction: nextDirection })}>
            <span>{heading.label}</span>
            <span className="legend-players-sort-indicator" aria-hidden="true">{active ? sort.direction === 'asc' ? '▲' : '▼' : '↕'}</span>
          </button>
        </th>
      })}</tr></thead>
      <tbody>{sorted.map(row => <tr key={row.id}>
        <td className="legend-players-number">{integerFormat.format(row.rank)}</td>
        <th scope="row" className="legend-players-name"><bdi>{row.playerName}</bdi></th>
        <td className="legend-players-character">{names?.get(row.characterId) ?? row.characterId}</td>
        <td className="legend-players-number">{integerFormat.format(row.masterRating)}</td>
      </tr>)}
        {sorted.length === 0 && <tr><td colSpan={4} className="legend-players-empty" role="status">{emptyMessage}</td></tr>}
      </tbody>
    </table>
  </div>
}
