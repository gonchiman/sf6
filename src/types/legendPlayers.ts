import type { LegendAnalysisDataset, LegendAnalysisDescriptor, LegendAnalysisManifest } from './legendAnalysis.ts'

export type LegendPlayersDescriptor = LegendAnalysisDescriptor
export type LegendPlayersManifest = LegendAnalysisManifest

/** One observed account-character entry; optional fields are absent in legacy captures. */
export interface LegendPlayerRow {
  /** Capture-local ordinal only; never use it to match players across captures. */
  id: string
  playerName: string
  characterId: string
  rank: number
  masterRating: number
  /** Public Buckler player ID, preserved as a string (including any leading zero). */
  playerId?: string
  /** Country/region and platform labels as presented by the source. */
  region?: string
  platform?: string
  /** This character's ranked matches in rankedMatchScope; zero is a confirmed zero. */
  rankedMatchCount?: number
}

export interface LegendRankedMatchScope {
  actId: string
  mode: 'ranked'
  collectionStartedAt: string
  collectionEndedAt: string
}

/** Ranking rows are complete, but no current-Act profile counts have been published. */
export interface LegendRankedMatchAvailability {
  status: 'unavailable'
  reason: 'authentication-unavailable' | 'source-unconfirmed' | 'source-changed' | 'access-unavailable'
    | 'cancelled' | 'request-limit' | 'collection-failed'
  checkedAt: string
}

export interface LegendRankedMatchCount {
  id: string
  playerId: string
  characterId: string
  rankedMatchCount: number
}

/** The final match count result for one previously published ranking capture. */
export type LegendRankedMatchSupplement = {
  schemaVersion: 1
  datasetId: string
  generatedAt: string
} & (
  { rankedMatchScope: LegendRankedMatchScope; counts: LegendRankedMatchCount[]; rankedMatchAvailability?: never }
  | { rankedMatchAvailability: LegendRankedMatchAvailability; rankedMatchScope?: never; counts?: never }
)

/** Separately stored from the existing aggregate-only Legend dataset. */
export interface LegendPlayersDataset extends Pick<LegendAnalysisDataset,
  'id' | 'captureStartedAt' | 'captureEndedAt' | 'generatedAt' | 'source' |
  'act' | 'definitionVersion' | 'membershipRule' | 'conditions' | 'totalCount' | 'validation'> {
  /** Version 4 stores the ranking before the independent match count result. */
  schemaVersion: 1 | 2 | 3 | 4
  players: LegendPlayerRow[]
  /** Required in schemaVersion 2; never infer a profile collection time from ranking times. */
  rankedMatchScope?: LegendRankedMatchScope
  /** Required only in schemaVersion 3, whose complete ranking rows have no match counts. */
  rankedMatchAvailability?: LegendRankedMatchAvailability
}

export type LegendPlayerSortKey = 'rank' | 'playerName' | 'characterId' | 'masterRating' | 'playerId' | 'region' | 'platform' | 'rankedMatchCount'
export type LegendPlayerSortDirection = 'asc' | 'desc'
