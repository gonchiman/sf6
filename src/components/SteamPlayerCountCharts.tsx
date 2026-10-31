import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { chartTextWidth } from '../lib/chartTextWidth'
import { timestampLabel } from '../lib/dateTime'
import { sampleSurveyBarAxis } from '../lib/sampleSurveyBarChart'
import { getSteamPlayerCountJstDate, STEAM_PLAYER_COUNT_SLOT_MS } from '../lib/steamPlayerCount'
import type { SteamPlayerCountHourlyRow, SteamPlayerCountObservation } from '../types/steamPlayerCount'

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
export const steamPlayerCountNumber = (value: number) => integerFormat.format(value)
export const steamPlayerCountHour = (hour: number) => `${String(hour).padStart(2, '0')}時台`

function useChartWidth(available = true) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(320)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => { if (element.clientWidth > 0) setWidth(element.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [available])
  return { ref, width }
}

function chartLayout(width: number, values: readonly (number | null)[]) {
  const { maximum } = sampleSurveyBarAxis(values)
  const ticks = [...new Set([0, maximum / 4, maximum / 2, maximum * 3 / 4, maximum].filter(Number.isInteger))]
  const height = width < 440 ? 280 : 310
  const left = Math.min(width * .42, Math.max(48, ...ticks.map(value => chartTextWidth(integerFormat.format(value)) + 10)))
  const right = Math.max(left + 1, width - 12), top = 30, bottom = height - 47
  const y = (value: number) => bottom - value / maximum * (bottom - top)
  return { width, height, left, right, top, bottom, ticks, y }
}

function ValueAxis({ chart }: { chart: ReturnType<typeof chartLayout> }) {
  return <g aria-hidden="true">
    <text className="steam-player-count-axis-title" x={0} y={14}>人数（人）</text>
    {chart.ticks.map(value => <g key={value}>
      <line className="steam-player-count-grid" x1={chart.left} x2={chart.right} y1={chart.y(value)} y2={chart.y(value)} />
      <text className="steam-player-count-tick" x={chart.left - 8} y={chart.y(value) + 4} textAnchor="end">{integerFormat.format(value)}</text>
    </g>)}
  </g>
}

function nextSelectionIndex(key: string, current: number, length: number): number | null {
  if (!length) return null
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, current - 1)
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(length - 1, current + 1)
  return null
}

