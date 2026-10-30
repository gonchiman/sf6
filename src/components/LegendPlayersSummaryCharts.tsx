import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createLegendPlayerCharacterCounts, createLegendPlayerMrBins, legendPlayerCountAxis } from '../lib/legendPlayersCharts'
import { chartTextWidth as textWidth } from '../lib/chartTextWidth'
import type { LegendPlayerRow } from '../types/legendPlayers'
import '../legend-players-summary-charts.css'

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const percentFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 })
const emptyMessage = '0件（取得確認済み）'

export function LegendPlayersCharacterChart({ rows, names }: {
  rows: readonly LegendPlayerRow[]
  names: ReadonlyMap<string, string> | null
}) {
  const titleId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const characters = useMemo(() => createLegendPlayerCharacterCounts(rows, names), [rows, names])
  const axis = useMemo(() => legendPlayerCountAxis(characters.map(character => character.count)), [characters])

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
  }, [rows.length])

  if (!rows.length) return <p className="legend-players-summary-empty" role="status">{emptyMessage}</p>

  const tickTexts = axis.ticks.map(tick => integerFormat.format(tick))
  const labels = characters.map(character => ({ name: character.name, value: integerFormat.format(character.count) }))
  // Keep full tilted names inside the SVG, including an unknown character ID at the left edge.
  const left = Math.max(64, ...tickTexts.map(text => textWidth(text) + 16), ...labels.map(label => Math.ceil(textWidth(label.name) / 2) + 12))
  const top = 34, bottom = 248
  const height = bottom + Math.max(108, ...labels.map(label => Math.ceil(textWidth(label.name) * Math.sin(Math.PI / 3)) + 40))
  const minimumSlot = Math.max(availableWidth < 590 ? 34 : 20, ...labels.map(label => textWidth(label.value) + 8))
  const width = Math.max(availableWidth, left + 25 + characters.length * minimumSlot)
  const right = width - 25
  const slot = (right - left) / characters.length
  const barWidth = Math.min(28, slot * .62)
  const y = (count: number) => bottom - count / axis.maximum * (bottom - top)

  return <figure className="legend-players-character-chart" aria-labelledby={titleId}>
    <div className="legend-players-character-viewport" ref={viewportRef}>
      <div className="legend-players-character-scroll" role="region" aria-label="キャラ別掲載数グラフ・スクロール領域"
        tabIndex={width > availableWidth ? 0 : undefined}>
        <svg className="legend-players-character-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="group" aria-labelledby={titleId}>
          <title id={titleId}>キャラ別掲載数：アカウント×キャラ、件数の多い順</title>
          <g aria-hidden="true">
            <text className="legend-players-character-axis-title" x={left} y={15}>掲載数（件）</text>
            {axis.ticks.map((tick, index) => <g key={tick}>
              <line className="legend-players-character-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
              <text className="legend-players-character-tick" x={left - 10} y={y(tick) + 4} textAnchor="end">{tickTexts[index]}</text>
            </g>)}
            <path className="legend-players-character-axis" d={`M ${left} ${top} V ${bottom} H ${right}`} />
            <text className="legend-players-character-axis-title" x={(left + right) / 2} y={height - 8} textAnchor="middle">キャラクター</text>
          </g>
          {characters.map((character, index) => {
            const x = left + slot * (index + .5)
            const label = labels[index]
            return <g key={character.characterId} data-legend-character={character.characterId}
              role="img" aria-label={`${label.name}：${label.value}件`}>
              <g aria-hidden="true">
                <rect className="legend-players-character-bar" x={x - barWidth / 2} y={y(character.count)}
                  width={barWidth} height={bottom - y(character.count)} />
                <text className="legend-players-character-value" x={x} y={y(character.count) - 7} textAnchor="middle">{label.value}</text>
                <text className="legend-players-character-name" transform={`translate(${x + 3},${bottom + 17}) rotate(-60)`}
                  textAnchor="end">{label.name}</text>
              </g>
            </g>
          })}
        </svg>
      </div>
    </div>
  </figure>
}

