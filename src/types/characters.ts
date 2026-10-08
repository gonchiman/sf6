export type CharacterControlType = 'classic' | 'modern'

export interface CharacterSource {
  title: string
  url: string
}

export interface CharacterDescriptor {
  id: string
  name: string
  englishName: string
  file: string
}

export interface CharacterManifest {
  schemaVersion: 1
  generatedAt: string
  characters: CharacterDescriptor[]
}

/** Official cell text is retained, including blanks and conditional expressions. */
export interface CharacterMove {
  id: string
  controlType: CharacterControlType
  category: string
  name: string
  inputs: { classic: string; modern: string }
  startup: string
  active: string
  recovery: string
  onHit: string
  onBlock: string
  cancel: string
  damage: string
  comboScaling: string
  driveGaugeGain: string
  driveGaugeLoss: string
  punishCounterDriveLoss: string
  superGaugeGain: string
  properties: string
  notes: string
}

export interface CharacterDataset {
  schemaVersion: 1
  id: string
  name: string
  englishName: string
  health: number | null
  capturedAt: string
  /** Null when the official table does not identify a game patch. */
  gameVersion: string | null
  source: CharacterSource
  moves: CharacterMove[]
}

export type CharacterNumericSortKey = 'startup' | 'active' | 'recovery' | 'onHit' | 'onBlock' | 'damage'

export interface CharacterMoveSort {
  key: CharacterNumericSortKey
  direction: 'asc' | 'desc'
}

export interface CharacterMoveFilters {
  query: string
  controlType?: CharacterControlType
  /** Empty string or ALL means every category. */
  category: string
}
