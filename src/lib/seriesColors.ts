export type CharacterSeriesMarker = 'circle' | 'square' | 'triangle' | 'diamond'

export interface CharacterSeriesStyle {
  readonly color: string
  readonly dashArray: string | undefined
  readonly marker: CharacterSeriesMarker
}

function style(color: string, dashArray: string | undefined, marker: CharacterSeriesMarker): CharacterSeriesStyle {
  return Object.freeze({ color, dashArray, marker })
}

// Keys are Buckler character IDs. Keep each assignment when adding characters.
export const CHARACTER_SERIES_STYLES = Object.freeze({
  ryu: style('#245ea8', undefined, 'circle'),
  luke: style('#b65d00', undefined, 'square'),
  jamie: style('#25764a', undefined, 'triangle'),
  chunli: style('#147d92', undefined, 'diamond'),
  guile: style('#5b6f22', '7 4', 'circle'),
  kimberly: style('#ba3d71', '7 4', 'square'),
  juri: style('#803ca5', undefined, 'triangle'),
  ken: style('#bd3c32', undefined, 'diamond'),
  blanka: style('#3c8627', '2 4', 'circle'),
  dhalsim: style('#8a5e2a', '2 4', 'square'),
  honda: style('#365a92', '7 4', 'triangle'),
  deejay: style('#007f72', '7 4', 'diamond'),
  manon: style('#ad3979', '2 4', 'triangle'),
  marisa: style('#9b432c', '2 4', 'diamond'),
  jp: style('#654786', '9 3 2 3', 'circle'),
  zangief: style('#a82e43', '9 3 2 3', 'square'),
  lily: style('#728126', '9 3 2 3', 'triangle'),
  cammy: style('#247552', '9 3 2 3', 'diamond'),
  rashid: style('#087c9d', '2 4', 'diamond'),
  aki: style('#6b488f', '2 4', 'circle'),
  ed: style('#4362ba', '2 4', 'square'),
  gouki: style('#7d343b', '7 4', 'circle'),
  vega: style('#a33764', '9 3 2 3', 'triangle'),
  terry: style('#c24825', '7 4', 'diamond'),
  mai: style('#b63347', '2 4', 'circle'),
  elena: style('#287c7e', undefined, 'square'),
  sagat: style('#95601e', '7 4', 'square'),
  cviper: style('#a94586', undefined, 'circle'),
  alex: style('#546e30', '9 3 2 3', 'square'),
  ingrid: style('#786522', '2 4', 'diamond'),
  yasmine: style('#425aab', '9 3 2 3', 'triangle'),
})

export type CharacterSeriesId = keyof typeof CHARACTER_SERIES_STYLES

// The official frame-data roster uses these three IDs for the same characters.
export const CHARACTER_SERIES_ALIASES = Object.freeze({
  ehonda: 'honda',
  gouki_akuma: 'gouki',
  vega_mbison: 'vega',
} satisfies Record<string, CharacterSeriesId>)

export const UNKNOWN_CHARACTER_SERIES_STYLE = style('#666666', '3 3', 'square')

export function characterSeriesStyle(characterId: string): CharacterSeriesStyle {
  const canonicalId = Object.hasOwn(CHARACTER_SERIES_ALIASES, characterId)
    ? CHARACTER_SERIES_ALIASES[characterId as keyof typeof CHARACTER_SERIES_ALIASES]
    : characterId
  return Object.hasOwn(CHARACTER_SERIES_STYLES, canonicalId)
    ? CHARACTER_SERIES_STYLES[canonicalId as CharacterSeriesId]
    : UNKNOWN_CHARACTER_SERIES_STYLE
}
