import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { sortLeagueTotalWinRateRows } from '../lib/leagueTotalWinRates'
import { leagueLabel } from '../lib/winRateConditions'
import { formatHistoryValue } from '../lib/winRateHistory'
import type { LeagueTotalWinRates, LeagueTotalWinRateSort } from '../types/leagueTotalWinRates'
import '../table.css'
import '../total-win-rates.css'
import '../league-total-win-rates.css'

type Props = {
  comparison: LeagueTotalWinRates
  separateControls: boolean
  sort: LeagueTotalWinRateSort
  onSortChange: (sort: LeagueTotalWinRateSort) => void
  selectedCharacterId: string
  onCharacterChange: (characterId: string) => void
}

export function LeagueTotalWinRateTable({ comparison, separateControls, sort, onSortChange, selectedCharacterId, onCharacterChange }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => sortLeagueTotalWinRateRows(comparison.rows, comparison.leagues, sort), [comparison, sort])
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [comparison, sort])

  return <div ref={scrollRef} className={`data-table-scroll league-total-win-rate-scroll${separateControls ? ' is-separate' : ''}`} role="region"
    tabIndex={0} aria-label="全リーグのキャラクター別勝率・スクロール領域">
    <table className={`data-table league-total-win-rate-table${separateControls ? ' is-separate' : ''}`}
      style={{ '--league-total-league-count': comparison.leagues.length } as CSSProperties}>
      <caption className="win-rates-visually-hidden">全リーグのキャラクター別公式Totalを百分率に換算した比較表</caption>
      <colgroup><col className="league-total-name-column" />
        {separateControls && <col className="league-total-control-column" />}
        {comparison.leagues.map(league => <col className="league-total-value-column" key={league} />)}
      </colgroup>
      <thead><tr>
        <th scope="col" className="league-total-fixed-name league-total-sort-heading" aria-sort={sort.league === null ? 'other' : 'none'}>
          <button type="button" className="total-win-rate-sort-button" aria-label="キャラクターを公式順に並べる"
            onClick={() => onSortChange({ league: null, direction: 'descending' })}>
            <span>キャラクター</span><span className="total-win-rate-sort-indicator" aria-hidden="true">{sort.league === null ? '公式順' : '↕'}</span>
          </button>
        </th>
        {separateControls && <th scope="col" className="league-total-fixed-control">操作タイプ</th>}
        {comparison.leagues.map(league => {
          const active = sort.league === league
          const nextDirection = active && sort.direction === 'descending' ? 'ascending' : 'descending'
          return <th scope="col" key={league} className="league-total-sort-heading" aria-sort={active ? sort.direction : 'none'}>
            <button type="button" className="total-win-rate-sort-button"
              aria-label={`${leagueLabel(league)}の勝率を${nextDirection === 'ascending' ? '昇順' : '降順'}に並べる`}
              onClick={() => onSortChange({ league, direction: nextDirection })}>
              <span>{leagueLabel(league)}</span><span className="total-win-rate-sort-indicator" aria-hidden="true">{active ? sort.direction === 'ascending' ? '▲' : '▼' : '↕'}</span>
            </button>
          </th>
        })}
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.key} className={row.characterId === selectedCharacterId ? 'is-selected-character' : undefined}>
        <th scope="row" className="league-total-fixed-name league-total-character-heading">
          <button type="button" className="league-total-character-button" aria-pressed={row.characterId === selectedCharacterId}
            aria-label={`${row.name}${separateControls ? row.controlType === 'classic' ? '（クラシック）' : '（モダン）' : ''}のランク別勝率を表示`}
            onClick={() => onCharacterChange(row.characterId)}>{row.name}</button>
        </th>
        {separateControls && <td className="league-total-fixed-control">{row.controlType === 'classic' ? 'クラシック' : 'モダン'}</td>}
        {row.values.map((point, index) => <td key={comparison.leagues[index]} className="league-total-value">
          {formatHistoryValue(point)}
          {point.total?.lowSample && <span className="win-rate-sample-mark" aria-label="公式の少数試合表示">i</span>}
        </td>)}
      </tr>)}
        {rows.length === 0 && <tr><td colSpan={comparison.leagues.length + (separateControls ? 2 : 1)} className="league-total-empty">表示できるキャラ別勝率がありません。</td></tr>}
      </tbody>
    </table>
  </div>
}
