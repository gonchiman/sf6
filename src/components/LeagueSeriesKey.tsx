import { leagueSeriesStyle } from '../lib/leagueSeriesColors'
import { SeriesMarker } from './CharacterSeriesKey'

/** Legends and table labels use the same league identity as the plotted series. */
export function LeagueSeriesKey({ league }: { league: string }) {
  const style = leagueSeriesStyle(league)
  return <svg className="history-series-key" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
    <line x1="1" y1="7" x2="33" y2="7" stroke={style.color} strokeWidth="2" strokeDasharray={style.dashArray} />
    <SeriesMarker shape={style.marker} x={17} y={7} size={3} color={style.color} />
  </svg>
}
