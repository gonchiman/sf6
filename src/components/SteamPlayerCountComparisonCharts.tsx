import { useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { chartTextWidth } from '../lib/chartTextWidth'
import { sampleSurveyBarAxis } from '../lib/sampleSurveyBarChart'
import { steamPlayerCountPeopleAxis } from '../lib/steamPlayerCountChartAxis'
import { steamPlayerCountGameLabel, steamPlayerCountGameStyle } from '../lib/steamPlayerCountGameColors'
import type { SteamPlayerCountComparisonSeries } from '../types/steamPlayerCountComparison'
import { SeriesMarker } from './CharacterSeriesKey'
import { nextSelectionIndex, steamPlayerCountHour, steamPlayerCountNumber, useChartWidth } from './SteamPlayerCountCharts'
import '../steam-player-count-comparison-charts.css'

type Scale = 'people' | 'index'
type Metric = 'mean' | 'peak'
const indexFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })

export function SteamPlayerCountGameKey({ appId }: { appId: number }) {
  const style = steamPlayerCountGameStyle(appId)
  return <svg className="steam-game-series-key" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
    <line x1={1} x2={33} y1={7} y2={7} stroke={style.color} strokeWidth={2} strokeDasharray={style.dashArray} />
    <SeriesMarker shape={style.marker} x={17} y={7} size={3} color={style.color} />
  </svg>
}

function hourlyValue(series: SteamPlayerCountComparisonSeries, hour: number, scale: Scale): number | null {
  const value = series.hourly.find(row => row.hour === hour)?.mean ?? null
  if (value === null) return null
  if (scale === 'people') return value
  return series.periodMean !== null && series.periodMean > 0 ? value / series.periodMean * 100 : null
}

function lineLayout(width: number, values: readonly (number | null)[], scale: Scale) {
  const { maximum, ticks: peopleTicks } = scale === 'people' ? steamPlayerCountPeopleAxis(values) : sampleSurveyBarAxis(values)
  const ticks = scale === 'people' ? peopleTicks
    : [...new Set([0, maximum / 4, maximum / 2, maximum * .75, maximum].filter(Number.isInteger))]
  const height = width < 440 ? 280 : 330
  const left = Math.max(64, ...ticks.map(value => chartTextWidth(steamPlayerCountNumber(value)) + 12))
  const right = Math.max(left + 1, width - 12), top = 30, bottom = height - 47
  const x = (hour: number) => left + 6 + hour / 23 * Math.max(1, right - left - 12)
  const y = (value: number) => bottom - 6 - value / maximum * Math.max(1, bottom - top - 12)
  return { width, height, maximum, left, right, top, bottom, x, y, ticks }
}

function lineSegments(values: readonly (number | null)[]) {
  const result: { hour: number; value: number }[][] = []
  let segment: { hour: number; value: number }[] | null = null
  values.forEach((value, hour) => {
    if (value === null) { segment = null; return }
    if (!segment) { segment = []; result.push(segment) }
    segment.push({ hour, value })
  })
  return result
}

