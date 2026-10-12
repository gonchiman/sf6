import type { HistoryControlType, WinRateHistoryPoint } from './winRateHistory.ts'
import type { WinRateOperationMode } from './winRates.ts'

export interface CharacterWinRateComparisonSeries {
  controlType: HistoryControlType
  point: WinRateHistoryPoint
}

export interface CharacterWinRateComparisonRow {
  characterId: string
  name: string
  /** Zero-based official character order, retained when the displayed rows are sorted. */
  order: number
  series: CharacterWinRateComparisonSeries[]
}

export interface CharacterWinRateComparison {
  league: string
  operationMode: WinRateOperationMode
  rows: CharacterWinRateComparisonRow[]
}
