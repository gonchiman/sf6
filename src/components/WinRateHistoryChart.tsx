import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatHistoryValue, monthLabel } from '../lib/winRateHistory'
import { characterSeriesStyle } from '../lib/seriesColors'
import type { WinRateHistoryPoint, WinRateHistorySeries } from '../types/winRateHistory'
import { CharacterSeriesKey, SeriesMarker } from './CharacterSeriesKey'
import '../win-rate-history-chart.css'

type Props = {
  series: readonly WinRateHistorySeries[]
  selectedMonth: string
  onSelect: (month: string) => void
}

const HEIGHT = 322
const TOP = 34
const BOTTOM = 274
const LEFT = 48
const MONTH_LABEL_WIDTH = 56
const MONTH_LABEL_GAP = 16

function monthNumber(month: string): number {
  const [year, value] = month.split('-').map(Number)
  return year * 12 + value - 1
}

function hasValue(point: WinRateHistoryPoint): point is WinRateHistoryPoint & { percentHundredths: number } {
  return point.status === 'value' && point.percentHundredths !== null
    && Number.isFinite(point.percentHundredths) && point.percentHundredths >= 0 && point.percentHundredths <= 10000
}

function valueAxis(points: readonly WinRateHistoryPoint[]) {
  const values = points.filter(hasValue).map((point) => point.percentHundredths)
  const minimum = Math.min(5000, ...values)
  const maximum = Math.max(5000, ...values)
  const span = Math.max(200, maximum - minimum)
  const middle = (minimum + maximum) / 2
  const low = Math.max(0, middle - span * 0.62)
  const high = Math.min(10000, middle + span * 0.62)
  const step = [50, 100, 200, 500, 1000, 2000, 2500].find((value) => value >= (high - low) / 5) ?? 2500
  const start = Math.max(0, Math.floor(low / step) * step)
  const end = Math.min(10000, Math.ceil(high / step) * step)
  const ticks = Array.from({ length: Math.round((end - start) / step) + 1 }, (_, index) => start + index * step)
  return { start, end, ticks, step }
}

