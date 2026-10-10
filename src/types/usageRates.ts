export type UsageRateControlType = 'all' | 'classic' | 'modern'

export interface UsageRateSource {
  url: string
  title: string
}

export interface UsageRateDatasetDescriptor {
  id: string
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

export interface UsageRateDistribution {
  controlType: UsageRateControlType
  month: string
  league: string
  entries: UsageRateEntry[]
}

/** One complete set of ALL, CLASSIC and MODERN for the same month and league. */
export interface UsageRateDataset {
  schemaVersion: 1
  id: string
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
  league: string
  fromMonth: string
  toMonth: string
}

export type UsageRateHistoryResult =
  | { month: string; status: 'missing' }
  | { month: string; descriptor: UsageRateDatasetDescriptor; status: 'error' }
  | { month: string; descriptor: UsageRateDatasetDescriptor; status: 'ready'; dataset: UsageRateDataset }
