import { useEffect, useMemo, useRef, useState } from 'react'
import { sortCharacterControlTypeRatioRows } from '../lib/characterControlTypeRatio'
import type { CharacterControlTypeRatioRow, CharacterControlTypeRatioSort } from '../types/characterControlTypeRatio'
import { officialUsageRateLabel, ratioPercentLabel } from './controlTypeRatioFormatting'
import '../table.css'
import '../total-win-rates.css'

type Props = { rows: readonly CharacterControlTypeRatioRow[] }

export function CharacterControlTypeRatioTable({ rows }: Props) {
  const [sort, setSort] = useState<CharacterControlTypeRatioSort>({ key: 'official', direction: 'ascending' })
  const scrollRef = useRef<HTMLDivElement>(null)
  const sortedRows = useMemo(() => sortCharacterControlTypeRatioRows(rows, sort), [rows, sort])

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = 0
    scrollRef.current.scrollLeft = 0
  }, [rows, sort])

  const ratioHeading = (key: 'modern' | 'classic', label: string) => {
    const active = sort.key === key
    const nextDirection = active && sort.direction === 'descending' ? 'ascending' : 'descending'
    return <th scope="col" className="total-win-rate-sort-heading" aria-sort={active ? sort.direction : 'none'}>
      <button type="button" className="total-win-rate-sort-button"
        aria-label={`${label}を${nextDirection === 'ascending' ? '昇順' : '降順'}に並べる`}
        onClick={() => setSort({ key, direction: nextDirection })}>
        <span>{label}<span className="control-ratio-unit">推定比率（%）</span></span>
        <span className="total-win-rate-sort-indicator" aria-hidden="true">{active ? sort.direction === 'ascending' ? '▲' : '▼' : '↕'}</span>
      </button>
    </th>
  }

  return <div ref={scrollRef} className="data-table-scroll control-ratio-character-scroll" role="region"
    tabIndex={0} aria-label="キャラ内の操作タイプ比率・スクロール領域">
    <table className="data-table total-win-rate-table control-ratio-character-table">
      <caption className="win-rates-visually-hidden">選択月・リーグの各キャラクター内で推定したモダン・クラシックの使用比率</caption>
      <colgroup><col className="control-ratio-character-column" /><col /><col /><col /><col className="control-ratio-character-status-column" /></colgroup>
      <thead><tr>
        <th scope="col" className="total-win-rate-sort-heading" aria-sort={sort.key === 'official' ? 'other' : 'none'}>
          <button type="button" className="total-win-rate-sort-button" aria-label="キャラクターを公式順に並べる"
            onClick={() => setSort({ key: 'official', direction: 'ascending' })}>
            <span>キャラクター</span><span className="total-win-rate-sort-indicator" aria-hidden="true">{sort.key === 'official' ? '公式順' : '↕'}</span>
          </button>
        </th>
        {ratioHeading('modern', 'キャラ内モダン')}
        {ratioHeading('classic', 'キャラ内クラシック')}
        <th scope="col">公式ALL使用率<span className="control-ratio-unit">（%）</span></th>
        <th scope="col">推定状態・理由</th>
      </tr></thead>
      <tbody>{sortedRows.map(row => <tr key={row.characterId}>
        <th scope="row">{row.name}</th>
        <td>{ratioPercentLabel(row.modernWithinCharacterRatio)}</td>
        <td>{ratioPercentLabel(row.classicWithinCharacterRatio)}</td>
        <td>{officialUsageRateLabel(row.allText)}</td>
        <td className={`control-ratio-status${row.status !== 'estimated' ? ' is-unavailable' : ''}`}>
          {row.status === 'estimated' ? '推定値' : `推定不可：${row.reason ?? '条件を確認できません。'}`}
        </td>
      </tr>)}</tbody>
    </table>
  </div>
}
