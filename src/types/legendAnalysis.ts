import type { WinRateFighter } from './winRates.ts'

export type LegendCharacterId = WinRateFighter['characterId']
export type LegendMembershipRule = 'official-legend-badge' | 'official-ranking-cutoff'

export interface LegendAnalysisConditions {
  region: string
  platform: string
  characters: 'all'
  /** Preserve the observed source scope without interpreting an unlabelled URL value. */
  users: string
}

export interface LegendAnalysisSource {
  url: string
  title: string
}

export interface LegendAnalysisDescriptor {
  id: string
  path: string
  actId: string
  definitionVersion: string
  membershipRule: LegendMembershipRule
  conditions: LegendAnalysisConditions
  captureStartedAt: string
  captureEndedAt: string
  totalCount: number
}

export interface LegendAnalysisAvailability {
  status: 'not-collected' | 'verification-pending' | 'collection-failed'
  checkedAt: string
  message: string
}

export interface LegendAnalysisManifest {
  schemaVersion: 1
  generatedAt: string
  source: LegendAnalysisSource
  datasets: LegendAnalysisDescriptor[]
  availability?: LegendAnalysisAvailability
}

export interface LegendMrBin {
  /** Inclusive lower bound. Bins are aligned to multiples of 50 MR. */
  lower: number
  /** Exclusive upper bound. */
  upper: number
  count: number
}

/** Quantiles use linear interpolation at (n - 1) * p on the raw sorted MR values. */
export interface LegendMrDistribution {
  count: number
  min: number | null
  p25: number | null
  median: number | null
  p75: number | null
  max: number | null
  mean: number | null
  bins: LegendMrBin[]
}

export interface LegendCharacterAggregate {
  characterId: LegendCharacterId
  /** Official character label from the confirmed source roster, never a player name. */
  name: string
  count: number
  mr: LegendMrDistribution
}

/** Public captures contain aggregates only, never player rows or persistent identity hashes. */
export interface LegendAnalysisDataset {
  schemaVersion: 1
  id: string
  captureStartedAt: string
  captureEndedAt: string
  generatedAt: string
  source: LegendAnalysisSource & {
    population: string
    metric: string
    unit: 'account-character'
    notes: string[]
  }
  act: { id: string; label: string }
  definitionVersion: string
  membershipRule: LegendMembershipRule
  conditions: LegendAnalysisConditions
  totalCount: number
  /** Confirmed source roster: every member has an explicit aggregate, including real zeros. */
  characterIds: LegendCharacterId[]
  characters: LegendCharacterAggregate[]
  mr: LegendMrDistribution
  validation: {
    status: 'verified'
    coverage: 'all-listed-legend-entries'
    checks: string[]
    notes: string[]
  }
}

export interface LegendCharacterRow extends LegendCharacterAggregate {
  /** Percent of the current capture's listed entries, 0–100; null for a zero denominator. */
  percent: number | null
  previousCount: number | null
  previousPercent: number | null
  countDelta: number | null
  percentagePointDelta: number | null
}
