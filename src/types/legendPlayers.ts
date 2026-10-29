import type { LegendAnalysisDataset, LegendAnalysisDescriptor, LegendAnalysisManifest } from './legendAnalysis.ts'

export type LegendPlayersDescriptor = LegendAnalysisDescriptor
export type LegendPlayersManifest = LegendAnalysisManifest

/** One observed account-character entry, with no reusable account identifier. */
export interface LegendPlayerRow {
  /** Capture-local ordinal only; never use it to match players across captures. */
  id: string
  playerName: string
  characterId: string
  rank: number
  masterRating: number
}

/** Separately stored from the existing aggregate-only Legend dataset. */
export interface LegendPlayersDataset extends Pick<LegendAnalysisDataset,
  'schemaVersion' | 'id' | 'captureStartedAt' | 'captureEndedAt' | 'generatedAt' | 'source' |
  'act' | 'definitionVersion' | 'membershipRule' | 'conditions' | 'totalCount' | 'validation'> {
  players: LegendPlayerRow[]
}

export type LegendPlayerSortKey = 'rank' | 'playerName' | 'characterId' | 'masterRating'
export type LegendPlayerSortDirection = 'asc' | 'desc'
