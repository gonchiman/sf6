import type { CharacterControlType, CharacterDescriptor, CharacterSource } from './characters.ts'

export type CharacterTraitId = 'full' | 'air' | 'projectile' | 'armor' | 'projectileInv' | 'clash'
export type CharacterTraitStatus = 'confirmed' | 'not-found' | 'unknown'

/** The original cell and move name retain strength, state and follow-up conditions. */
export interface CharacterTraitEvidence {
  moveId: string
  moveName: string
  variant: 'normal' | 'od'
  field: 'notes' | 'properties'
  text: string
  /** A matching original line, or the complete properties cell; always contained in text. */
  excerpt: string
}

export interface CharacterTraitResult {
  status: CharacterTraitStatus
  evidence: CharacterTraitEvidence[]
  unresolved: CharacterTraitEvidence[]
  reason: string | null
}

export interface CharacterTraitsCharacter extends CharacterDescriptor {
  capturedAt: string
  gameVersion: string | null
  source: CharacterSource
  traits: Record<CharacterControlType, Record<CharacterTraitId, CharacterTraitResult>>
}

export interface CharacterTraitsDataset {
  schemaVersion: 1
  rulesVersion: 1
  generatedAt: string
  sourceManifestGeneratedAt: string
  characters: CharacterTraitsCharacter[]
}
