import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { chartTextWidth } from '../lib/chartTextWidth'
import { mrDistributionChartLabelLines, mrDistributionChartPercentLabel, type MrDistributionChartInterval, type MrDistributionChartLabelStyle } from '../lib/mrDistributionChart'
import {
  rankDistributionChartAxis, rankDistributionChartValue, rankDistributionChartValueLabel,
  type RankDistributionChartMetric,
} from '../lib/rankDistributionChart'
import type { RankDistributionRow } from '../types/rankDistribution'
import '../rank-distribution-chart.css'

type Props = {
  rows: readonly RankDistributionRow[]
  metric: RankDistributionChartMetric
  estimated?: boolean
  label?: string
  categoryLabel?: string
  percentLabel?: string
  denominatorDescription?: string
  /** Keep every bar visible while thinning axis and zero labels for many categories. */
  compactCategories?: boolean
  intervals?: readonly MrDistributionChartInterval[]
  intervalLabelStyle?: MrDistributionChartLabelStyle
  /** Capture and visible-range identity, used to discard selection and recenter the initial view. */
  selectionKey?: string
}

const PLOT_HEIGHT = 262
const TOP = 48
const RIGHT = 24
const MINIMUM_WIDTH = 320
const LABEL_ANGLE = 55
const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const percentageFormat = new Intl.NumberFormat('ja-JP', { maximumSignificantDigits: 3 })

function tickLabel(value: number, metric: RankDistributionChartMetric): string {
  if (metric === 'count') return integerFormat.format(value)
  return `${value > 0 && value < .01 ? value.toExponential(1) : percentageFormat.format(value)}%`
}

function niceLabelStep(required: number): number {
  return [1, 2, 5, 10, 20, 50].find(step => step >= required) ?? required
}