export function LegendPlayersMrChart({ rows }: { rows: readonly LegendPlayerRow[] }) {
  const titleId = useId()
  const selectionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const [selection, setSelection] = useState<{ source: readonly LegendPlayerRow[]; lower: number } | null>(null)
  const bins = useMemo(() => createLegendPlayerMrBins(rows), [rows])
  const axis = useMemo(() => legendPlayerCountAxis(bins.map(bin => bin.count)), [bins])

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
  }, [rows.length])

  if (!bins.length) return <p className="legend-players-summary-empty" role="status">{emptyMessage}</p>

  const width = Math.max(260, availableWidth, 80 + bins.length * 32)
  const height = 310
  const left = 52, right = width - 28, top = 34, bottom = 248
  const slot = (right - left) / bins.length
  const barWidth = Math.max(1, slot - 4)
  const y = (count: number) => bottom - count / axis.maximum * (bottom - top)
  const selectedIndex = selection?.source === rows ? Math.max(0, bins.findIndex(bin => bin.lower === selection.lower)) : 0
  const selected = bins[selectedIndex]
  const binLabel = (bin: typeof selected) => `${integerFormat.format(bin.lower)}以上 ${integerFormat.format(bin.upper)}未満 MR`
  const valueLabel = (bin: typeof selected) => `${integerFormat.format(bin.count)}件 · ${percentFormat.format(bin.percent)}%`

  function navigate(event: KeyboardEvent<SVGSVGElement>) {
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(bins.length - 1, selectedIndex + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, selectedIndex - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = bins.length - 1
    else return
    event.preventDefault()
    setSelection({ source: rows, lower: bins[next].lower })
    const bar = svgRef.current?.querySelector(`[data-mr-bin="${bins[next].lower}"]`)
    const viewport = viewportRef.current
    if (bar && viewport) {
      const bounds = bar.getBoundingClientRect(), visible = viewport.getBoundingClientRect()
      if (bounds.left < visible.left) viewport.scrollLeft += bounds.left - visible.left
      else if (bounds.right > visible.right) viewport.scrollLeft += bounds.right - visible.right
    }
  }

  return <figure className="legend-players-mr-chart">
    <div className="legend-players-mr-viewport" ref={viewportRef}>
      <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        role="group" tabIndex={0} aria-labelledby={titleId} aria-describedby={selectionId} onKeyDown={navigate}>
        <title id={titleId}>MR分布：掲載数、50 MR刻み、下限以上・上限未満</title>
        <g aria-hidden="true">
          <text className="legend-players-mr-axis-title" x={left} y={15}>掲載数（件）</text>
          {axis.ticks.map(tick => <g key={tick}>
            <line className="legend-players-mr-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
            <text className="legend-players-mr-tick" x={left - 10} y={y(tick) + 4} textAnchor="end">{integerFormat.format(tick)}</text>
          </g>)}
          <path className="legend-players-mr-axis" d={`M ${left} ${top} V ${bottom} H ${right}`} />
          {bins.map((bin, index) => <text className="legend-players-mr-tick" key={bin.lower}
            x={left + slot * index} y={bottom + 20} textAnchor="middle">{integerFormat.format(bin.lower)}</text>)}
          <text className="legend-players-mr-tick" x={right} y={bottom + 20} textAnchor="middle">{integerFormat.format(bins.at(-1)!.upper)}</text>
          <text className="legend-players-mr-axis-title" x={(left + right) / 2} y={height - 10} textAnchor="middle">MR（50刻み・下限以上／上限未満）</text>
        </g>
        {bins.map((bin, index) => <g key={bin.lower} data-mr-bin={bin.lower}
          className={`legend-players-mr-bin${index === selectedIndex ? ' is-selected' : ''}`}
          role="img" aria-label={`${binLabel(bin)}：${valueLabel(bin)}`}
          onPointerEnter={() => setSelection({ source: rows, lower: bin.lower })}
          onClick={() => setSelection({ source: rows, lower: bin.lower })}>
          <title>{binLabel(bin)}：{valueLabel(bin)}</title>
          <g aria-hidden="true">
            <rect className="legend-players-mr-hit" x={left + slot * index} y={top} width={slot} height={bottom - top} />
            {bin.count > 0 ? <rect className="legend-players-mr-bar" x={left + slot * index + 2} y={y(bin.count)}
              width={barWidth} height={bottom - y(bin.count)} />
              : <line className="legend-players-mr-zero" x1={left + slot * index + 2} x2={left + slot * (index + 1) - 2} y1={bottom} y2={bottom} />}
            <text className="legend-players-mr-value" x={left + slot * (index + .5)} y={y(bin.count) - 7} textAnchor="middle">{integerFormat.format(bin.count)}</text>
          </g>
        </g>)}
      </svg>
    </div>
    <figcaption className="legend-players-mr-selection" id={selectionId}>
      <span>{binLabel(selected)}</span><span>{valueLabel(selected)}</span>
    </figcaption>
  </figure>
}
