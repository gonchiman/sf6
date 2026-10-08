import type { WinRateCell, WinRateDataset, WinRateDatasetDescriptor } from './winRates.ts'

export type HistoryControlType = 'combined' | 'classic' | 'modern'

export interface WinRateHistorySelection {
  league: string
  controlType: HistoryControlType
  fromMonth: string
  toMonth: string
}

export interface WinRateHistoryPoint {
  month: string
  status: 'value' | 'missing' | 'unlisted' | 'unavailable' | 'error'
  total: WinRateCell | null
  /** Hundredths of one percent; 5058 represents 50.58%. */
  percentHundredths: number | null
  capturedAt: string | null
  source: WinRateDataset['source'] | null
}

export type HistoryDatasetResult =
  | { month: string; descriptor: WinRateDatasetDescriptor; status: 'ready'; dataset: WinRateDataset }
  | { month: string; descriptor: WinRateDatasetDescriptor; status: 'error' }