export function RankDistributionChart({ rows, metric, estimated = false, label = 'ランク分布',
  categoryLabel = 'ランク', percentLabel = '全体比',
  denominatorDescription = '割合の分母は、★別表示でも掲載アカウント全体です。', compactCategories = false,
  intervals, intervalLabelStyle = 'axis', selectionKey }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const instructionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const barRefs = useRef<(SVGGElement | null)[]>([])
  const scrollResetRef = useRef('')
  const [availableWidth, setAvailableWidth] = useState(MINIMUM_WIDTH)
  const [selection, setSelection] = useState<{ key: string; id: string } | null>(null)
  const axis = useMemo(() => rankDistributionChartAxis(rows, metric), [rows, metric])
  const values = useMemo(() => rows.map(row => rankDistributionChartValue(row, metric)), [rows, metric])
  const hasValues = values.some(value => value !== null)
  const intervalChart = intervals !== undefined
  const formatValue = (value: number | null, selectedMetric: RankDistributionChartMetric) => intervalChart && selectedMetric === 'percent'
    ? mrDistributionChartPercentLabel(value) : rankDistributionChartValueLabel(value, selectedMetric)
  const intervalsMatch = intervals === undefined || intervals.length === rows.length
    && intervals.every((interval, index) => Number.isSafeInteger(interval.minimum) && interval.minimum >= 0
      && (interval.maximum === null ? index === intervals.length - 1
        : Number.isSafeInteger(interval.maximum) && interval.maximum > interval.minimum))
  const effectiveIntervals = intervalsMatch ? intervals : undefined
  const metricLabel = metric === 'percent' ? `${percentLabel}（%）` : 'アカウント数（件）'
  const ticks = availableWidth < 420 && axis.ticks.length > 4
    ? axis.ticks.filter((_, index) => index % 2 === 0 || index === axis.ticks.length - 1)
    : axis.ticks
  const tickTexts = ticks.map(tick => tickLabel(tick, metric))
  const axisWidth = Math.max(64, ...tickTexts.map(text => chartTextWidth(text) + 14))
  const intervalLines = effectiveIntervals?.map(interval => mrDistributionChartLabelLines(interval, intervalLabelStyle)) ?? []
  const longestIntervalLine = Math.max(0, ...intervalLines.flat().map(chartTextWidth))
  // Category labels use 11px text; preserve every line without padding them like 12px value labels.
  const minimumIntervalSlot = intervalLabelStyle === 'axis' ? 12 : Math.ceil(longestIntervalLine * 11 / 12) + 8
  const plotViewportWidth = Math.max(1, availableWidth - axisWidth)
  // LP retains its original geometry. MR keeps its vertical axis outside the scroll region.
  const width = intervalChart
    ? Math.max(plotViewportWidth, Math.max(1, rows.length) * minimumIntervalSlot + RIGHT)
    : Math.max(MINIMUM_WIDTH, availableWidth)
  const left = intervalChart ? 0 : axisWidth
  const right = width - RIGHT
  const slot = (right - left) / Math.max(1, rows.length)
  const barWidth = intervalChart ? slot * .9 : Math.min(36, Math.max(8, slot * .52))
  const bottom = TOP + PLOT_HEIGHT
  const longestRankLabel = Math.max(0, ...rows.map(row => chartTextWidth(row.label)))
  const rotateRankLabels = !intervalChart && longestRankLabel + 12 > slot
  const labelSpacing = (rotateRankLabels ? longestRankLabel * Math.cos(LABEL_ANGLE * Math.PI / 180) : longestRankLabel) + 12
  const requiredLabelStep = compactCategories ? Math.max(1, Math.ceil(labelSpacing / slot)) : 1
  const labelStep = niceLabelStep(requiredLabelStep)
  const showCategoryLabel = (index: number) => index === rows.length - 1
    || index % labelStep === 0 && rows.length - 1 - index >= labelStep
  const height = intervalChart ? bottom + (intervalLabelStyle === 'range-two-line' ? 76 : 58)
    : bottom + (rotateRankLabels ? Math.ceil(longestRankLabel * Math.sin(LABEL_ANGLE * Math.PI / 180)) + 40 : 58)
  const labels = values.map(value => value === 0 ? metric === 'percent' ? '0%' : '0' : formatValue(value, metric))
  const showAllValues = labels.every(value => chartTextWidth(value) + 12 <= slot)
  const maximum = Math.max(0, ...values.flatMap(value => value === null ? [] : [value]))
  const maximumIndex = Math.max(0, values.findIndex(value => value === maximum))
  const y = (value: number) => bottom - value / axis.maximum * PLOT_HEIGHT
  const center = (index: number) => left + slot * (index + .5)
  const valueLabelX = (index: number) => Math.max(chartTextWidth(labels[index]) / 2 + 4,
    Math.min(width - chartTextWidth(labels[index]) / 2 - 4, center(index)))
  const interactionKey = JSON.stringify([selectionKey ?? '', intervalLabelStyle, metric, availableWidth, rows.map(row => row.id)])
  const storedSelectionIndex = selection?.key === interactionKey ? rows.findIndex(row => row.id === selection.id) : -1
  const selectedIndex = storedSelectionIndex >= 0 ? storedSelectionIndex : maximumIndex
  const selectedRow = rows[selectedIndex]
  const resetKey = JSON.stringify([interactionKey, intervalLabelStyle, metric, availableWidth])
  const overflowing = intervalChart ? width > plotViewportWidth + 1 : availableWidth < width

  // Greedy placement starts at the peak. A positive label may not cover another label or bar.
  const intervalValueLabels = new Set<number>()
  const acceptedLabels: { left: number; right: number; top: number; bottom: number }[] = []
  if (intervalChart) {
    const candidates = values.flatMap((value, index) => value !== null && value > 0 ? [{ value, index }] : [])
      .sort((a, b) => b.value - a.value || a.index - b.index)
    for (const { value, index } of candidates) {
      const half = chartTextWidth(labels[index]) / 2 + 4
      const box = { left: valueLabelX(index) - half, right: valueLabelX(index) + half, top: y(value) - 23, bottom: y(value) - 6 }
      const collidesWithLabel = acceptedLabels.some(other => box.left < other.right + 4 && box.right > other.left - 4
        && box.top < other.bottom + 3 && box.bottom > other.top - 3)
      const collidesWithBar = values.some((other, otherIndex) => otherIndex !== index && other !== null && other > 0
        && box.left < center(otherIndex) + barWidth / 2 && box.right > center(otherIndex) - barWidth / 2
        && box.bottom > y(other) && box.top < bottom)
      if (index === maximumIndex || !collidesWithLabel && !collidesWithBar) {
        intervalValueLabels.add(index)
        acceptedLabels.push(box)
      }
    }
  }

  const axisTicks: { label: string; x: number; anchor: 'start' | 'middle' | 'end' }[] = []
  if (effectiveIntervals && intervalLabelStyle === 'axis' && effectiveIntervals.length > 0) {
    const lastInterval = effectiveIntervals.at(-1)!
    const finalLabel = lastInterval.maximum === null ? `${lastInterval.minimum}以上` : String(lastInterval.maximum)
    const finalX = lastInterval.maximum === null ? center(effectiveIntervals.length - 1) : right
    const step = niceLabelStep(Math.max(1, Math.ceil((Math.max(...effectiveIntervals.map(interval => chartTextWidth(String(interval.minimum)))) + 14) / slot)))
    effectiveIntervals.forEach((interval, index) => {
      const x = left + slot * index
      if (index === effectiveIntervals.length - 1 && interval.maximum === null) return
      if (index % step === 0 && (index === 0 || finalX - x > (chartTextWidth(String(interval.minimum)) + chartTextWidth(finalLabel)) / 2 + 10)) {
        axisTicks.push({ label: String(interval.minimum), x, anchor: index === 0 ? 'start' : 'middle' })
      }
    })
    axisTicks.push({ label: finalLabel, x: finalX, anchor: lastInterval.maximum === null ? 'middle' : 'end' })
  }

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => {
      const measured = element.clientWidth
      if (measured > 0) setAvailableWidth(measured)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [rows.length, metric, hasValues, intervalChart, intervalsMatch])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!intervalChart || !hasValues || !element || scrollResetRef.current === resetKey) return
    scrollResetRef.current = resetKey
    element.scrollLeft = Math.max(0, Math.min(width - element.clientWidth, center(maximumIndex) - element.clientWidth / 2))
    if (barRefs.current.some(bar => bar === document.activeElement)) {
      barRefs.current[maximumIndex]?.focus({ preventScroll: true })
    }
  }, [intervalChart, hasValues, resetKey, width, maximumIndex, slot])

  if (!rows.length) return <p className="rank-distribution-chart-state" role="status">表示する{categoryLabel}区分がありません。</p>
  if (!intervalsMatch) return <p className="rank-distribution-chart-state" role="status">グラフの階級情報と件数が一致しません。</p>
  if (!hasValues) return <p className="rank-distribution-chart-state" role="status">{metric === 'percent'
    ? `${percentLabel}は算出できません。件数表示または表で確認してください。`
    : 'グラフに表示できるアカウント数がありません。'}</p>

  const select = (index: number) => setSelection({ key: interactionKey, id: rows[index].id })
  const focusBar = (index: number) => {
    select(index)
    barRefs.current[index]?.focus({ preventScroll: true })
    const element = scrollRef.current
    if (!element) return
    const start = left + slot * index, end = start + slot
    if (start < element.scrollLeft) element.scrollLeft = start
    else if (end > element.scrollLeft + element.clientWidth) element.scrollLeft = end - element.clientWidth
  }
  const navigate = (event: KeyboardEvent<SVGGElement>, index: number) => {
    let next = index
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, index - 1)
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(rows.length - 1, index + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    focusBar(next)
  }

  return <figure className={`rank-distribution-chart${intervalChart ? ' rank-distribution-chart-intervals' : ''}`} aria-labelledby={titleId}>
    <div ref={viewportRef} className="rank-distribution-chart-viewport">
      <div className={intervalChart ? 'rank-distribution-chart-mr-layout' : undefined}>
        {intervalChart && <>
          <span className="rank-distribution-chart-mr-metric" style={{ left: axisWidth + 4 }}>{metricLabel}</span>
          <svg className="rank-distribution-chart-fixed-axis" width={axisWidth} height={height} viewBox={`0 0 ${axisWidth} ${height}`} aria-hidden="true">
            {ticks.map((tick, index) => <text key={tick} className="rank-distribution-chart-tick" x={axisWidth - 10}
              y={y(tick) + 4} textAnchor="end">{tickTexts[index]}</text>)}
            <path className="rank-distribution-chart-axis" d={`M ${axisWidth - .5} ${TOP} V ${bottom}`} />
          </svg>
        </>}
        <div ref={scrollRef} className="rank-distribution-chart-scroll" role="region" aria-label={`${label}の縦棒グラフ・スクロール領域`}
          style={intervalChart ? { overflowX: overflowing ? 'auto' : 'hidden' } : undefined}
          tabIndex={overflowing ? 0 : undefined}>
          <svg className="rank-distribution-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
            role="group" aria-labelledby={titleId} aria-describedby={descriptionId}
            data-chart-orientation="vertical" data-axis-start="0" data-axis-end={axis.maximum} data-category-label-step={labelStep}
            data-interval-label-style={intervalChart ? intervalLabelStyle : undefined}>
            <title id={titleId}>{label}の{metricLabel}{estimated ? '（概数）' : ''}</title>
            <desc id={descriptionId}>{categoryLabel}を低い順に並べた、0起点の縦棒グラフです。{estimated ? '数値は取得期間中の概数です。' : ''}
              {metric === 'percent' ? denominatorDescription : ''}
              {intervalChart ? '0の上には数値を付けず、正の値は最大値を優先して重ならない範囲で表示します。2500以上は上限を定めない区分です。'
                : showAllValues ? '棒の上に数値を表示します。' : compactCategories
                  ? '数値の重なりを避けるため、棒の上には最大値と一部の0を表示します。'
                  : '数値の重なりを避けるため、棒の上には最大値と0の値を表示します。'}
              {intervalChart && intervalLabelStyle === 'axis' ? '横軸の数値は区間境界のMRです。目盛を間引いても棒は省略しません。'
                : !intervalChart && compactCategories && labelStep > 1 ? '軸の区間名は間引き、すべての棒を同じ幅のまま表示します。' : ''}
              すべての件数と{percentLabel}は、各棒のツールチップと下の表でも確認できます。</desc>
            <g aria-hidden="true">
              {!intervalChart && <text className="rank-distribution-chart-axis-title" x={left} y="17">{metricLabel}</text>}
              {ticks.map((tick, index) => <g key={tick}>
                <line className="rank-distribution-chart-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
                {!intervalChart && <text className="rank-distribution-chart-tick" x={left - 10} y={y(tick) + 4} textAnchor="end">{tickTexts[index]}</text>}
              </g>)}
              <path className="rank-distribution-chart-axis" d={intervalChart ? `M ${left} ${bottom} H ${right}` : `M ${left} ${TOP} V ${bottom} H ${right}`} />
              <text className="rank-distribution-chart-axis-title" x={(left + right) / 2} y={height - 6} textAnchor="middle">{categoryLabel}</text>
              {axisTicks.map(tick => <g key={tick.label}>
                <line className="rank-distribution-chart-axis" x1={tick.x} x2={tick.x} y1={bottom} y2={bottom + 5} />
                <text className="rank-distribution-chart-rank" x={tick.x} y={bottom + 23} textAnchor={tick.anchor}>{tick.label}</text>
              </g>)}
            </g>
            {rows.map((row, index) => {
              const value = values[index]
              const x = center(index)
              const top = value === null ? bottom : y(value)
              const valueText = labels[index]
              const showValue = intervalChart ? intervalValueLabels.has(index)
                : value === null || showAllValues || index === maximumIndex || value === 0 && (!compactCategories || showCategoryLabel(index))
              const description = `${row.label}、アカウント数${estimated ? '（概数）' : ''} ${formatValue(row.count, 'count')}、${percentLabel}${estimated ? '（概数）' : ''} ${formatValue(row.percent, 'percent')}`
              return <g key={row.id} ref={intervalChart ? element => { barRefs.current[index] = element } : undefined}
                className={intervalChart ? 'rank-distribution-chart-interactive' : undefined}
                data-rank-distribution-id={row.id} data-selected={intervalChart && index === selectedIndex ? 'true' : undefined}
                role={intervalChart ? 'button' : 'img'} aria-label={description}
                aria-pressed={intervalChart ? index === selectedIndex : undefined}
                aria-describedby={intervalChart ? instructionId : undefined} tabIndex={intervalChart ? index === selectedIndex ? 0 : -1 : undefined}
                onPointerEnter={intervalChart ? () => select(index) : undefined}
                onFocus={intervalChart ? () => select(index) : undefined}
                onClick={intervalChart ? () => focusBar(index) : undefined}
                onKeyDown={intervalChart ? event => navigate(event, index) : undefined}>
                <title>{description}</title>
                <g aria-hidden="true">
                  {intervalChart && <rect className="rank-distribution-chart-selection" x={left + slot * index + 1} y={TOP}
                    width={Math.max(0, slot - 2)} height={PLOT_HEIGHT} />}
                  <rect className="rank-distribution-chart-hit" x={left + slot * index} y={TOP} width={slot} height={PLOT_HEIGHT} />
                  {value !== null && value > 0 && <rect className="rank-distribution-chart-bar" x={x - barWidth / 2} y={top}
                    width={barWidth} height={bottom - top} />}
                  {value === 0 && <line className="rank-distribution-chart-zero" x1={x - barWidth / 2} x2={x + barWidth / 2} y1={bottom} y2={bottom} />}
                  {showValue && <text className="rank-distribution-chart-value" x={valueLabelX(index)} y={top - 9} textAnchor="middle">{valueText}</text>}
                  {intervalChart ? intervalLines[index]?.length > 0 && <text className="rank-distribution-chart-rank" x={x} y={bottom + 23} textAnchor="middle">
                    {intervalLines[index].map((line, lineIndex) => <tspan key={lineIndex} x={x} dy={lineIndex === 0 ? 0 : 15}>{line}</tspan>)}
                  </text> : showCategoryLabel(index) && <text className="rank-distribution-chart-rank" x={rotateRankLabels ? undefined : x}
                    y={rotateRankLabels ? undefined : bottom + 23} textAnchor={rotateRankLabels ? 'end' : 'middle'}
                    transform={rotateRankLabels ? `translate(${x + 3},${bottom + 17}) rotate(-${LABEL_ANGLE})` : undefined}>{row.label}</text>}
                </g>
              </g>
            })}
          </svg>
        </div>
      </div>
    </div>
    {intervalChart && <>
      <div className="rank-distribution-chart-selection-detail" role="status" aria-live="polite" aria-atomic="true">
        <span><span>階級</span><strong>{selectedRow?.label ?? '—'}</strong></span>
        <span><span>アカウント数{estimated ? '（概数）' : ''}</span><strong>{formatValue(selectedRow?.count ?? null, 'count')}</strong></span>
        <span><span>{percentLabel}{estimated ? '（概数）' : ''}</span><strong>{formatValue(selectedRow?.percent ?? null, 'percent')}</strong></span>
      </div>
      <p id={instructionId} className="rank-distribution-chart-instructions">棒にカーソルを合わせるか、クリックして詳細を確認できます。キーボードでは棒にフォーカスし、左右キーで移動できます。</p>
    </>}
  </figure>
}
