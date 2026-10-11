import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { expectedMatchLpBands, expectedMatchLpRankStyle } from '../lib/expectedMatchLpRange'
import type { ExpectedMatchesConfig } from '../types/expectedMatches'

const format = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const TOP = 18
const BOTTOM = 36

/** A read-only LP scale using exactly the same rank intervals as the adjacent table. */
export function ExpectedMatchLpRangeChart({ config, label }: { config: ExpectedMatchesConfig; label: string }) {
  const titleId = useId()
  const descriptionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const [labelWidths, setLabelWidths] = useState<number[]>([])
  const bands = useMemo(() => expectedMatchLpBands(config.ranks, config.targetLp), [config.ranks, config.targetLp])
  const master = expectedMatchLpRankStyle('MASTER')
  const boundaries = [...bands.map(band => band.minimumLp), config.targetLp]
  const labelTexts = boundaries.map(lp => format.format(lp))
  const labelKey = labelTexts.join('|')
  const legend = [...new Map(bands.map(band => [band.style.league, band.style])).values(), master]

  function measureLabels() {
    if (!viewportRef.current?.clientWidth || !svgRef.current) return
    const measured = Array.from(svgRef.current.querySelectorAll<SVGTextElement>('[data-lp-boundary]'))
      .map(text => text.getBBox().width)
    setLabelWidths(previous => previous.length === measured.length
      && previous.every((width, index) => Math.abs(width - measured[index]) < .01) ? previous : measured)
  }

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => {
      // The reference tabs and calculated-settings disclosure can be hidden.
      if (element.clientWidth > 0) {
        setAvailableWidth(element.clientWidth)
        // Reopening at the same width still needs a visible SVG text measurement.
        measureLabels()
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    measureLabels()
  }, [availableWidth, labelKey])

  const left = 8
  const right = availableWidth - 8
  const x = (lp: number) => left + (right - left) * lp / config.targetLp
  const occupied: [number, number][][] = []
  const labels = boundaries.map((lp, index) => {
    const textWidth = labelWidths[index] ?? labelTexts[index].length * 7
    const labelX = Math.max(left + textWidth / 2, Math.min(right - textWidth / 2, x(lp)))
    const a = labelX - textWidth / 2
    const b = labelX + textWidth / 2
    let row = 0
    while ((occupied[row] ?? []).some(interval => a < interval[1] + 6 && b > interval[0] - 6)) row++
    const intervals = occupied[row] ??= []
    intervals.push([a, b])
    return { lp, text: labelTexts[index], x: labelX, y: BOTTOM + 24 + row * 22, row }
  })
  const height = BOTTOM + 24 + Math.max(0, ...labels.map(item => item.row)) * 22 + 8

  return <figure className="expected-matches-lp-band">
    <figcaption><h3>ランク別LP範囲</h3><span>MASTER：{format.format(config.targetLp)} LP</span></figcaption>
    <div ref={viewportRef} className="expected-matches-lp-band-viewport">
      <svg ref={svgRef} className="expected-matches-lp-band-svg" width={availableWidth} height={height}
        viewBox={`0 0 ${availableWidth} ${height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <title id={titleId}>{label}のランク別LP範囲と境界LP</title>
        <desc id={descriptionId}>{bands.map(band => `${band.style.number} ${band.style.name} ${format.format(band.minimumLp)}〜${format.format(band.endLp - 1)} LP`).join('、')}。
          M マスター {format.format(config.targetLp)} LPで到達。帯の幅はLP範囲に比例します。</desc>
        <g aria-hidden="true">
          {bands.map(band => <rect key={band.id} data-lp-rank={band.id} x={x(band.minimumLp)} y={TOP}
            width={x(band.endLp) - x(band.minimumLp)} height={BOTTOM - TOP} fill={band.style.color} />)}
          {bands.slice(1).map(band => <line key={band.id} className="expected-matches-lp-band-divider"
            x1={x(band.minimumLp)} x2={x(band.minimumLp)} y1={TOP} y2={BOTTOM} />)}
          {bands.map(band => <text key={band.id} className="expected-matches-lp-band-number"
            x={x((band.minimumLp + band.endLp) / 2)} y={(TOP + BOTTOM) / 2} dominantBaseline="central" textAnchor="middle">
            {band.style.number}</text>)}
          <line data-lp-master="true" x1={right} x2={right} y1={TOP - 3} y2={BOTTOM + 3} stroke={master.color} strokeWidth={2} />
          <text x={right - 4} y={9} dominantBaseline="central" textAnchor="end">M</text>
          <text className="axis-title" data-axis="x" x={left} y={9} dominantBaseline="central">LP</text>
          {labels.map(item => <g key={item.lp}>
            <text data-lp-boundary={item.lp} className="expected-matches-lp-band-value" x={item.x} y={item.y} textAnchor="middle">{item.text}</text>
            <path className="expected-matches-lp-band-leader" d={`M ${x(item.lp)} ${BOTTOM + 4} V ${item.y - 17} L ${item.x} ${item.y - 9}`} />
          </g>)}
        </g>
      </svg>
    </div>
    <ul className="expected-matches-lp-band-legend" aria-label="帯の番号とランク">
      {legend.map(style => <li key={style.league}>
        <span className="expected-matches-lp-band-legend-number">{style.number}</span>
        {style.league === 'MASTER'
          ? <svg className="expected-matches-lp-band-master-key" width={12} height={10} viewBox="0 0 12 10" aria-hidden="true"><line x1={6} x2={6} y1={0} y2={10} stroke={style.color} strokeWidth={2} /></svg>
          : <span className="expected-matches-lp-band-key" style={{ backgroundColor: style.color }} aria-hidden="true" />}
        <span>{style.name}</span>
      </li>)}
    </ul>
  </figure>
}
