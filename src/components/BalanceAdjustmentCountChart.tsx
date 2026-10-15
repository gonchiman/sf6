import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { balanceAdjustmentCountAxis, balanceAdjustmentCountStateLabel, type BalanceAdjustmentCountRow } from '../lib/balanceAdjustmentCountChart'
import { chartTextWidth as textWidth } from '../lib/chartTextWidth'
import { balanceAdjustmentDateLabel } from './BalanceAdjustmentTable'
import '../balance-adjustment-count-chart.css'

type Props = {
  rows: readonly BalanceAdjustmentCountRow[]
  showValues: boolean
  subjectLabel: string
  categoryLabel: string
}

const PLOT_HEIGHT = 262
const RIGHT = 25
const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })

export function BalanceAdjustmentCountChart({ rows, showValues, subjectLabel, categoryLabel }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const axis = useMemo(() => balanceAdjustmentCountAxis(rows), [rows])

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
  }, [rows.length])

  if (rows.length === 0) return <p className="balance-adjustment-count-chart-empty" role="status">表示できる変更がありません。</p>

  const tickTexts = axis.ticks.map(tick => integerFormat.format(tick))
  const left = Math.max(58, ...tickTexts.map(text => textWidth(text) + 16))
  const labels = rows.map(row => ({
    date: balanceAdjustmentDateLabel(row.event),
    value: row.itemCount === null ? balanceAdjustmentCountStateLabel(row.status) : integerFormat.format(row.itemCount),
  }))
  const topMargin = 48
  const bottom = topMargin + PLOT_HEIGHT
  const height = bottom + Math.max(103, ...labels.map(label => Math.ceil(textWidth(label.date) * Math.sin(Math.PI / 3)) + 40))
  const minimumSlot = Math.max(availableWidth < 590 ? 40 : 32, ...labels.map((label, index) => rows[index].itemCount === null ? 32 : textWidth(label.value) + 12))
  const width = Math.max(availableWidth, left + RIGHT + rows.length * minimumSlot)
  const right = width - RIGHT
  const slot = (right - left) / rows.length
  const barWidth = Math.min(28, slot * .48)
  const y = (value: number) => bottom - (value / axis.maximum) * PLOT_HEIGHT

  return <figure className="balance-adjustment-count-chart" aria-labelledby={titleId}>
    <div ref={viewportRef} className="balance-adjustment-count-chart-viewport">
      <div className="balance-adjustment-count-chart-scroll" role="region" aria-label={`${subjectLabel}のバトル変更項目数グラフ・スクロール領域`}
        tabIndex={availableWidth < width ? 0 : undefined}>
        <svg className="balance-adjustment-count-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="group" aria-labelledby={`${titleId} ${descriptionId}`}>
          <title id={titleId}>{subjectLabel}のバトル変更ごとの項目数（分類：{categoryLabel}）</title>
          <desc id={descriptionId}>棒は選択した分類の0からの項目数を表します。{showValues ? '各棒の上に整数の項目数を表示します。' : '項目数は各変更日のツールチップでも確認できます。'}未取込・未掲載・分類記載なしには棒を描かず状態を表示します。</desc>
          <g aria-hidden="true">
            <text className="balance-adjustment-count-chart-axis-title" x={left} y="17">項目数（項目）</text>
            {axis.ticks.map((tick, index) => <g key={tick}>
              <line className="balance-adjustment-count-chart-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
              <text className="balance-adjustment-count-chart-tick" x={left - 10} y={y(tick) + 4} textAnchor="end">{tickTexts[index]}</text>
            </g>)}
            <path className="balance-adjustment-count-chart-axis" d={`M ${left} ${topMargin} V ${bottom} H ${right}`} />
            <text className="balance-adjustment-count-chart-axis-title" x={(left + right) / 2} y={height - 8} textAnchor="middle">変更日</text>
          </g>
          {rows.map((row, index) => {
            const { date, value: valueText } = labels[index]
            const value = row.itemCount
            const x = left + slot * (index + .5)
            const top = value === null ? bottom : y(value)
            const text = `${date}、${subjectLabel}、分類：${categoryLabel}、${valueText}${value === null ? '' : '項目'}`
            return <g key={row.event.id} data-adjustment-id={row.event.id} role="img" aria-label={text}>
              <title>{text}</title>
              <g aria-hidden="true">
                {value !== null && <rect className="balance-adjustment-count-chart-bar" x={x - barWidth / 2} y={top}
                  width={barWidth} height={bottom - top} />}
                {(showValues || value === null) && <text className="balance-adjustment-count-chart-value"
                  x={value === null ? x + 4 : x} y={top - 8} textAnchor={value === null ? 'start' : 'middle'}
                  transform={value === null ? `rotate(-90 ${x + 4} ${top - 8})` : undefined}>{valueText}</text>}
                <text className="balance-adjustment-count-chart-date" transform={`translate(${x + 3},${bottom + 17}) rotate(-60)`}
                  textAnchor="end">{date}</text>
              </g>
            </g>
          })}
        </svg>
      </div>
    </div>
  </figure>
}