export function SteamPlayerCountGameHourlyChart({ series, scale }: {
  series: readonly SteamPlayerCountComparisonSeries[]
  scale: Scale
}) {
  const id = useId()
  const { ref, width } = useChartWidth()
  const svgRef = useRef<SVGSVGElement>(null)
  const [hour, setHour] = useState(9)
  const plotted = series.map(item => ({ item, values: Array.from({ length: 24 }, (_, value) => hourlyValue(item, value, scale)) }))
  const chart = lineLayout(width, plotted.flatMap(item => item.values), scale)
  const hasValues = plotted.some(item => item.values.some(value => value !== null))
  const selectedCoverage = series[0]?.hourly.find(row => row.hour === hour)
  const hourTicks = width < 440 ? [0, 8, 16, 23] : [0, 4, 8, 12, 16, 20, 23]
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const next = nextSelectionIndex(event.key, hour, 24)
    if (next === null) return
    event.preventDefault()
    setHour(next)
  }
  const selectByClick = (event: MouseEvent<SVGRectElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds?.width) return
    const position = (event.clientX - bounds.left) / bounds.width * width
    setHour(Math.max(0, Math.min(23, Math.round((position - chart.x(0)) / (chart.x(23) - chart.x(0)) * 23))))
    svgRef.current?.focus({ preventScroll: true })
  }
  return <figure className="steam-player-count-chart steam-game-hourly-chart">
    <div ref={ref} className="steam-player-count-chart-viewport">
      <svg ref={svgRef} className="steam-player-count-svg" width={width} height={chart.height} viewBox={`0 0 ${width} ${chart.height}`}
        role="group" tabIndex={0} aria-labelledby={`${id}-title`} aria-describedby={`${id}-selection`} onKeyDown={onKeyDown}>
        <title id={`${id}-title`}>{`ゲーム別・時間帯別の平均同時接続数${scale === 'index' ? '（各ゲームの期間平均＝100）' : ''}`}</title>
        <g aria-hidden="true">
          <text className="steam-player-count-axis-title" x={0} y={14}>{scale === 'people' ? '同時接続数（人）' : '指数（期間平均＝100）'}</text>
          <rect className="steam-game-chart-frame" x={chart.left} y={chart.top} width={chart.right - chart.left} height={chart.bottom - chart.top} />
          {chart.ticks.map(value => <g key={value}>
            <line className="steam-player-count-grid" x1={chart.left} x2={chart.right} y1={chart.y(value)} y2={chart.y(value)} />
            <text className="steam-game-chart-tick" x={chart.left - 8} y={chart.y(value) + 4} textAnchor="end">{steamPlayerCountNumber(value)}</text>
          </g>)}
          {scale === 'index' && hasValues && chart.maximum >= 100 && <line className="steam-player-count-guide"
            x1={chart.left} x2={chart.right} y1={chart.y(100)} y2={chart.y(100)} />}
          {plotted.map(({ item, values }) => {
            const style = steamPlayerCountGameStyle(item.game.appId)
            return <g key={item.game.appId} data-steam-series={item.game.appId}>
              {lineSegments(values).map((segment, index) => segment.length > 1
                ? <path key={index} className="steam-game-chart-line" stroke={style.color} strokeDasharray={style.dashArray}
                  d={segment.map((point, position) => `${position ? 'L' : 'M'}${chart.x(point.hour)},${chart.y(point.value)}`).join(' ')} />
                : <line key={index} className="steam-game-chart-isolated" stroke={style.color}
                  x1={chart.x(segment[0].hour) - 3} x2={chart.x(segment[0].hour) + 3}
                  y1={chart.y(segment[0].value)} y2={chart.y(segment[0].value)} />)}
            </g>
          })}
          <line className="steam-player-count-guide" x1={chart.x(hour)} x2={chart.x(hour)} y1={chart.top} y2={chart.bottom} />
          {plotted.map(({ item, values }) => {
            const value = values[hour]
            if (value === null) return null
            const style = steamPlayerCountGameStyle(item.game.appId)
            return <SeriesMarker key={item.game.appId} shape={style.marker} x={chart.x(hour)} y={chart.y(value)} size={4}
              color={style.color} className="steam-game-selected-point" />
          })}
          {hourTicks.map(value => <text className="steam-game-chart-tick" key={value} x={chart.x(value)} y={chart.bottom + 21}
            textAnchor={value === 0 ? 'start' : value === 23 ? 'end' : 'middle'}>{value}</text>)}
          <text className="steam-player-count-axis-title" x={chart.right} y={chart.height - 4} textAnchor="end">時間帯（JST）</text>
        </g>
        <rect className="steam-player-count-hit" x={chart.left} y={chart.top} width={chart.right - chart.left}
          height={chart.bottom - chart.top} aria-hidden="true" onClick={selectByClick} />
      </svg>
      {!hasValues && <div className="steam-player-count-hourly-empty" role="status" style={{ left: chart.left, right: width - chart.right,
        top: chart.top, bottom: chart.height - chart.bottom }}>{scale === 'index' && series.some(item => item.periodMean === 0)
          ? '期間平均が0人のため指数を算出できません' : '共通の比較対象がありません'}</div>}
    </div>
    <figcaption className="steam-player-count-selection steam-game-selection">
      <label><span>時間帯</span><select aria-label="比較する時間帯" value={hour} onChange={event => setHour(Number(event.target.value))}>
        {Array.from({ length: 24 }, (_, value) => <option key={value} value={value}>{steamPlayerCountHour(value)}</option>)}
      </select></label>
      <div id={`${id}-selection`} className="steam-game-selection-results" role="status" aria-live="polite" aria-atomic="true">
        <span className="win-rates-visually-hidden">{steamPlayerCountHour(hour)}：</span>
        <ul className="steam-game-selection-values">{series.map(item => {
          const count = hourlyValue(item, hour, 'people'), value = hourlyValue(item, hour, scale)
          return <li key={item.game.appId}><span className="steam-game-name"><SteamPlayerCountGameKey appId={item.game.appId} />
            <abbr title={item.game.label}>{steamPlayerCountGameLabel(item.game.appId)}</abbr></span>
            <strong>{count === null ? '算出不可' : `${steamPlayerCountNumber(count)} 人`}</strong>
            {scale === 'index' && <span className="steam-player-count-meta">指数 {value === null ? '算出不可' : indexFormat.format(value)}</span>}
          </li>
        })}</ul>
        {selectedCoverage && <div className="steam-player-count-meta">共通比較 {selectedCoverage.validDays} / {selectedCoverage.totalDays} 日</div>}
      </div>
    </figcaption>
  </figure>
}

