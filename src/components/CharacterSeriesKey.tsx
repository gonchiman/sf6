import { characterSeriesStyle } from '../lib/seriesColors'

type MarkerProps = {
  shape: ReturnType<typeof characterSeriesStyle>['marker']
  x: number
  y: number
  size: number
  color: string
  className?: string
}

export function SeriesMarker({ shape, x, y, size, color, className }: MarkerProps) {
  const shared = { className, style: { fill: color } }
  if (shape === 'square') return <rect {...shared} x={x - size} y={y - size} width={size * 2} height={size * 2} />
  if (shape === 'triangle') return <path {...shared} d={`M ${x} ${y - size * 1.25} L ${x + size * 1.15} ${y + size} L ${x - size * 1.15} ${y + size} Z`} />
  if (shape === 'diamond') return <path {...shared} d={`M ${x} ${y - size * 1.3} L ${x + size * 1.3} ${y} L ${x} ${y + size * 1.3} L ${x - size * 1.3} ${y} Z`} />
  return <circle {...shared} cx={x} cy={y} r={size} />
}

/** The chart, legend and table use the same character identity. */
export function CharacterSeriesKey({ characterId }: { characterId: string }) {
  const style = characterSeriesStyle(characterId)
  return <svg className="history-series-key" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
    <line x1="1" y1="7" x2="33" y2="7" stroke={style.color} strokeWidth="2" strokeDasharray={style.dashArray} />
    <SeriesMarker shape={style.marker} x={17} y={7} size={3} color={style.color} />
  </svg>
}
