import type { LeagueUsageRatePoint } from './leagueUsageRates.ts'
import type { UsageRateDataset, UsageRateEdition, UsageRateSelection, UsageRateTotalMismatch } from './usageRates.ts'

export interface UsageRateHistorySelection extends UsageRateSelection {
  edition: UsageRateEdition
}

export type UsageRateHistoryOperationMode = 'combined' | 'separate'
export type UsageRateHistoryControlType = 'combined' | 'classic' | 'modern'

export interface UsageRateHistoryPoint extends LeagueUsageRatePoint {
  month: string
  /** A percentage, derived exactly from percentThousandths / 1000; missing observations are null. */
  value: number | null
  capturedAt: string | null
  generatedAt: string | null
  source: UsageRateDataset['source'] | null
  totalMismatch?: UsageRateTotalMismatch
}

export interface UsageRateHistorySeries {
  controlType: UsageRateHistoryControlType
  points: UsageRateHistoryPoint[]
}

export interface CharacterUsageRateHistory {
  selection: UsageRateHistorySelection
  characterId: string
  characterName: string
  operationMode: UsageRateHistoryOperationMode
  series: UsageRateHistorySeries[]
}