export function SteamPlayerCountHourlyChart({ rows }: { rows: readonly SteamPlayerCountHourlyRow[] }) {
  const id = useId()
  const { ref, width } = useChartWidth()
  const svgRef = useRef<SVGSVGElement>(null)
  const [hour, setHour] = useState(9)
  const chart = chartLayout(width, rows.map(row => row.mean))
  const bandWidth = (chart.right - chart.left) / 24
  const x = (value: number) => chart.left + (value + .5) * bandWidth
  const selected = rows.find(row => row.hour === hour)
  const hasValues = rows.some(row => row.mean !== null)
  const hourTicks = width < 440 ? [0, 8, 16, 23] : [0, 3, 6, 9, 12, 15, 18, 21, 23]
  const selectByKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const next = nextSelectionIndex(event.key, hour, 24)
    if (next === null) return
    event.preventDefault()
    setHour(next)
  }
  const selectByClick = (event: MouseEvent<SVGRectElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds?.width) return
    const position = (event.clientX - bounds.left) / bounds.width * width
    setHour(Math.max(0, Math.min(23, Math.floor((position - chart.left) / bandWidth))))
    svgRef.current?.focus({ preventScroll: true })
  }
  return <figure className="steam-player-count-chart">
    <div ref={ref} className="steam-player-count-chart-viewport">
      <svg ref={svgRef} className="steam-player-count-svg" width={width} height={chart.height} viewBox={`0 0 ${width} ${chart.height}`}
        role="group" tabIndex={0} aria-labelledby={`${id}-title`} aria-describedby={`${id}-selection`} onKeyDown={selectByKey}>
        <title id={`${id}-title`}>時間帯別の平均同時接続数</title>
        <ValueAxis chart={chart} />
        <g aria-hidden="true">
          {rows.map(row => row.mean === null ? null : <rect key={row.hour}
            className={`steam-player-count-bar${hour === row.hour ? ' is-selected' : ''}`}
            x={chart.left + row.hour * bandWidth + bandWidth * .16} y={row.mean === 0 ? chart.bottom - 1 : chart.y(row.mean)}
            width={Math.max(1, bandWidth * .68)} height={Math.max(1, chart.bottom - chart.y(row.mean))} />)}
          {hourTicks.map(value => <text className="steam-player-count-tick" key={value} x={x(value)} y={chart.bottom + 21} textAnchor="middle">{value}</text>)}
          <text className="steam-player-count-axis-title" x={chart.right} y={chart.height - 4} textAnchor="end">時間帯（JST）</text>
        </g>
        <rect className="steam-player-count-hit" x={chart.left} y={chart.top} width={chart.right - chart.left}
          height={chart.bottom - chart.top} aria-hidden="true" onClick={selectByClick} />
      </svg>
      {!hasValues && <div className="steam-player-count-hourly-empty" role="status" style={{ left: chart.left, right: width - chart.right,
        top: chart.top, bottom: chart.height - chart.bottom }}>{rows.some(row => row.observedSlots > 0)
          ? '4区間が揃った時間帯はありません' : '対象期間の観測がありません'}</div>}
    </div>
    <figcaption className="steam-player-count-selection">
      <label><span>時間帯</span><select aria-label="時間帯" value={hour} onChange={event => setHour(Number(event.target.value))}>
        {Array.from({ length: 24 }, (_, value) => <option key={value} value={value}>{steamPlayerCountHour(value)}</option>)}
      </select></label>
      <div className="steam-player-count-selection-values" id={`${id}-selection`} role="status" aria-live="polite" aria-atomic="true">
        <span className="win-rates-visually-hidden">{steamPlayerCountHour(hour)}：</span>
        <strong>{selected?.mean == null ? '算出不可' : `平均 ${integerFormat.format(selected.mean)} 人`}</strong>
        {selected && <span className="steam-player-count-meta">比較 {selected.validDays} / {selected.totalDays} 日・観測 {selected.observedSlots} / {selected.expectedSlots} 区間</span>}
      </div>
    </figcaption>
  </figure>
}

const trendTimeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const trendDateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' })

