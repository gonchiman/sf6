import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { expectedMatchResultText, expectedMatchesAxis, expectedMatchValue } from '../lib/expectedMatchesChart'
import type { ExpectedMatchRow } from '../types/expectedMatchData'
import '../expected-matches-chart.css'

type Props = {
  rows: readonly ExpectedMatchRow[]
  scaleRows: readonly ExpectedMatchRow[]
}

const HEIGHT = 401
const TOP = 36
const BOTTOM = 298
const RIGHT = 25
const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })

function textWidth(text: string): number {
  return Array.from(text).reduce((width, character) => width + (character.charCodeAt(0) < 128 ? 7 : 12), 0)
}

export function ExpectedMatchesChart({ rows, scaleRows }: Props) {
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
  const minimumSlot = availableWidth < 590 ? 34 : 20
  const width = Math.max(availableWidth, left + RIGHT + rows.length * minimumSlot)
  const right = width - RIGHT
  const slot = (right - left) / rows.length
  const barWidth = Math.min(32, slot * .68)
  const showValues = rows.every(row => textWidth(expectedMatchResultText(row)) + 12 <= slot)
  const y = (value: number) => BOTTOM - (value / axis.maximum) * (BOTTOM - TOP)

  return <figure className="expected-matches-chart" aria-labelledby={titleId}>
    <div ref={viewportRef} className="expected-matches-chart-viewport">
      <div className="expected-matches-chart-scroll" role="region" aria-label="期待試合数グラフ・スクロール領域"
        tabIndex={availableWidth < width ? 0 : undefined}>
        <svg className="expected-matches-chart-svg" width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}
          role="group" aria-labelledby={`${titleId} ${descriptionId}`}>
          <title id={titleId}>全キャラクターのMASTERまでの期待試合数</title>
          <desc id={descriptionId}>簡易モデルによる計算値。棒は0からの試合数を表し、数値がない結果には棒を描きません。数値は各キャラのツールチップと下の表で確認できます。</desc>
          <g aria-hidden="true">
            <text className="expected-matches-chart-axis-title" x={left} y="17">期待試合数（試合）</text>
            {axis.ticks.map((tick, index) => <g key={tick}>
              <line className="expected-matches-chart-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
              <text className="expected-matches-chart-tick" x={left - 10} y={y(tick) + 4} textAnchor="end">{tickTexts[index]}</text>
            </g>)}
            <path className="expected-matches-chart-axis" d={`M ${left} ${TOP} V ${BOTTOM} H ${right}`} />
            <text className="expected-matches-chart-axis-title" x={(left + right) / 2} y={HEIGHT - 8} textAnchor="middle">キャラクター</text>
          </g>
          {rows.map((row, index) => {
            const { characterId, name } = row.character.fighter
            const value = expectedMatchValue(row)
            const valueText = expectedMatchResultText(row)
            const x = left + slot * (index + .5)
            const top = value === null ? BOTTOM : y(value)
            return <g key={characterId} data-expected-character={characterId} role="img"
              aria-label={`${name}、期待試合数 ${valueText}${value === null ? '' : '試合'}`}>
              <title>{`${name}：${valueText}${value === null ? '' : '試合'}`}</title>
              <g aria-hidden="true">
                {value !== null && <rect className="expected-matches-chart-bar" x={x - barWidth / 2} y={top}
                  width={barWidth} height={BOTTOM - top} />}
                {(showValues || value === null) && <text className="expected-matches-chart-value"
                  x={showValues ? x : undefined} y={showValues ? top - 10 : undefined}
                  transform={showValues ? undefined : `translate(${x},${BOTTOM - 10}) rotate(-60)`}
                  textAnchor={showValues ? 'middle' : 'start'}>{valueText}</text>}
                <text className="expected-matches-chart-name" transform={`translate(${x + 3},${BOTTOM + 17}) rotate(-60)`}
                  textAnchor="end">{name}</text>
              </g>
            </g>
          })}
        </svg>
      </div>
    </div>
  </figure>
}
