import { CharacterLeaguePercentageChart } from './CharacterLeaguePercentageChart'
import { usageRateLeagueLabel } from './controlTypeRatioFormatting'
import { formatLeagueUsageRatePoint } from '../lib/leagueUsageRates'
import { usageRateChartAxis, type UsageRateChartRange } from '../lib/usageRateChartAxis'
import type { LeagueUsageRatePoint, LeagueUsageRates } from '../types/leagueUsageRates'
import type { LeaguePercentageChartComparison } from '../types/leaguePercentageChart'
import type { HistoryControlType } from '../types/winRateHistory'

type Props = {
  comparison: LeagueUsageRates
  characterId: string
  characterName: string
  operationMode: 'combined' | 'separate'
  showValues: boolean
  range: UsageRateChartRange
}

export function CharacterLeagueUsageRateChart({ comparison, characterId, characterName, operationMode, showValues, range }: Props) {
  const controls: HistoryControlType[] = operationMode === 'combined' ? ['combined'] : ['classic', 'modern']
  const rows = comparison.rows.filter(row => row.characterId === characterId)
  const metadata = new Map(comparison.metadata.map(item => [item.league, item]))
  const chart: LeaguePercentageChartComparison = {
    characterName: rows[0]?.name ?? characterName,
    leagues: comparison.leagues,
    series: controls.map(controlType => {
      const row = rows.find(item => item.controlType === (controlType === 'combined' ? null : controlType))
      return {
        controlType,
        points: comparison.leagues.map((league, index) => {
          const state = metadata.get(league)?.status
          const point: LeagueUsageRatePoint = row?.values[index] ?? {
            status: state === 'ready' ? 'unlisted' : state === 'error' ? 'error' : 'unavailable',
            entry: null,
            percentThousandths: null,
          }
          return {
            value: point.status === 'value' && point.percentThousandths !== null ? point.percentThousandths / 1000 : null,
            label: formatLeagueUsageRatePoint(point),
            percentThousandths: point.status === 'value' ? point.percentThousandths ?? undefined : undefined,
          }
        }),
      }
    }),
  }
  return <CharacterLeaguePercentageChart comparison={chart} axis={usageRateChartAxis(range)} showValues={showValues}
    metricLabel="使用率" sourceDescription={comparison.leagues.includes('ALL')
      ? '各リーグと全体の公式キャラクター使用率を百分率で表示します。' : '各リーグの公式キャラクター使用率を百分率で表示します。'}
    valuePrecision={3} leagueName={usageRateLeagueLabel} />
}