export function WinRateHistoryChart({ series, selectedMonth, onSelect }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const points = series[0]?.points ?? []
  const axis = useMemo(() => valueAxis(series.flatMap(item => item.points)), [series])

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => setAvailableWidth(Math.max(1, element.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const width = Math.max(240, availableWidth)
  const right = width - 18
  const firstMonth = points.length ? monthNumber(points[0].month) : 0
  const lastMonth = points.length ? monthNumber(points[points.length - 1].month) : firstMonth
  const x = (month: string) => firstMonth === lastMonth ? (LEFT + right) / 2
    : LEFT + (monthNumber(month) - firstMonth) / (lastMonth - firstMonth) * (right - LEFT)
  const y = (value: number) => BOTTOM - (value - axis.start) / (axis.end - axis.start) * (BOTTOM - TOP)
  const selected = points.find((point) => point.month === selectedMonth)
  const tickIndices = points.length ? [0] : []
  if (points.length > 1) {
    // Endpoint labels extend inward; reserve their full width before placing centered labels.
    const lastLabelLeft = x(points[points.length - 1].month) - MONTH_LABEL_WIDTH
    let previousLabelRight = x(points[0].month) + MONTH_LABEL_WIDTH
    for (let index = 1; index < points.length - 1; index += 1) {
      const labelLeft = x(points[index].month) - MONTH_LABEL_WIDTH / 2
      const labelRight = x(points[index].month) + MONTH_LABEL_WIDTH / 2
      if (labelLeft >= previousLabelRight + MONTH_LABEL_GAP && labelRight <= lastLabelLeft - MONTH_LABEL_GAP) {
        tickIndices.push(index)
        previousLabelRight = labelRight
      }
    }
    tickIndices.push(points.length - 1)
  }
  const renderedSeries = series.map(item => {
    const segments: string[] = []
    let previousMonth: number | null = null
    for (const point of item.points) {
      if (!hasValue(point)) {
        previousMonth = null
        continue
      }
      const currentMonth = monthNumber(point.month)
      const coordinate = `${x(point.month)} ${y(point.percentHundredths)}`
      // Split each character independently; never bridge missing observations.
      if (previousMonth === null || currentMonth !== previousMonth + 1) segments.push(`M ${coordinate}`)
      else segments[segments.length - 1] += ` L ${coordinate}`
      previousMonth = currentMonth
    }
    return { ...item, segments, numericPoints: item.points.filter(hasValue), style: characterSeriesStyle(item.characterId) }
  })
  const monthValues = (month: string) => series.map(item => {
    const point = item.points.find(value => value.month === month)
    return `${item.characterName} ${point ? formatHistoryValue(point) : '未登録'}`
  }).join('、')
  const selectionDescription = selected ? `選択中は${monthLabel(selected.month)}、${monthValues(selected.month)}。` : ''
  const period = points.length ? `${monthLabel(points[0].month)}から${monthLabel(points[points.length - 1].month)}。` : ''

  return <figure className="win-rate-history-chart">
    <figcaption><ul className="history-series-legend" aria-label="グラフのキャラクター">
      {series.map(item => <li key={item.characterId}><CharacterSeriesKey characterId={item.characterId} /><span>{item.characterName}</span></li>)}
    </ul></figcaption>
    <div ref={viewportRef} className="win-rate-history-chart-viewport">
      <div className="win-rate-history-chart-scroll" role="region" aria-label="勝率推移グラフ"
        tabIndex={availableWidth < width ? 0 : undefined}>
        <svg className="win-rate-history-chart-svg" width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
          <title id={titleId}>{`${series.map(item => item.characterName).join('・')}の月別勝率推移`}</title>
          <desc id={descriptionId}>{`${period}公式Totalの百分率換算値。破線は比較の基準となる50%。数値がない月は線をつなぎません。${selectionDescription}月別表でも各月を選択できます。`}</desc>
          <text className="win-rate-history-axis-title" x={LEFT} y="17">Total（%）</text>
          {axis.ticks.map((tick) => <g key={tick}>
            <line className={tick === 5000 ? 'win-rate-history-baseline' : 'win-rate-history-grid'}
              x1={LEFT} x2={right} y1={y(tick)} y2={y(tick)} />
            <text className="win-rate-history-tick" x={LEFT - 8} y={y(tick) + 4} textAnchor="end">
              {(tick / 100).toFixed(axis.step < 100 ? 1 : 0)}
            </text>
          </g>)}
          {!axis.ticks.includes(5000) && <line className="win-rate-history-baseline"
            x1={LEFT} x2={right} y1={y(5000)} y2={y(5000)} />}
          <text className="win-rate-history-baseline-label" x={right} y={y(5000) - 8} textAnchor="end">50% 基準</text>
          {tickIndices.map((index) => points[index] && <g key={points[index].month}>
            <line className="win-rate-history-grid win-rate-history-month-grid"
              x1={x(points[index].month)} x2={x(points[index].month)} y1={TOP} y2={BOTTOM} />
            <text className="win-rate-history-tick" x={x(points[index].month)} y={BOTTOM + 21}
              textAnchor={points.length === 1 ? 'middle' : index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>
              {points[index].month.replace('-', '/')}
            </text>
          </g>)}
          <path className="win-rate-history-axis" d={`M ${LEFT} ${TOP} V ${BOTTOM} H ${right}`} />
          {selected && <line className="win-rate-history-selection-guide" x1={x(selected.month)} x2={x(selected.month)}
            y1={TOP} y2={BOTTOM} />}
          {renderedSeries.map(item => <g key={item.characterId} data-history-character={item.characterId}>
            {item.segments.map((path, index) => <path key={index} className="win-rate-history-line" d={path}
              style={{ stroke: item.style.color }} strokeDasharray={item.style.dashArray} />)}
            {item.numericPoints.map(point => <SeriesMarker key={point.month} shape={item.style.marker}
              className={point.month === selectedMonth ? 'win-rate-history-point is-selected' : 'win-rate-history-point'}
              x={x(point.month)} y={y(point.percentHundredths)} size={point.month === selectedMonth ? 5 : 2.8} color={item.style.color} />)}
          </g>)}
          {renderedSeries.every(item => item.numericPoints.length === 0) && <text className="win-rate-history-empty" x={(LEFT + right) / 2}
            y={(TOP + BOTTOM) / 2 - 18} textAnchor="middle">表示できる数値がありません</text>}
          {points.map((point, index) => {
            const leftEdge = index === 0 ? LEFT - 8 : (x(points[index - 1].month) + x(point.month)) / 2
            const rightEdge = index === points.length - 1 ? right + 8 : (x(point.month) + x(points[index + 1].month)) / 2
            return <rect key={point.month} className="win-rate-history-month-hit" data-history-month={point.month}
              x={leftEdge} y={TOP} width={rightEdge - leftEdge} height={BOTTOM - TOP}
              onClick={() => onSelect(point.month)}>
              <title>{`${monthLabel(point.month)}：${monthValues(point.month)}`}</title>
            </rect>
          })}
          <text className="win-rate-history-axis-title" x={(LEFT + right) / 2} y={HEIGHT - 3} textAnchor="middle">対象月</text>
        </svg>
      </div>
    </div>
  </figure>
}
