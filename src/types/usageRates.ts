export type UsageRateControlType = 'all' | 'classic' | 'modern'
export type UsageRateEdition = 'general' | 'master'

export interface UsageRateSource {
  url: string
  title: string
}

export interface UsageRateDatasetDescriptor {
  id: string
  /** Omitted in existing publications; an omitted edition means general. */
  edition?: UsageRateEdition
  month: string
  league: string
  path: string
  capturedAt: string
}

export interface UsageRateManifest {
  schemaVersion: 1
  generatedAt: string
  source: UsageRateSource
  datasets: UsageRateDatasetDescriptor[]
}

export interface UsageRateEntry {
  characterId: string
  name: string
  /** Original published text, preserving precision and missing-value markers. */
  text: string
  /** Thousandths of one percent; 9566 represents 9.566%. Missing is null, never zero. */
  percentThousandths: number | null
}

/** An explicitly rechecked official sum outside the three-decimal rounding tolerance. */
export interface UsageRateTotalMismatch {
  observedPercentThousandths: number
  verifiedAt: string
  sourceUrl: string
  reason: string
}

export interface UsageRateDistribution {
  controlType: UsageRateControlType
  month: string
  league: string
  entries: UsageRateEntry[]
  totalMismatch?: UsageRateTotalMismatch
}

/** Published distributions for one edition, month and league; unlisted characters are not zero-filled. */
export interface UsageRateDataset {
  schemaVersion: 1
  id: string
  edition?: UsageRateEdition
  month: string
  league: string
  capturedAt: string
  generatedAt: string
  source: UsageRateSource & {
    population: string
    metric: string
    unit: string
    notes: string[]
  }
  distributions: UsageRateDistribution[]
}

export interface UsageRateSelection {
  edition?: UsageRateEdition
  league: string
  fromMonth: string
  toMonth: string
}

export type UsageRateHistoryResult =
  | { month: string; status: 'missing' }
  | { month: string; descriptor: UsageRateDatasetDescriptor; status: 'error' }
  | { month: string; descriptor: UsageRateDatasetDescriptor; status: 'ready'; dataset: UsageRateDataset }
