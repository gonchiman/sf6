import { useMemo } from 'react'
import { sortLeagueTotalWinRateRows } from '../lib/leagueTotalWinRates'
import { leagueLabel } from '../lib/winRateConditions'
import { formatHistoryValue } from '../lib/winRateHistory'
import type { LeagueTotalWinRates, LeagueTotalWinRateSort } from '../types/leagueTotalWinRates'
import { LeaguePercentageTable } from './LeaguePercentageTable'

type Props = {
  comparison: LeagueTotalWinRates
  separateControls: boolean
  sort: LeagueTotalWinRateSort
  onSortChange: (sort: LeagueTotalWinRateSort) => void
  selectedCharacterId: string
  onCharacterChange: (characterId: string) => void
}

export function LeagueTotalWinRateTable({ comparison, separateControls, sort, onSortChange, selectedCharacterId, onCharacterChange }: Props) {
  const rows = useMemo(() => sortLeagueTotalWinRateRows(comparison.rows, comparison.leagues, sort).map(row => ({
    ...row, values: row.values.map(point => ({ label: formatHistoryValue(point), lowSample: point.total?.lowSample })),
  })), [comparison, sort])
  return <LeaguePercentageTable leagues={comparison.leagues} rows={rows} separateControls={separateControls}
    sort={sort} onSortChange={onSortChange} selectedCharacterId={selectedCharacterId} onCharacterChange={onCharacterChange}
    metricLabel="勝率" caption="全リーグのキャラクター別公式Totalを百分率に換算した比較表"
    emptyMessage="表示できるキャラ別勝率がありません。" getLeagueLabel={leagueLabel} />
}