export function SteamPlayerCountTrendChart({ observations }: { observations: readonly SteamPlayerCountObservation[] }) {
  const id = useId()
  const { ref, width } = useChartWidth(observations.length > 0)
  const svgRef = useRef<SVGSVGElement>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const rows = useMemo(() => [...observations].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)), [observations])
  const savedSelection = rows.findIndex(row => row.id === selectedId)
  const selectedIndex = savedSelection >= 0 ? savedSelection : Math.max(0, rows.length - 1)
  const selected = rows[selectedIndex]
  const chart = chartLayout(width, rows.map(row => row.playerCount))
  const firstTime = rows.length ? Date.parse(rows[0].observedAt) : 0
  const lastTime = rows.length ? Date.parse(rows.at(-1)!.observedAt) : firstTime
  const x = (value: number) => firstTime === lastTime ? (chart.left + chart.right) / 2
    : chart.left + (value - firstTime) / (lastTime - firstTime) * (chart.right - chart.left)
  const points = rows.map(row => ({ row, time: Date.parse(row.observedAt), x: x(Date.parse(row.observedAt)), y: chart.y(row.playerCount) }))
  const segments: (typeof points)[] = []
  for (const point of points) {
    const previous = segments.at(-1)?.at(-1)
    if (!previous || Math.floor(point.time / STEAM_PLAYER_COUNT_SLOT_MS) !== Math.floor(previous.time / STEAM_PLAYER_COUNT_SLOT_MS) + 1) segments.push([point])
    else segments.at(-1)!.push(point)
  }
  const selectedPoint = points[selectedIndex]
  const tickCount = Math.min(rows.length, width < 440 ? 3 : 5)
  const tickIndices = [...new Set(Array.from({ length: tickCount }, (_, index) => tickCount === 1 ? 0
    : Math.round(index / (tickCount - 1) * (rows.length - 1))))]
  const multipleDays = rows.length > 0 && getSteamPlayerCountJstDate(rows[0].observedAt) !== getSteamPlayerCountJstDate(rows.at(-1)!.observedAt)
  const selectIndex = (index: number) => { if (rows[index]) setSelectedId(rows[index].id) }
  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const next = nextSelectionIndex(event.key, selectedIndex, rows.length)
    if (next === null) return
    event.preventDefault()
    selectIndex(next)
  }
  const handleClick = (event: MouseEvent<SVGRectElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds?.width) return
    const position = (event.clientX - bounds.left) / bounds.width * width
    let nearest = 0
    for (let index = 1; index < points.length; index += 1) {
      if (Math.abs(points[index].x - position) < Math.abs(points[nearest].x - position)) nearest = index
    }
    selectIndex(nearest)
    svgRef.current?.focus({ preventScroll: true })
  }
  if (!rows.length) return <div className="steam-player-count-empty" role="status">対象期間の観測がありません</div>
  return <figure className="steam-player-count-chart">
    <div ref={ref} className="steam-player-count-chart-viewport">
      <svg ref={svgRef} className="steam-player-count-svg" width={width} height={chart.height} viewBox={`0 0 ${width} ${chart.height}`}
        role="group" tabIndex={0} aria-labelledby={`${id}-title`} aria-describedby={`${id}-selection`} onKeyDown={handleKeyDown}>
        <title id={`${id}-title`}>同時接続数の観測推移</title>
        <ValueAxis chart={chart} />
        <g aria-hidden="true">
          {segments.map((segment, index) => <path key={index} className="steam-player-count-line"
            d={segment.map((point, position) => `${position === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')} />)}
          {segments.filter(segment => segment.length === 1 && segment[0] !== selectedPoint).map(segment => <circle
            key={segment[0].row.id} className="steam-player-count-isolated-point" cx={segment[0].x} cy={segment[0].y} r={2.5} />)}
          {selectedPoint && <>
            <line className="steam-player-count-guide" x1={selectedPoint.x} x2={selectedPoint.x} y1={chart.top} y2={chart.bottom} />
            <circle className="steam-player-count-selected-point" cx={selectedPoint.x} cy={selectedPoint.y} r={4.5} />
          </>}
          {tickIndices.map((index, position) => <text className="steam-player-count-tick" key={rows[index].id}
            x={points[index].x} y={chart.bottom + 21} textAnchor={tickIndices.length === 1 ? 'middle' : position === 0 ? 'start' : position === tickIndices.length - 1 ? 'end' : 'middle'}>
            {multipleDays ? trendDateFormat.format(points[index].time) : trendTimeFormat.format(points[index].time)}
          </text>)}
          <text className="steam-player-count-axis-title" x={chart.right} y={chart.height - 4} textAnchor="end">取得日時（JST）</text>
        </g>
        <rect className="steam-player-count-hit" x={chart.left} y={chart.top} width={chart.right - chart.left}
          height={chart.bottom - chart.top} aria-hidden="true" onClick={handleClick} />
      </svg>
    </div>
    <figcaption className="steam-player-count-selection">
      <div className="steam-player-count-selection-values" id={`${id}-selection`} role="status" aria-live="polite" aria-atomic="true">
        <time dateTime={selected.observedAt}>{timestampLabel(selected.observedAt)}</time><strong>{integerFormat.format(selected.playerCount)} 人</strong>
      </div>
      <div className="steam-player-count-selection-nav" aria-label="観測の選択">
        <button className="win-rates-button" type="button" disabled={selectedIndex === 0} onClick={() => selectIndex(selectedIndex - 1)}>前へ</button>
        <button className="win-rates-button" type="button" disabled={selectedIndex === rows.length - 1} onClick={() => selectIndex(selectedIndex + 1)}>次へ</button>
      </div>
    </figcaption>
  </figure>
}
