import type { HistoryControlType, WinRateHistoryPoint } from './winRateHistory.ts'

export interface CharacterLeagueWinRateSeries {
  controlType: HistoryControlType
  /** Points follow CharacterLeagueWinRates.leagues, retaining published values and states. */
  points: WinRateHistoryPoint[]
}

export interface CharacterLeagueWinRates {
  characterId: string
  characterName: string
  leagues: string[]
  series: CharacterLeagueWinRateSeries[]
}
