import type { CharacterControlType, CharacterDescriptor, CharacterSource } from './characters.ts'

export type CharacterTraitId = 'full' | 'air' | 'projectile' | 'armor' | 'projectileInv' | 'clash' | 'crouchingMKCancel'
export type CharacterTraitStatus = 'confirmed' | 'not-found' | 'unknown'

/** The original cell and move name retain strength, state and follow-up conditions. */
export interface CharacterTraitEvidence {
  moveId: string
  moveName: string
  variant: 'normal' | 'od'
  field: 'notes' | 'properties' | 'cancel'
  text: string
  /** A matching original line, or the complete properties cell; always contained in text. */
  excerpt: string
}

/** Original target rows are retained even when no general cancellation is confirmed. */
export interface CharacterTraitCheckedMove {
  moveId: string
  moveName: string
  input: string
  cancel: string
  properties: string
  notes: string
}

export interface CharacterTraitResult {
  status: CharacterTraitStatus
  evidence: CharacterTraitEvidence[]
  unresolved: CharacterTraitEvidence[]
  reason: string | null
  /** Required only for crouchingMKCancel; other traits retain their previous structure. */
  checkedMoves?: CharacterTraitCheckedMove[]
}

export interface CharacterTraitsCharacter extends CharacterDescriptor {
  capturedAt: string
  gameVersion: string | null
  source: CharacterSource
  traits: Record<CharacterControlType, Record<CharacterTraitId, CharacterTraitResult>>
}

export interface CharacterTraitsDataset {
  schemaVersion: 2
  rulesVersion: 2
  generatedAt: string
  sourceManifestGeneratedAt: string
  characters: CharacterTraitsCharacter[]
}
