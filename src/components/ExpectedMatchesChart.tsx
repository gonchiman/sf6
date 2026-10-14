import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { expectedMatchResultText, expectedMatchesAxis, expectedMatchValue } from '../lib/expectedMatchesChart'
import type { ExpectedMatchRow } from '../types/expectedMatchData'
import { chartTextWidth as textWidth } from '../lib/chartTextWidth'
import '../expected-matches-chart.css'

type Props = {
  rows: readonly ExpectedMatchRow[]
  scaleRows: readonly ExpectedMatchRow[]
  displayName: (fighter: ExpectedMatchRow['character']['fighter']) => string
  showValues: boolean
}

const PLOT_HEIGHT = 262
const RIGHT = 25
const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })

export function ExpectedMatchesChart({ rows, scaleRows, displayName, showValues }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const axis = useMemo(() => expectedMatchesAxis(scaleRows), [scaleRows])

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => setAvailableWidth(Math.max(1, element.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [rows.length])

  if (rows.length === 0) return <p className="expected-matches-chart-empty" role="status">表示できるキャラがありません。</p>

  const tickTexts = axis.ticks.map(tick => integerFormat.format(tick))
  const left = Math.max(58, ...tickTexts.map(text => textWidth(text) + 16))
  const labels = rows.map(row => ({ name: displayName(row.character.fighter), value: expectedMatchResultText(row, 0) }))
  const topMargin = Math.max(80, ...labels.map(label => textWidth(label.value) + 32))
  const bottom = topMargin + PLOT_HEIGHT
  const height = bottom + Math.max(103, ...labels.map(label => Math.ceil(textWidth(label.name) * Math.sin(Math.PI / 3)) + 40))
  const minimumSlot = availableWidth < 590 ? 34 : 20
  const width = Math.max(availableWidth, left + RIGHT + rows.length * minimumSlot)
  const right = width - RIGHT
  const slot = (right - left) / rows.length
  const barWidth = Math.min(28, slot * .48)
  const y = (value: number) => bottom - (value / axis.maximum) * PLOT_HEIGHT

  return <figure className="expected-matches-chart" aria-labelledby={titleId}>
    <div ref={viewportRef} className="expected-matches-chart-viewport">
      <div className="expected-matches-chart-scroll" role="region" aria-label="期待試合数グラフ・スクロール領域"
        tabIndex={availableWidth < width ? 0 : undefined}>
        <svg className="expected-matches-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="group" aria-labelledby={`${titleId} ${descriptionId}`}>
          <title id={titleId}>全キャラクターのMASTERまでの期待試合数</title>
          <desc id={descriptionId}>簡易モデルによる計算値。棒は0からの試合数を表します。{showValues ? '各棒の上に整数に四捨五入した数値を表示します。' : '数値は各キャラのツールチップと下の表で確認できます。'}数値がない結果には棒を描かず状態を表示します。</desc>
          <g aria-hidden="true">
            <text className="expected-matches-chart-axis-title" x={left} y="17">期待試合数（試合）</text>
            {axis.ticks.map((tick, index) => <g key={tick}>
              <line className="expected-matches-chart-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
              <text className="expected-matches-chart-tick" x={left - 10} y={y(tick) + 4} textAnchor="end">{tickTexts[index]}</text>
            </g>)}
            <path className="expected-matches-chart-axis" d={`M ${left} ${topMargin} V ${bottom} H ${right}`} />
            <text className="expected-matches-chart-axis-title" x={(left + right) / 2} y={height - 8} textAnchor="middle">キャラクター</text>
          </g>
          {rows.map((row, index) => {
            const { characterId } = row.character.fighter
            const { name, value: valueText } = labels[index]
            const value = expectedMatchValue(row)
            const x = left + slot * (index + .5)
            const top = value === null ? bottom : y(value)
            return <g key={characterId} data-expected-character={characterId} role="img"
              aria-label={`${name}、期待試合数 ${valueText}${value === null ? '' : '試合'}`}>
              <title>{`${name}：${valueText}${value === null ? '' : '試合'}`}</title>
              <g aria-hidden="true">
                {value !== null && <rect className="expected-matches-chart-bar" x={x - barWidth / 2} y={top}
                  width={barWidth} height={bottom - top} />}
                {(showValues || value === null) && <text className="expected-matches-chart-value" transform={`translate(${x + 3},${top - 8}) rotate(-90)`}
                  textAnchor="start">{valueText}</text>}
                <text className="expected-matches-chart-name" transform={`translate(${x + 3},${bottom + 17}) rotate(-60)`}
                  textAnchor="end">{name}</text>
              </g>
            </g>
          })}
        </svg>
      </div>
    </div>
  </figure>
}
