import type { CharacterDescriptor, CharacterSource } from './characters.ts'

export type CharacterReleaseKind = 'initial' | 'additional'
export type CharacterReleaseStatus = 'released' | 'scheduled' | 'unverified'
export type CharacterReleaseOrder = 'asc' | 'desc'

export interface CharacterRelease {
  characterId: string
  kind: CharacterReleaseKind
  /** Status is verified from the cited announcement, never inferred from today's date. */
  status: CharacterReleaseStatus
  /** First playable release on PS5/PS4/Xbox Series X|S/PC, as a Japan calendar date. */
  releaseDate: string | null
  source: CharacterSource | null
}

export interface CharacterReleaseCatalog {
  schemaVersion: 1
  generatedAt: string
  checkedAt: string
  timezone: 'Asia/Tokyo'
  characters: CharacterRelease[]
}

export interface CharacterReleaseFilters {
  characterId: string
  kind: 'all' | CharacterReleaseKind
}

export interface CharacterReleaseRow extends CharacterRelease {
  character: CharacterDescriptor
}

export type CharacterReleaseLoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; catalog: CharacterReleaseCatalog }
