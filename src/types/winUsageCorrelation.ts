import type { HistoryControlType, HistoryDatasetResult } from './winRateHistory.ts'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateEdition } from './winRates.ts'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateHistoryResult, UsageRateTotalMismatch } from './usageRates.ts'

export interface CorrelationCondition {
  edition: WinRateEdition
  league: string
  controlType: HistoryControlType
  /** Months with both registered datasets, in ascending order. */
  months: string[]
}

export interface CorrelationSelection {
  edition: WinRateEdition
  league: string
  controlType: HistoryControlType
  fromMonth: string
  toMonth: string
}

export type CorrelationMode = 'monthly' | 'common'

export interface CorrelationPoint {
  characterId: string
  name: string
  /** Percent, not a 0–1 proportion. */
  winRate: number
  usageRate: number
}

export type CorrelationExclusionReason = 'win-unlisted' | 'usage-unlisted' | 'win-missing' | 'usage-missing' | 'low-sample' | 'non-common'

export interface CorrelationExclusion {
  characterId: string
  name: string
  reasons: CorrelationExclusionReason[]
}

export type CorrelationUnavailableReason = 'insufficient-characters' | 'constant-win-rate' | 'constant-usage-rate'

export interface CorrelationRow {
  month: string
  status: 'ready' | 'unavailable' | 'error' | 'incomplete'
  /** Distinguish registration gaps from a failed fetch/invalid response. */
  winStatus: 'ready' | 'unavailable' | 'error'
  usageStatus: 'ready' | 'unavailable' | 'error'
  points: CorrelationPoint[]
  pearson: number | null
  spearman: number | null
  unavailableReason: CorrelationUnavailableReason | null
  /** Union of the published IDs in the two datasets before exclusions. */
  listedCount: number | null
  exclusions: CorrelationExclusion[]
  winSource: WinRateDataset['source'] | null
  usageSource: UsageRateDataset['source'] | null
  winCapturedAt: string | null
  usageCapturedAt: string | null
  winGeneratedAt: string | null
  usageGeneratedAt: string | null
  /** Source-verified exceptional total for the selected operation distribution. */
  usageTotalMismatch: UsageRateTotalMismatch | null
  /** Sum of published non-missing usage values before matching, exclusions or common-character filtering. */
  usagePublishedTotal: number | null
}

export interface CorrelationHistoryResults {
  winResults: HistoryDatasetResult[]
  usageResults: UsageRateHistoryResult[]
}

export interface CorrelationHistory {
  mode: CorrelationMode
  rows: CorrelationRow[]
  commonCharacterCount: number | null
  commonUnavailable: boolean
}

export interface CorrelationLoaders {
  win?: (descriptor: WinRateDatasetDescriptor) => Promise<WinRateDataset>
  usage?: (descriptor: UsageRateDatasetDescriptor) => Promise<UsageRateDataset>
}
