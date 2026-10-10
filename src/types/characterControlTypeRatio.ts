export interface CharacterControlTypeRatioRow {
  characterId: string
  name: string
  /** Index in the official ALL distribution, preserved through sorting. */
  officialOrder: number
  allText: string
  classicText: string | null
  modernText: string | null
  /** Published and reconstructed percentages in the 0–100 scale. */
  allPercent: number | null
  classicPercent: number | null
  modernPercent: number | null
  reconstructedAllPercent: number | null
  /** Conditional control-type ratios within this character, in the 0–1 scale. */
  modernWithinCharacterRatio: number | null
  classicWithinCharacterRatio: number | null
  status: 'estimated' | 'unavailable'
  reason: string | null
}

export interface CharacterControlTypeRatioSort {
  key: 'official' | 'modern' | 'classic'
  direction: 'ascending' | 'descending'
}
