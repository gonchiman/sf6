import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { chartTextWidth } from '../lib/chartTextWidth'
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

export function RankDistributionChart({ rows, metric, estimated = false }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(MINIMUM_WIDTH)
  const axis = useMemo(() => rankDistributionChartAxis(rows, metric), [rows, metric])
  const values = useMemo(() => rows.map(row => rankDistributionChartValue(row, metric)), [rows, metric])
  const hasValues = values.some(value => value !== null)

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => {
      const width = element.clientWidth
      if (width > 0) setAvailableWidth(width)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [rows.length, metric, hasValues])

  if (rows.length === 0) {
    return <p className="rank-distribution-chart-state" role="status">表示するランク区分がありません。</p>
  }
  if (!hasValues) {
    return <p className="rank-distribution-chart-state" role="status">{metric === 'percent'
      ? '全体比は算出できません。件数表示または表で確認してください。'
      : 'グラフに表示できるアカウント数がありません。'}</p>
  }

  const metricLabel = metric === 'percent' ? '全体比（%）' : 'アカウント数（件）'
  const ticks = availableWidth < 420 && axis.ticks.length > 4
    ? axis.ticks.filter((_, index) => index % 2 === 0 || index === axis.ticks.length - 1)
    : axis.ticks
  const tickTexts = ticks.map(tick => tickLabel(tick, metric))
  const left = Math.max(64, ...tickTexts.map(text => chartTextWidth(text) + 14))
  // Preserve an overview of all ranks; value labels never widen the plot.
  const width = Math.max(MINIMUM_WIDTH, availableWidth)
  const right = width - RIGHT
  const slot = (right - left) / rows.length
  const barWidth = Math.min(36, Math.max(8, slot * .52))
  const bottom = TOP + PLOT_HEIGHT
  const longestRankLabel = Math.max(...rows.map(row => chartTextWidth(row.label)))
  const rotateRankLabels = longestRankLabel + 12 > slot
  const height = bottom + (rotateRankLabels
    ? Math.ceil(longestRankLabel * Math.sin(LABEL_ANGLE * Math.PI / 180)) + 40
    : 58)
  const labels = values.map(value => value === 0 ? metric === 'percent' ? '0%' : '0' : rankDistributionChartValueLabel(value, metric))
  const showAllValues = labels.every(label => chartTextWidth(label) + 12 <= slot)
  const maximum = Math.max(...values.flatMap(value => value === null ? [] : [value]))
  const maximumIndex = values.findIndex(value => value === maximum)
  const y = (value: number) => bottom - value / axis.maximum * PLOT_HEIGHT

  return <figure className="rank-distribution-chart" aria-labelledby={titleId}>
    <div ref={viewportRef} className="rank-distribution-chart-viewport">
      <div className="rank-distribution-chart-scroll" role="region" aria-label="ランク分布の縦棒グラフ・スクロール領域"
        tabIndex={availableWidth < width ? 0 : undefined}>
        <svg className="rank-distribution-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="group" aria-labelledby={titleId} aria-describedby={descriptionId}
          data-chart-orientation="vertical" data-axis-start="0" data-axis-end={axis.maximum}>
          <title id={titleId}>ランク分布の{metricLabel}{estimated ? '（概数）' : ''}</title>
          <desc id={descriptionId}>ランクを低い順に並べた、0起点の縦棒グラフです。{estimated ? '数値は取得期間中の概数です。' : ''}
            {metric === 'percent' ? '割合の分母は、★別表示でも掲載アカウント全体です。' : ''}
            {showAllValues ? '棒の上に数値を表示します。' : '数値の重なりを避けるため、棒の上には最大値と0の値を表示します。'}
            すべての件数と全体比は、各棒のツールチップと下の表でも確認できます。</desc>
          <g aria-hidden="true">
            <text className="rank-distribution-chart-axis-title" x={left} y="17">{metricLabel}</text>
            {ticks.map((tick, index) => <g key={tick}>
              <line className="rank-distribution-chart-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
              <text className="rank-distribution-chart-tick" x={left - 10} y={y(tick) + 4} textAnchor="end">{tickTexts[index]}</text>
            </g>)}
            <path className="rank-distribution-chart-axis" d={`M ${left} ${TOP} V ${bottom} H ${right}`} />
            <text className="rank-distribution-chart-axis-title" x={(left + right) / 2} y={height - 6} textAnchor="middle">ランク</text>
          </g>
          {rows.map((row, index) => {
            const value = values[index]
            const x = left + slot * (index + .5)
            const top = value === null ? bottom : y(value)
            const label = labels[index]
            const labelX = Math.max(chartTextWidth(label) / 2 + 4, Math.min(width - chartTextWidth(label) / 2 - 4, x))
            const showValue = value === null || showAllValues || index === maximumIndex || value === 0
            const description = `${row.label}、アカウント数${estimated ? '（概数）' : ''} ${rankDistributionChartValueLabel(row.count, 'count')}、全体比${estimated ? '（概数）' : ''} ${rankDistributionChartValueLabel(row.percent, 'percent')}`
            return <g key={row.id} data-rank-distribution-id={row.id} role="img" aria-label={description}>
              <title>{description}</title>
              <g aria-hidden="true">
                <rect className="rank-distribution-chart-hit" x={left + slot * index} y={TOP} width={slot} height={PLOT_HEIGHT} />
                {value !== null && value > 0 && <rect className="rank-distribution-chart-bar" x={x - barWidth / 2} y={top}
                  width={barWidth} height={bottom - top} />}
                {value === 0 && <line className="rank-distribution-chart-zero" x1={x - barWidth / 2} x2={x + barWidth / 2}
                  y1={bottom} y2={bottom} />}
                {showValue && <text className="rank-distribution-chart-value" x={labelX} y={top - 9} textAnchor="middle">{label}</text>}
                <text className="rank-distribution-chart-rank" x={rotateRankLabels ? undefined : x}
                  y={rotateRankLabels ? undefined : bottom + 23} textAnchor={rotateRankLabels ? 'end' : 'middle'}
                  transform={rotateRankLabels ? `translate(${x + 3},${bottom + 17}) rotate(-${LABEL_ANGLE})` : undefined}>{row.label}</text>
              </g>
            </g>
          })}
        </svg>
      </div>
    </div>
  </figure>
}
