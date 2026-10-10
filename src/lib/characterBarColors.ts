import { characterSeriesStyle, UNKNOWN_CHARACTER_SERIES_STYLE, type CharacterSeriesStyle } from './seriesColors.ts'

const NEUTRAL_CHANNEL = 0x99
const CHARACTER_COLOR_SHARE = .15
const MONOCHROME_BAR_COLOR = '#8c8c8c'

/** Large fills use a muted version of the canonical character color. */
export function characterBarSeriesStyle(characterId: string, useCharacterColors = true): CharacterSeriesStyle {
  const series = characterSeriesStyle(characterId)
  if (series === UNKNOWN_CHARACTER_SERIES_STYLE) return series
  const color = useCharacterColors
    ? `#${[1, 3, 5].map(start => Math.round(
      Number.parseInt(series.color.slice(start, start + 2), 16) * CHARACTER_COLOR_SHARE
      + NEUTRAL_CHANNEL * (1 - CHARACTER_COLOR_SHARE),
    ).toString(16).padStart(2, '0')).join('')}`
    : MONOCHROME_BAR_COLOR
  return Object.freeze({ ...series, color })
}
