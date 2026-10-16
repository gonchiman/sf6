import { useMemo, useState } from 'react'
import type { createLegendCharacterRows } from '../lib/legendAnalysis'
import '../table.css'

type CharacterRow = ReturnType<typeof createLegendCharacterRows>[number]
type SortKey = 'name' | 'count' | 'percent' | 'countDelta' | 'percentagePointDelta'
type Props = { rows: readonly CharacterRow[]; names: ReadonlyMap<string, string> | null }

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const numberFormat = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const percentLabel = (value: number | null) => value === null ? '—' : numberFormat.format(value)
const differenceLabel = (value: number | null, fraction = false) => {
  if (value === null) return '—'
  const displayed = fraction && Math.abs(value) < .005 ? 0 : value
  return `${displayed > 0 ? '+' : ''}${fraction ? numberFormat.format(displayed) : integerFormat.format(displayed)}`
}
const HEADINGS: { key: SortKey; label: string; unit?: string }[] = [
  { key: 'name', label: 'キャラ' },
  { key: 'count', label: '掲載数', unit: '件' },
  { key: 'percent', label: '構成比', unit: '%' },
  { key: 'countDelta', label: '前回件数差', unit: '件' },
  { key: 'percentagePointDelta', label: '前回構成比差', unit: 'pp' },
]

export function LegendCharacterTable({ rows, names }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: 'count', ascending: false })
  const name = (row: CharacterRow) => names?.get(row.characterId) ?? row.name
  const sorted = useMemo(() => [...rows].sort((left, right) => {
    if (sort.key === 'name') return (names?.get(left.characterId) ?? left.name)
      .localeCompare(names?.get(right.characterId) ?? right.name, 'ja') * (sort.ascending ? 1 : -1)
      || left.characterId.localeCompare(right.characterId)
    const a = left[sort.key]
    const b = right[sort.key]
    if (a === null || b === null) return a === b ? left.characterId.localeCompare(right.characterId) : a === null ? 1 : -1
    return (a - b) * (sort.ascending ? 1 : -1) || left.characterId.localeCompare(right.characterId)
  }), [rows, names, sort])

  return <div className="data-table-scroll legend-analysis-character-scroll" role="region" tabIndex={0}
    aria-label="レジェンド帯のキャラ構成・スクロール領域">
    <table className="data-table legend-analysis-character-table">
      <caption className="win-rates-visually-hidden">掲載エントリーのキャラ構成。1アカウントと1キャラの組を1件とします。構成比の分母は各回の掲載総数です。前回構成比差の単位ppはパーセントポイントです。</caption>
      <colgroup><col /><col /><col /><col /><col /></colgroup>
      <thead><tr>{HEADINGS.map(heading => {
        const active = sort.key === heading.key
        const nextAscending = active ? !sort.ascending : heading.key === 'name'
        return <th key={heading.key} scope="col" aria-sort={active ? sort.ascending ? 'ascending' : 'descending' : 'none'}>
          <button className="legend-analysis-sort" type="button"
            aria-label={`${heading.label}を${nextAscending ? '昇順' : '降順'}に並べる`}
            onClick={() => setSort({ key: heading.key, ascending: nextAscending })}>
            <span>{heading.label}{heading.unit && <span className="legend-analysis-unit">（{heading.unit}）</span>}</span>
            <span className="legend-analysis-sort-indicator" aria-hidden="true">{active ? sort.ascending ? '▲' : '▼' : '↕'}</span>
          </button>
        </th>
      })}</tr></thead>
      <tbody>{sorted.map(row => <tr key={row.characterId}>
        <th scope="row">{name(row)}</th>
        <td>{integerFormat.format(row.count)}</td>
        <td className="legend-analysis-share-cell">
          {row.percent !== null && <span className="legend-analysis-share-bar" style={{ width: `${row.percent}%` }} aria-hidden="true" />}
          <span className="legend-analysis-share-value">{percentLabel(row.percent)}</span>
        </td>
        <td className={row.countDelta === null ? 'legend-analysis-unavailable' : undefined}>{differenceLabel(row.countDelta)}</td>
        <td className={row.percentagePointDelta === null ? 'legend-analysis-unavailable' : undefined}>{differenceLabel(row.percentagePointDelta, true)}</td>
      </tr>)}
        {sorted.length === 0 && <tr><td colSpan={5}>表示するキャラがありません。</td></tr>}
      </tbody>
    </table>
  </div>
}
