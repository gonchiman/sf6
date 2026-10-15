import type { UsageRateHistoryControlType, UsageRateHistoryPoint } from './usageRateHistory.ts'
import type { UsageRateHistoryResult } from './usageRates.ts'

export interface UsageRateComparisonRow {
  readonly id: string
  readonly characterId: string
  readonly characterName: string
  readonly league: string
  readonly controlType: UsageRateHistoryControlType
  readonly colorSlot: number
}

export interface UsageRateComparisonSeries extends UsageRateComparisonRow {
  readonly seriesId: string
  readonly label: string
  readonly points: UsageRateHistoryPoint[]
}

export interface UsageRateComparisonResult {
  readonly league: string
  readonly results: UsageRateHistoryResult[]
}
