import type { UsageRateDataset } from './usageRates.ts'

/** A theoretical uniform share, using the month-specific general ALL combined published roster. */
export interface UsageRateBaselinePoint {
  month: string
  status: 'value' | 'unavailable' | 'error'
  characterCount: number | null
  /** 100 / characterCount without display rounding; this is not a published mean or win-rate reference. */
  value: number | null
  capturedAt: string | null
  generatedAt: string | null
  source: UsageRateDataset['source'] | null
}
