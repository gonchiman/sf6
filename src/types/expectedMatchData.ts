import type { ExpectedMatchesResult } from './expectedMatches.ts'
import type { HistoryControlType, WinRateHistoryPoint } from './winRateHistory.ts'
import type { WinRateDataset, WinRateFighter } from './winRates.ts'

export interface ExpectedMatchSelection {
  month: string
  controlType: HistoryControlType
}

export interface ExpectedMatchSettings {
  startLp: number
  targetLp: number
  winLp: number
  lossLp: number
}

export interface ExpectedMatchRankInput {
  league: string
  minimumLp: number
  status: WinRateHistoryPoint['status']
  text: string | null
  probability: number | null
  lowSample: boolean
}

export interface ExpectedMatchCharacter {
  fighter: WinRateFighter
  ranks: ExpectedMatchRankInput[]
  available: boolean
}

export interface ExpectedMatchData {
  characters: ExpectedMatchCharacter[]
  datasets: WinRateDataset[]
  failedCount: number
}

export interface ExpectedMatchRow {
  character: ExpectedMatchCharacter
  result: ExpectedMatchesResult | { status: 'missing-data' }
}

export type ExpectedMatchWorkerResponse =
  | { status: 'progress'; completed: number; total: number }
  | { status: 'ready'; rows: ExpectedMatchRow[] }
  | { status: 'error' }
