import type { UsageRateDataset, UsageRateDatasetDescriptor } from './usageRates.ts'

export interface ControlTypeRatioDetail {
  characterId: string
  name: string
  allText: string
  classicText: string
  modernText: string
  /** Percent values in the 0–100 scale. No display rounding is applied. */
  allPercent: number
  classicPercent: number
  modernPercent: number
  reconstructedAllPercent: number
  /** Reconstructed ALL minus published ALL, in percentage points. */
  differencePoints: number
}

export interface ControlTypeRatioEstimate {
  status: 'estimated' | 'unavailable'
  /** Ratios in the 0–1 scale; estimates are never clipped to the valid interval. */
  modernRatio: number | null
  classicRatio: number | null
  characterCount: number
  maxAbsoluteErrorPoints: number | null
  rmsErrorPoints: number | null
  reason: string | null
  details: ControlTypeRatioDetail[]
}

export interface ControlTypeRatioRow {
  month: string
  status: 'estimated' | 'unavailable' | 'missing' | 'error'
  descriptor: UsageRateDatasetDescriptor | null
  dataset: UsageRateDataset | null
  estimate: ControlTypeRatioEstimate | null
}
