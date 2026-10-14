import { CharacterLeaguePercentageChart } from './CharacterLeaguePercentageChart'
import { characterLeagueChartAxis, characterLeagueChartValue, type CharacterLeagueChartRange } from '../lib/characterLeagueChartAxis'
import { formatHistoryValue } from '../lib/winRateHistory'
import type { CharacterLeagueWinRates } from '../types/characterLeagueWinRates'
import type { LeaguePercentageChartComparison } from '../types/leaguePercentageChart'

type Props = { comparison: CharacterLeagueWinRates; showValues: boolean; range: CharacterLeagueChartRange }

export function CharacterLeagueWinRateChart({ comparison, showValues, range }: Props) {
  const axis = characterLeagueChartAxis(range)
  const chart: LeaguePercentageChartComparison = {
    characterName: comparison.characterName,
    leagues: comparison.leagues,
    series: comparison.series.map(series => ({
      controlType: series.controlType,
      points: comparison.leagues.map((_, index) => {
        const point = series.points[index]
        return {
          value: characterLeagueChartValue(point, axis).value,
          label: point ? formatHistoryValue(point) : '未登録',
          lowSample: point?.total?.lowSample,
          percentHundredths: point?.percentHundredths ?? undefined,
        }
      }),
    })),
  }
  return <CharacterLeaguePercentageChart comparison={chart} showValues={showValues} axis={axis}
    metricLabel="勝率" sourceDescription="各ランクの公式Totalを百分率で表示します。iは公式の少数試合表示です。"
    valuePrecision={2} referenceValue={50} />
}
