import type {
  RankDistributionAvailability, RankDistributionDescriptor, RankDistributionRow, RankDistributionSource,
} from './rankDistribution.ts'

export type MrDistributionSource = RankDistributionSource
export type MrDistributionDescriptor = RankDistributionDescriptor
export type MrDistributionAvailability = RankDistributionAvailability

export interface MrDistributionConditions {
  ranking: 'master-rating'
  character: 'max-mr'
  act: 'current'
  region: 'all'
  platform: 'all'
}

export interface MrDistributionManifest {
  schemaVersion: 1
  generatedAt: string
  source: MrDistributionSource
  datasets: MrDistributionDescriptor[]
  availability?: MrDistributionAvailability
}

export interface MrDistributionEntry {
  minimum: number
  /** Exclusive upper bound; null only for the final 2500+ bin. */
  maximum: number | null
  count: number
}

export interface MrDistributionBoundaryObservation {
  minimumMr: number
  countAtOrAbove: number
  totalCount: number
  observedAt: string
}

export interface MrDistributionObservation {
  totalAtStart: number
  totalAtEnd: number
  minTotal: number
  maxTotal: number
  boundaries: MrDistributionBoundaryObservation[]
}

/** Interval estimates of the current Act's maximum-MR listing, separate from LP population. */
export interface MrDistributionDataset {
  schemaVersion: 1
  id: string
  captureStartedAt: string
  captureEndedAt: string
  generatedAt: string
  source: MrDistributionSource & {
    population: string
    metric: string
    unit: 'fighter-account'
    notes: string[]
  }
  conditions: MrDistributionConditions
  method: 'boundary-search-estimate'
  binWidth: 100
  totalCount: number
  entries: MrDistributionEntry[]
  observation: MrDistributionObservation
  validation: {
    status: 'estimated'
    coverage: 'all-mr-boundaries'
    checks: string[]
    notes: string[]
  }
}

/** Compatible with the existing distribution chart; denominator is the MR listing. */
export interface MrDistributionRow extends RankDistributionRow {
  group: 'MR'
  rankId: null
}
