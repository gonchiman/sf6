import { useMemo } from 'react'
import { formatLeagueUsageRatePoint, sortLeagueUsageRateRows } from '../lib/leagueUsageRates'
import type { LeagueUsageRates, LeagueUsageRateSort } from '../types/leagueUsageRates'
import { LeaguePercentageTable } from './LeaguePercentageTable'
import { usageRateLeagueLabel } from './controlTypeRatioFormatting'

type Props = {
  comparison: LeagueUsageRates
  separateControls: boolean
  sort: LeagueUsageRateSort
  onSortChange: (sort: LeagueUsageRateSort) => void
  selectedCharacterId: string
  onCharacterChange: (characterId: string) => void
}

export function LeagueUsageRateTable({ comparison, separateControls, sort, onSortChange, selectedCharacterId, onCharacterChange }: Props) {
  const rows = useMemo(() => sortLeagueUsageRateRows(comparison.rows, comparison.leagues, sort).map(row => ({
    ...row, values: row.values.map(point => ({ label: formatLeagueUsageRatePoint(point) })),
  })), [comparison, sort])
  return <LeaguePercentageTable leagues={comparison.leagues} rows={rows} separateControls={separateControls}
    sort={sort} onSortChange={onSortChange} selectedCharacterId={selectedCharacterId} onCharacterChange={onCharacterChange}
    metricLabel="使用率" caption="全リーグのキャラクター別公式使用率の比較表（%）"
    emptyMessage="表示できるキャラ別使用率がありません。" getLeagueLabel={usageRateLeagueLabel} />
}
