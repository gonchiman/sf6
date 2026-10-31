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

/** Separately stored from the existing aggregate-only Legend dataset. */
export interface LegendPlayersDataset extends Pick<LegendAnalysisDataset,
  'id' | 'captureStartedAt' | 'captureEndedAt' | 'generatedAt' | 'source' |
  'act' | 'definitionVersion' | 'membershipRule' | 'conditions' | 'totalCount' | 'validation'> {
  schemaVersion: 1 | 2
  players: LegendPlayerRow[]
  /** Required in schemaVersion 2; never infer a profile collection time from ranking times. */
  rankedMatchScope?: LegendRankedMatchScope
}

export type LegendPlayerSortKey = 'rank' | 'playerName' | 'characterId' | 'masterRating' | 'playerId' | 'region' | 'platform' | 'rankedMatchCount'
export type LegendPlayerSortDirection = 'asc' | 'desc'
