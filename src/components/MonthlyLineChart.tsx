import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { monthLabel } from '../lib/winRateHistory'
import {
  hasMonthlyChartValue, MONTHLY_LINE_CHART_LAYOUT, monthlyChartCoordinates,
  monthlyChartLabelIndices, monthlyChartMonths, monthlyChartSegments,
} from '../lib/monthlyLineChart'
import type { MonthlyLineChartAxis, MonthlyLineChartSeries } from '../types/monthlyLineChart'
import { SeriesMarker } from './CharacterSeriesKey'
import '../monthly-line-chart.css'

type Props = {
  series: readonly MonthlyLineChartSeries[]
  selectedMonth: string
  onSelect: (month: string) => void
  title: string
  description: string
  regionLabel: string
  axisLabel: string
  axis: MonthlyLineChartAxis
  formatTick: (value: number) => string
  valueLabel: (seriesId: string, month: string) => string
  reference?: { value: number; label: string }
  legend?: ReactNode
}

/** Shared monthly SVG rendering; its callers supply statistical meaning, units, colors and legends. */
export function MonthlyLineChart({
  series, selectedMonth, onSelect, title, description, regionLabel, axisLabel, axis,
  formatTick, valueLabel, reference, legend,
}: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const months = useMemo(() => monthlyChartMonths(series), [series])

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => setAvailableWidth(Math.max(1, element.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const { height, top, bottom, left, minimumWidth } = MONTHLY_LINE_CHART_LAYOUT
  const width = Math.max(minimumWidth, availableWidth)
  const { right, x, y } = monthlyChartCoordinates(months, width, axis)
  const tickIndices = monthlyChartLabelIndices(months, x)
  const renderedSeries = series.map(item => ({
    ...item, segments: monthlyChartSegments(item.points, x, y), numericPoints: item.points.filter(hasMonthlyChartValue),
  }))
  const monthValues = (month: string) => series.map(item => `${item.label} ${valueLabel(item.id, month)}`).join('、')
  const hasSelection = months.includes(selectedMonth)
  const selectionDescription = hasSelection ? `選択中は${monthLabel(selectedMonth)}、${monthValues(selectedMonth)}。` : ''
  const period = months.length ? `${monthLabel(months[0])}から${monthLabel(months[months.length - 1])}。` : ''
  const visibleReference = reference && Number.isFinite(reference.value)
    && reference.value >= axis.start && reference.value <= axis.end ? reference : undefined

  return <figure className="monthly-line-chart win-rate-history-chart">
    {legend && <figcaption>{legend}</figcaption>}
    <div ref={viewportRef} className="monthly-line-chart-viewport win-rate-history-chart-viewport">
      <div className="monthly-line-chart-scroll win-rate-history-chart-scroll" role="region" aria-label={regionLabel}
        tabIndex={availableWidth < width ? 0 : undefined}>
        <svg className="monthly-line-chart-svg win-rate-history-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
          <title id={titleId}>{title}</title>
          <desc id={descriptionId}>{`${period}${description}${selectionDescription}月別表でも各月を選択できます。`}</desc>
          <text className="monthly-line-chart-axis-title win-rate-history-axis-title" x={left} y="17">{axisLabel}</text>
          {axis.ticks.map(tick => <g key={tick}>
            <line className={tick === visibleReference?.value ? 'monthly-line-chart-baseline win-rate-history-baseline' : 'monthly-line-chart-grid win-rate-history-grid'}
              x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
            <text className="monthly-line-chart-tick win-rate-history-tick" x={left - 8} y={y(tick) + 4} textAnchor="end">
              {formatTick(tick)}
            </text>
          </g>)}
          {visibleReference && <>
            {!axis.ticks.includes(visibleReference.value) && <line className="monthly-line-chart-baseline win-rate-history-baseline"
              x1={left} x2={right} y1={y(visibleReference.value)} y2={y(visibleReference.value)} />}
            <text className="monthly-line-chart-baseline-label win-rate-history-baseline-label" x={right} y={y(visibleReference.value) - 8} textAnchor="end">
              {visibleReference.label}
            </text>
          </>}
          {tickIndices.map(index => <g key={months[index]}>
            <line className="monthly-line-chart-grid monthly-line-chart-month-grid win-rate-history-grid win-rate-history-month-grid"
              x1={x(months[index])} x2={x(months[index])} y1={top} y2={bottom} />
            <text className="monthly-line-chart-tick win-rate-history-tick" x={x(months[index])} y={bottom + 21}
              textAnchor={months.length === 1 ? 'middle' : index === 0 ? 'start' : index === months.length - 1 ? 'end' : 'middle'}>
              {months[index].replace('-', '/')}
            </text>
          </g>)}
          <path className="monthly-line-chart-axis win-rate-history-axis" d={`M ${left} ${top} V ${bottom} H ${right}`} />
          {hasSelection && <line className="monthly-line-chart-selection-guide win-rate-history-selection-guide" x1={x(selectedMonth)} x2={x(selectedMonth)}
            y1={top} y2={bottom} />}
          {renderedSeries.map(item => <g key={item.id} data-chart-series={item.id} data-history-character={item.id}>
            {item.segments.map((path, index) => <path key={index} className="monthly-line-chart-line win-rate-history-line" d={path}
              style={{ stroke: item.style.color }} strokeDasharray={item.style.dashArray} />)}
            {item.numericPoints.map(point => <SeriesMarker key={point.month} shape={item.style.marker}
              className={`monthly-line-chart-point win-rate-history-point${point.month === selectedMonth ? ' is-selected' : ''}`}
              x={x(point.month)} y={y(point.value)} size={point.month === selectedMonth ? 5 : 2.8} color={item.style.color} />)}
          </g>)}
          {renderedSeries.every(item => item.numericPoints.length === 0) && <text className="monthly-line-chart-empty win-rate-history-empty" x={(left + right) / 2}
            y={(top + bottom) / 2 - 18} textAnchor="middle">表示できる数値がありません</text>}
          {months.map((month, index) => {
            const leftEdge = index === 0 ? left - 8 : (x(months[index - 1]) + x(month)) / 2
            const rightEdge = index === months.length - 1 ? right + 8 : (x(month) + x(months[index + 1])) / 2
            return <rect key={month} className="monthly-line-chart-month-hit win-rate-history-month-hit" data-chart-month={month} data-history-month={month}
              x={leftEdge} y={top} width={rightEdge - leftEdge} height={bottom - top}
              onClick={() => onSelect(month)}>
              <title>{`${monthLabel(month)}：${monthValues(month)}`}</title>
            </rect>
          })}
          <text className="monthly-line-chart-axis-title win-rate-history-axis-title" x={(left + right) / 2} y={height - 3} textAnchor="middle">対象月</text>
        </svg>
      </div>
    </div>
  </figure>
}
