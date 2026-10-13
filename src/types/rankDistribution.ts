export interface RankDistributionSource {
  url: string
  title: string
}

export interface RankDistributionConditions {
  league: 'all'
  character: 'max-lp'
  region: 'all'
  platform: 'all'
  users: 'all'
}

export interface RankDistributionDescriptor {
  id: string
  path: string
  captureStartedAt: string
  captureEndedAt: string
  totalCount: number
}

export interface RankDistributionAvailability {
  status: 'not-collected' | 'verification-pending' | 'collection-failed'
  message: string
  checkedAt: string
}

export interface RankDistributionManifest {
  schemaVersion: 1
  generatedAt: string
  source: RankDistributionSource
  datasets: RankDistributionDescriptor[]
  /** Collection status is separate from previously published, verified snapshots. */
  availability?: RankDistributionAvailability
}

export interface RankDistributionEntry {
  /** Buckler league IDs: 1–35 for the seven five-star groups; 36 for MASTER. */
  rankId: number
  count: number
}

export interface RankDistributionValidation {
  status: 'verified'
  coverage: 'all-listed-accounts'
  checks: string[]
  notes: string[]
}

/** Verified observations over a capture interval, rather than an atomic population snapshot. */
export interface RankDistributionDataset {
  schemaVersion: 1
  id: string
  captureStartedAt: string
  captureEndedAt: string
  generatedAt: string
  source: RankDistributionSource & {
    population: string
    metric: string
    unit: 'fighter-account'
    notes: string[]
  }
  conditions: RankDistributionConditions
  method: 'boundary-search'
  totalCount: number
  entries: RankDistributionEntry[]
  validation: RankDistributionValidation
}

export interface RankDistributionRow {
  id: string
  label: string
  group: string
  /** Null for the rows that combine five star levels. */
  rankId: number | null
  count: number
  /** Percent of all listed accounts (0–100), null when the denominator is zero. */
  percent: number | null
  cumulativeCount: number
  /** Accounts in this rank or higher, using the same global denominator. */
  cumulativePercent: number | null
}
