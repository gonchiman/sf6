export type LeagueSeriesMarker = 'circle' | 'square' | 'triangle' | 'diamond'

export interface LeagueSeriesStyle {
  readonly color: string
  readonly dashArray: string | undefined
  readonly marker: LeagueSeriesMarker
}

function style(color: string, dashArray: string | undefined, marker: LeagueSeriesMarker): LeagueSeriesStyle {
  return Object.freeze({ color, dashArray, marker })
}

// League identity is separate from character identity. Keep these assignments when adding leagues.
export const LEAGUE_SERIES_STYLES = Object.freeze({
  ROOKIE: style('#365b8a', undefined, 'circle'),
  IRON: style('#56616f', undefined, 'square'),
  BRONZE: style('#8e5a2b', undefined, 'triangle'),
  SILVER: style('#577083', undefined, 'diamond'),
  GOLD: style('#917000', '7 4', 'circle'),
  PLATINUM: style('#237b7f', '7 4', 'square'),
  DIAMOND: style('#6752a3', '7 4', 'triangle'),
  MASTER: style('#245ea8', '7 4', 'diamond'),
  HIGH_MASTER: style('#a53f58', '2 4', 'circle'),
  GRAND_MASTER: style('#387344', '2 4', 'square'),
  ULTIMATE_MASTER: style('#8c408e', '2 4', 'triangle'),
})

export type LeagueSeriesId = keyof typeof LEAGUE_SERIES_STYLES

export const UNKNOWN_LEAGUE_SERIES_STYLE = style('#666666', '3 3', 'diamond')

/** Accept the source's exact league ID, independently of the order and selected statistical edition. */
export function leagueSeriesStyle(league: string): LeagueSeriesStyle {
  return Object.hasOwn(LEAGUE_SERIES_STYLES, league)
    ? LEAGUE_SERIES_STYLES[league as LeagueSeriesId]
    : UNKNOWN_LEAGUE_SERIES_STYLE
}
