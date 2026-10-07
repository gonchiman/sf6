export type WinRateOperationMode = 'combined' | 'separate'
export type WinRateControlType = 'classic' | 'modern' | null

export interface WinRateSource {
  url: string
  title: string
}

export interface WinRateDatasetDescriptor {
  id: string
  month: string
  league: string
  operationMode: WinRateOperationMode
  path: string
  capturedAt: string
}

export interface WinRateManifest {
  schemaVersion: 1
  generatedAt: string
  source: WinRateSource
  datasets: WinRateDatasetDescriptor[]
}

export interface WinRateFighter {
  id: string
  characterId: string
  name: string
  controlType: WinRateControlType
}

export interface WinRateCell {
  /** Official display text, including its precision and missing-value marker. */
  text: string
  lowSample: boolean
}

export interface WinRateRow {
  fighterId: string
  total: WinRateCell
  /** Columns follow the dataset's fighters order. */
  cells: WinRateCell[]
}

export interface WinRateDataset {
  schemaVersion: 1
  id: string
  month: string
  league: string
  operationMode: WinRateOperationMode
  capturedAt: string
  generatedAt: string
  source: WinRateSource & {
    population: string
    metric: string
    notes: string[]
  }
  fighters: WinRateFighter[]
  rows: WinRateRow[]
}
