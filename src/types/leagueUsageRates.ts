import type { UsageRateDataset, UsageRateEdition, UsageRateEntry } from './usageRates.ts'

export interface LeagueUsageRateSelection {
  /** Omitted selections retain the original general edition. */
  edition?: UsageRateEdition
  month: string
  operationMode: 'combined' | 'separate'
}

export interface LeagueUsageRatePoint {
  status: 'value' | 'missing' | 'unlisted' | 'unavailable' | 'error'
  entry: UsageRateEntry | null
  /** Thousandths of one percent, preserving the official usage-rate precision. */
  percentThousandths: number | null
}

export interface LeagueUsageRateRow {
  key: string
  characterId: string
  name: string
  controlType: null | 'classic' | 'modern'
  /** Each point corresponds to the same index in LeagueUsageRates.leagues. */
  values: LeagueUsageRatePoint[]
}

export interface LeagueUsageRateMetadata {
  league: string
  status: 'ready' | 'unavailable' | 'error'
  /** Exposed only after the dataset passes selected-condition and source validation. */
  dataset?: UsageRateDataset
}

export interface LeagueUsageRates {
  leagues: string[]
  rows: LeagueUsageRateRow[]
  metadata: LeagueUsageRateMetadata[]
}

export interface LeagueUsageRateSort {
  /** null restores the input's official character order. */
  league: string | null
  direction: 'ascending' | 'descending'
}
