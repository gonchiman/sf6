import { useEffect, useRef, type CSSProperties } from 'react'
import '../table.css'
import '../total-win-rates.css'
import '../league-total-win-rates.css'

export interface LeaguePercentageTableRow {
  key: string
  characterId: string
  name: string
  controlType: 'classic' | 'modern' | null
  values: { label: string; lowSample?: boolean }[]
}

interface LeaguePercentageSort {
  league: string | null
  direction: 'ascending' | 'descending'
}

type Props = {
  leagues: readonly string[]
  rows: readonly LeaguePercentageTableRow[]
  separateControls: boolean
  sort: LeaguePercentageSort
  onSortChange: (sort: LeaguePercentageSort) => void
  selectedCharacterId: string
  onCharacterChange: (characterId: string) => void
  metricLabel: string
  caption: string
  emptyMessage: string
  getLeagueLabel: (league: string) => string
}

/** Shared fixed-column table for published percentages; values are formatted by the metric's wrapper. */
export function LeaguePercentageTable({ leagues, rows, separateControls, sort, onSortChange, selectedCharacterId,
  onCharacterChange, metricLabel, caption, emptyMessage, getLeagueLabel }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [rows, sort])

  return <div ref={scrollRef} className={`data-table-scroll league-total-win-rate-scroll${separateControls ? ' is-separate' : ''}`} role="region"
    tabIndex={0} aria-label={`全リーグのキャラクター別${metricLabel}・スクロール領域`}>
    <table className={`data-table league-total-win-rate-table${separateControls ? ' is-separate' : ''}`}
      style={{ '--league-total-league-count': leagues.length } as CSSProperties}>
      <caption className="win-rates-visually-hidden">{caption}</caption>
      <colgroup><col className="league-total-name-column" />
        {separateControls && <col className="league-total-control-column" />}
        {leagues.map(league => <col className="league-total-value-column" key={league} />)}
      </colgroup>
      <thead><tr>
        <th scope="col" className="league-total-fixed-name league-total-sort-heading" aria-sort={sort.league === null ? 'other' : 'none'}>
          <button type="button" className="total-win-rate-sort-button" aria-label="キャラクターを公式順に並べる"
            onClick={() => onSortChange({ league: null, direction: 'descending' })}>
            <span>キャラクター</span><span className="total-win-rate-sort-indicator" aria-hidden="true">{sort.league === null ? '公式順' : '↕'}</span>
          </button>
        </th>
        {separateControls && <th scope="col" className="league-total-fixed-control">操作タイプ</th>}
        {leagues.map(league => {
          const active = sort.league === league
          const nextDirection = active && sort.direction === 'descending' ? 'ascending' : 'descending'
          return <th scope="col" key={league} className="league-total-sort-heading" aria-sort={active ? sort.direction : 'none'}>
            <button type="button" className="total-win-rate-sort-button"
              aria-label={`${getLeagueLabel(league)}の${metricLabel}を${nextDirection === 'ascending' ? '昇順' : '降順'}に並べる`}
              onClick={() => onSortChange({ league, direction: nextDirection })}>
              <span>{getLeagueLabel(league)}</span><span className="total-win-rate-sort-indicator" aria-hidden="true">{active ? sort.direction === 'ascending' ? '▲' : '▼' : '↕'}</span>
            </button>
          </th>
        })}
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.key} className={row.characterId === selectedCharacterId ? 'is-selected-character' : undefined}>
        <th scope="row" className="league-total-fixed-name league-total-character-heading">
          <button type="button" className="league-total-character-button" aria-pressed={row.characterId === selectedCharacterId}
            aria-label={`${row.name}${separateControls ? row.controlType === 'classic' ? '（クラシック）' : '（モダン）' : ''}のランク別${metricLabel}を表示`}
            onClick={() => onCharacterChange(row.characterId)}>{row.name}</button>
        </th>
        {separateControls && <td className="league-total-fixed-control">{row.controlType === 'classic' ? 'クラシック' : 'モダン'}</td>}
        {row.values.map((point, index) => <td key={leagues[index]} className="league-total-value">
          {point.label}
          {point.lowSample && <span className="win-rate-sample-mark" aria-label="公式の少数試合表示">i</span>}
        </td>)}
      </tr>)}
        {rows.length === 0 && <tr><td colSpan={leagues.length + (separateControls ? 2 : 1)} className="league-total-empty">{emptyMessage}</td></tr>}
      </tbody>
    </table>
  </div>
}
