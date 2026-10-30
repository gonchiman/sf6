import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { createLegendRankChart, legendRankKeyboardSelection, nearestLegendRankRow } from '../lib/legendPlayersRankChart'
import type { LegendPlayerRow } from '../types/legendPlayers'
import '../legend-players-rank-chart.css'

type Props = {
  rows: readonly LegendPlayerRow[]
  names: ReadonlyMap<string, string> | null
  selectedRowId: string | null
  onSelectRow: (id: string) => void
}
const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })

export function LegendPlayersRankChart({ rows, names, selectedRowId, onSelectRow }: Props) {
  const id = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => { if (viewport.clientWidth > 0) setAvailableWidth(viewport.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const chart = useMemo(() => createLegendRankChart(rows, availableWidth), [rows, availableWidth])
  const firstPoint = chart.points[0]
  const singlePositionPoint = firstPoint && chart.points.every(point => point.x === firstPoint.x && point.y === firstPoint.y) ? firstPoint : null
  const selectedIndex = chart.points.findIndex(point => point.row.id === selectedRowId)
  const selected = chart.points[selectedIndex]
  const characterName = selected ? names?.get(selected.row.characterId) ?? selected.row.characterId : ''
  const selectByKey = (key: string) => {
    const rowId = legendRankKeyboardSelection(chart.points, selectedRowId, key)
    if (rowId) onSelectRow(rowId)
  }
  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    selectByKey(event.key)
  }
  const handleClick = (event: MouseEvent<SVGRectElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds?.width || !bounds.height) return
    const rowId = nearestLegendRankRow(chart.points,
      (event.clientX - bounds.left) / bounds.width * chart.width,
      (event.clientY - bounds.top) / bounds.height * chart.height, selectedRowId)
    if (rowId) {
      onSelectRow(rowId)
      svgRef.current?.focus({ preventScroll: true })
    }
  }

  return <figure className="legend-players-rank-chart" aria-label="順位とMR">
    <div className="legend-players-rank-viewport" ref={viewportRef}>
      {!chart.points.length ? <div className="legend-players-rank-empty" role="status">0件（取得確認済み）</div> : <svg
        ref={svgRef} className="legend-players-rank-svg" width={chart.width} height={chart.height} viewBox={`0 0 ${chart.width} ${chart.height}`}
        role="group" tabIndex={0} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description ${id}-selection`}
        onKeyDown={handleKeyDown}>
        <title id={`${id}-title`}>順位とMR</title>
        <desc id={`${id}-description`}>横軸は順位、縦軸はMR。アカウントとキャラの組を順位順に線で結び、選択中の位置を点で表示します。
          線の近くをクリックして選択できます。同じ位置のエントリーは繰り返しクリックして切り替えます。
          データが1か所に重なる場合は点で表示します。矢印キーで前後のエントリー、HomeとEndで先頭と末尾を選択できます。</desc>
        <g aria-hidden="true">
          <text className="legend-players-rank-axis-title" x={chart.left} y={16}>MR</text>
          {chart.yAxis.ticks.map(tick => <g key={`y-${tick}`}>
            <line className="legend-players-rank-grid" x1={chart.left} x2={chart.right} y1={chart.y(tick)} y2={chart.y(tick)} />
            <text className="legend-players-rank-tick" x={chart.left - 8} y={chart.y(tick) + 4} textAnchor="end">{integerFormat.format(tick)}</text>
          </g>)}
          {chart.xAxis.ticks.map((tick, index) => <g key={`x-${tick}`}>
            <line className="legend-players-rank-grid is-vertical" x1={chart.x(tick)} x2={chart.x(tick)} y1={chart.top} y2={chart.bottom} />
            <text className="legend-players-rank-tick" x={chart.x(tick)} y={chart.bottom + 20}
              textAnchor={chart.xAxis.ticks.length === 1 ? 'middle' : index === 0 ? 'start' : index === chart.xAxis.ticks.length - 1 ? 'end' : 'middle'}>{integerFormat.format(tick)}</text>
          </g>)}
          <rect className="legend-players-rank-frame" x={chart.left} y={chart.top} width={chart.right - chart.left} height={chart.bottom - chart.top} />
          {chart.points.length > 1 && <path className="legend-players-rank-line" d={chart.path} />}
          {singlePositionPoint && <circle className="legend-players-rank-point"
            cx={singlePositionPoint.x} cy={singlePositionPoint.y} r={2.4} />}
          {selected && <g>
            <line className="legend-players-rank-guide" x1={selected.x} x2={selected.x} y1={selected.y} y2={chart.bottom} />
            <circle className="legend-players-rank-selected" data-selected-rank-row={selected.row.id} cx={selected.x} cy={selected.y} r={5.5} />
          </g>}
          <text className="legend-players-rank-axis-title" x={(chart.left + chart.right) / 2} y={chart.height - 6} textAnchor="middle">順位</text>
        </g>
        <rect className="legend-players-rank-hit" x={chart.left} y={chart.top} width={chart.right - chart.left} height={chart.bottom - chart.top}
          onClick={handleClick} aria-hidden="true" />
      </svg>}
    </div>
    {chart.points.length > 0 && <figcaption className="legend-players-rank-selection">
      <div className="legend-players-rank-selection-values" id={`${id}-selection`} role="status" aria-live="polite" aria-atomic="true">
        {selected ? <><span>{integerFormat.format(selected.row.rank)}位</span><span><bdi>{selected.row.playerName}</bdi></span>
          <span>{characterName}</span><span>{integerFormat.format(selected.row.masterRating)} MR</span></> : <span>未選択</span>}
      </div>
      <div className="legend-players-rank-selection-nav" aria-label="順位順の選択">
        <button type="button" className="win-rates-button" disabled={selectedIndex === 0} onClick={() => selectByKey('ArrowLeft')}>前へ</button>
        <button type="button" className="win-rates-button" disabled={selectedIndex === chart.points.length - 1} onClick={() => selectByKey('ArrowRight')}>次へ</button>
      </div>
    </figcaption>}
  </figure>
}
