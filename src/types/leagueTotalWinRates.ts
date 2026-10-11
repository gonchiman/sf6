import type { HistoryDatasetResult, WinRateHistoryPoint } from './winRateHistory.ts'
import type { WinRateControlType, WinRateEdition, WinRateOperationMode } from './winRates.ts'

export interface LeagueTotalWinRateSelection {
  edition: WinRateEdition
  month: string
  operationMode: WinRateOperationMode
}

export interface LeagueTotalWinRateRow {
  key: string
  characterId: string
  name: string
  controlType: WinRateControlType
  /** Each point corresponds to the same index in LeagueTotalWinRates.leagues. */
  values: WinRateHistoryPoint[]
}

export interface LeagueTotalWinRateMetadata {
  league: string
  status: 'ready' | 'error' | 'unavailable'
  /** Only a result that passed the selected conditions and dataset validation is exposed. */
  result?: Extract<HistoryDatasetResult, { status: 'ready' }>
}

export interface LeagueTotalWinRates {
  leagues: string[]
  rows: LeagueTotalWinRateRow[]
  metadata: LeagueTotalWinRateMetadata[]
}

export interface LeagueTotalWinRateSort {
  /** null restores the input's official character order. */
  league: string | null
  direction: 'ascending' | 'descending'
}