export function SteamPlayerCountGameSummaryChart({ series, metric }: {
  series: readonly SteamPlayerCountComparisonSeries[]
  metric: Metric
}) {
  const id = useId()
  const { ref, width } = useChartWidth()
  const valueOf = (item: SteamPlayerCountComparisonSeries) => metric === 'mean' ? item.periodMean : item.peak
  const rows = [...series].sort((a, b) => {
    const av = valueOf(a), bv = valueOf(b)
    return av === null ? bv === null ? a.game.appId - b.game.appId : 1
      : bv === null ? -1 : bv - av || a.game.appId - b.game.appId
  })
  const axis = sampleSurveyBarAxis(rows.map(valueOf))
  const left = Math.max(64, ...rows.map(item => chartTextWidth(steamPlayerCountGameLabel(item.game.appId)) + 12))
  const labels = rows.map(item => valueOf(item) === null ? '算出不可' : steamPlayerCountNumber(valueOf(item)!))
  const valueSpace = Math.max(62, ...labels.map(chartTextWidth)) + 10
  const right = Math.max(left + 1, width - valueSpace)
  const allTicks = axis.ticks.filter(Number.isInteger)
  const ticks = right - left < Math.max(...allTicks.map(value => chartTextWidth(steamPlayerCountNumber(value)))) * 3 + 12
    ? [allTicks[0], allTicks.at(-1)!] : allTicks
  const rowHeight = 54, top = 14, bottom = top + rows.length * rowHeight, height = bottom + 54
  const x = (value: number) => left + value / axis.maximum * (right - left)
  return <figure className="steam-player-count-chart steam-game-summary-chart">
    <div ref={ref} className="steam-player-count-chart-viewport">
      <svg className="steam-player-count-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        role="img" aria-labelledby={`${id}-title ${id}-values`}>
        <title id={`${id}-title`}>{`${metric === 'mean' ? '期間平均の同時接続数' : '期間内の最大同時接続数'}・ゲーム比較`}</title>
        <desc id={`${id}-values`}>{rows.map(item => `${item.game.label}：${valueOf(item) === null ? '算出不可' : `${steamPlayerCountNumber(valueOf(item)!)}人`}`).join('、')}</desc>
        <g aria-hidden="true">
          {ticks.map((value, index) => <g key={value}>
            <line className="steam-player-count-grid" x1={x(value)} x2={x(value)} y1={top} y2={bottom} />
            <text className="steam-game-chart-tick" x={x(value)} y={bottom + 19}
              textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}>{steamPlayerCountNumber(value)}</text>
          </g>)}
          {rows.map((item, index) => {
            const value = valueOf(item), y = top + rowHeight * index, style = steamPlayerCountGameStyle(item.game.appId)
            return <g key={item.game.appId} data-steam-summary-game={item.game.appId}>
              <text className="steam-game-bar-name" x={left - 10} y={y + rowHeight / 2 + 4} textAnchor="end">{steamPlayerCountGameLabel(item.game.appId)}</text>
              {value !== null && value > 0 && <rect className="steam-game-summary-bar" x={left} y={y + 13} width={x(value) - left} height={28} fill={style.color} />}
              {value === 0 && <line className="steam-game-summary-zero" x1={left} x2={left} y1={y + 13} y2={y + 41} stroke={style.color} />}
              <text className="steam-game-bar-value" x={value === null ? left + 8 : x(value) + 8} y={y + rowHeight / 2 + 4}>{labels[index]}</text>
            </g>
          })}
          <text className="steam-player-count-axis-title" x={width - 2} y={height - 5} textAnchor="end">同時接続数（人）</text>
        </g>
      </svg>
    </div>
  </figure>
}
