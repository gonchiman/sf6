import { useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { chartTextWidth } from '../lib/chartTextWidth'
import '../win-usage-scatter-chart.css'

type ScatterPoint = { characterId: string; name: string; winRate: number; usageRate: number }
type Props = { points: readonly ScatterPoint[]; showNames?: boolean }
type PlottedPoint = ScatterPoint & { x: number; y: number }
type Selection = { source: readonly ScatterPoint[]; characterId: string }
type Bounds = { left: number; right: number; top: number; bottom: number }

function percentageAxis(values: readonly number[], count: number) {
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const padding = Math.max((maximum - minimum) * .1, .25)
  const low = Math.max(0, minimum - padding)
  const high = Math.min(100, maximum + padding)
  const rawStep = Math.max(high - low, .5) / (count - 1)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const step = ([1, 2, 2.5, 5, 10].find(value => value * magnitude >= rawStep) ?? 10) * magnitude
  const start = Math.max(0, Math.floor(low / step) * step)
  const end = Math.min(100, Math.ceil(high / step) * step)
  const ticks: number[] = []
  for (let value = Math.ceil(start / step) * step; value <= end + step / 1e6; value += step) {
    ticks.push(Number(value.toFixed(6)))
  }
  return { start, end, ticks }
}

function scatterLabels(points: readonly PlottedPoint[], bounds: Bounds) {
  const placed: Bounds[] = []
  return points.flatMap(point => {
    const textWidth = chartTextWidth(point.name)
    const candidates = [
      { x: point.x + 9, y: point.y - 7, anchor: 'start' as const },
      { x: point.x - 9, y: point.y - 7, anchor: 'end' as const },
      { x: point.x + 9, y: point.y + 18, anchor: 'start' as const },
      { x: point.x - 9, y: point.y + 18, anchor: 'end' as const },
    ]
    for (const candidate of candidates) {
      const left = candidate.anchor === 'start' ? candidate.x : candidate.x - textWidth
      const box = { left: left - 2, right: left + textWidth + 2, top: candidate.y - 13, bottom: candidate.y + 3 }
      if (box.left < bounds.left || box.right > bounds.right || box.top < bounds.top || box.bottom > bounds.bottom) continue
      if (placed.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue
      if (points.some(other => other.characterId !== point.characterId && other.x > box.left - 5 && other.x < box.right + 5
        && other.y > box.top - 5 && other.y < box.bottom + 5)) continue
      placed.push(box)
      return [{ ...candidate, point }]
    }
    return []
  })
}

const tickLabel = (value: number) => `${Number(value.toFixed(2))}`

/** Character cross section; supplied percentages already share the same statistical conditions. */
export function WinUsageScatterChart({ points, showNames = false }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const [hover, setHover] = useState<Selection | null>(null)
  const [pinned, setPinned] = useState<Selection | null>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => setAvailableWidth(Math.max(1, viewport.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const numericPoints = useMemo(() => points.filter(point => Number.isFinite(point.winRate) && Number.isFinite(point.usageRate)
    && point.winRate >= 0 && point.winRate <= 100 && point.usageRate >= 0 && point.usageRate <= 100), [points])
  const width = Math.max(1, availableWidth)
  const height = width < 420 ? 330 : 400
  const left = width < 420 ? 48 : 58
  const right = Math.max(left + 1, width - 18)
  const top = 30
  const bottom = height - 50
  const axisCount = width < 420 ? 3 : 6
  const xAxis = percentageAxis(numericPoints.length ? numericPoints.map(point => point.usageRate) : [0, 1], axisCount)
  const yAxis = percentageAxis(numericPoints.length ? numericPoints.map(point => point.winRate) : [0, 1], 6)
  const x = (value: number) => left + 8 + (value - xAxis.start) / (xAxis.end - xAxis.start) * Math.max(1, right - left - 16)
  const y = (value: number) => bottom - 8 - (value - yAxis.start) / (yAxis.end - yAxis.start) * Math.max(1, bottom - top - 16)
  const plotted = numericPoints.map(point => ({ ...point, x: x(point.usageRate), y: y(point.winRate) }))
  const activeId = hover?.source === points ? hover.characterId : pinned?.source === points ? pinned.characterId : null
  const activePoint = plotted.find(point => point.characterId === activeId)
  const labels = showNames ? scatterLabels(plotted, { left, right, top, bottom }) : []
  const tooltipWidth = Math.min(190, Math.max(1, width - 8))
  const tooltipLeft = activePoint ? Math.max(4, Math.min(width - tooltipWidth - 4, activePoint.x + 12)) : 0
  const tooltipTop = activePoint ? Math.max(4, Math.min(height - 80, activePoint.y - 76)) : 0

  const nearestPoint = (event: PointerEvent<SVGRectElement> | MouseEvent<SVGRectElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds || !bounds.width || !bounds.height) return undefined
    const pointerX = (event.clientX - bounds.left) / bounds.width * width
    const pointerY = (event.clientY - bounds.top) / bounds.height * height
    const nearest = plotted.reduce<{ point?: PlottedPoint; distance: number }>((best, point) => {
      const distance = Math.hypot(point.x - pointerX, point.y - pointerY)
      return distance < best.distance ? { point, distance } : best
    }, { distance: 32 })
    return nearest.point
  }
  const handleMove = (event: PointerEvent<SVGRectElement>) => {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    const point = nearestPoint(event)
    setHover(current => current?.source === points && current.characterId === point?.characterId ? current
      : point ? { source: points, characterId: point.characterId } : null)
  }
  const handleClick = (event: MouseEvent<SVGRectElement>) => {
    const point = nearestPoint(event)
    setHover(null)
    setPinned(current => point && !(current?.source === points && current.characterId === point.characterId)
      ? { source: points, characterId: point.characterId } : null)
  }

  return <figure className="win-usage-scatter" aria-label="勝率と使用率の散布図">
    <div className="win-usage-scatter-viewport" ref={viewportRef}>
      {!numericPoints.length ? <p className="win-usage-scatter-empty" role="status">表示できるキャラがありません</p> : <>
        <svg ref={svgRef} className="win-usage-scatter-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
          <title id={titleId}>勝率と使用率の散布図</title>
          <desc id={descriptionId}>点はキャラ1体、横軸は使用率、縦軸は公式Totalを換算した勝率です。
            対象は{numericPoints.length}キャラです。各キャラの数値はキャラ別テーブルでも確認できます。</desc>
          <g aria-hidden="true">
            <text className="win-usage-scatter-axis-title" x={left} y="17">勝率（%）</text>
            {yAxis.ticks.map(tick => <g key={tick}>
              <line className="win-usage-scatter-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
              <text className="win-usage-scatter-tick" x={left - 8} y={y(tick) + 4} textAnchor="end">{tickLabel(tick)}</text>
            </g>)}
            {xAxis.ticks.map((tick, index) => <g key={tick}>
              <line className="win-usage-scatter-grid is-vertical" x1={x(tick)} x2={x(tick)} y1={top} y2={bottom} />
              <text className="win-usage-scatter-tick" x={x(tick)} y={bottom + 20}
                textAnchor={index === 0 ? 'start' : index === xAxis.ticks.length - 1 ? 'end' : 'middle'}>{tickLabel(tick)}</text>
            </g>)}
            <rect className="win-usage-scatter-frame" x={left} y={top} width={right - left} height={bottom - top} />
            {plotted.map(point => <circle key={point.characterId} data-scatter-character={point.characterId}
              className={`win-usage-scatter-point${point.characterId === activeId ? ' is-active' : ''}`}
              cx={point.x} cy={point.y} r={point.characterId === activeId ? 6 : 4.5} />)}
            {labels.map(({ point, x: labelX, y: labelY, anchor }) => <text key={point.characterId}
              className="win-usage-scatter-name" x={labelX} y={labelY} textAnchor={anchor}>{point.name}</text>)}
            <text className="win-usage-scatter-axis-title" x={(left + right) / 2} y={height - 5} textAnchor="middle">使用率（%）</text>
          </g>
          <rect className="win-usage-scatter-hit" x={left} y={top} width={right - left} height={bottom - top}
            onPointerMove={handleMove} onPointerLeave={() => setHover(null)} onClick={handleClick} aria-hidden="true" />
        </svg>
        {activePoint && <div className="win-usage-scatter-tooltip" style={{ left: tooltipLeft, top: tooltipTop, width: tooltipWidth }}>
          <strong>{activePoint.name}</strong>
          <span>使用率 {activePoint.usageRate.toFixed(3)}%</span>
          <span>勝率 {activePoint.winRate.toFixed(2)}%</span>
        </div>}
      </>}
    </div>
  </figure>
}
