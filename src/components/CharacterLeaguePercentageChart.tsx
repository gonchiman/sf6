import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { controlTypeBarStyle } from '../lib/controlTypeBarStyles'
import { leaguePercentageChartTicks, leaguePercentageChartValue } from '../lib/leaguePercentageChart'
import { leagueLabel } from '../lib/winRateConditions'
import { chartTextWidth as textWidth } from '../lib/chartTextWidth'
import type { LeaguePercentageChartComparison } from '../types/leaguePercentageChart'
import type { MonthlyLineChartAxis } from '../types/monthlyLineChart'
import '../character-league-win-rate-chart.css'

type Props = {
  comparison: LeaguePercentageChartComparison
  showValues: boolean
  axis: MonthlyLineChartAxis
  metricLabel: string
  sourceDescription: string
  valuePrecision: number
  referenceValue?: number
  leagueName?: (league: string) => string
}

function RankLabel({ label, x, y, anchor = 'middle' }: {
  label: string; x: number; y: number; anchor?: 'middle' | 'end'
}) {
  const lines = label.split(' ')
  return <text className="character-league-chart-rank" x={x} y={y} textAnchor={anchor}>
    {lines.map((line, index) => <tspan key={index} x={x} dy={index === 0 ? 0 : 14}>{line}</tspan>)}
  </text>
}

export function CharacterLeaguePercentageChart({ comparison, showValues, axis, metricLabel, sourceDescription, valuePrecision, referenceValue, leagueName = leagueLabel }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const patternId = `character-league-modern-${useId().replace(/:/g, '')}`
  const viewportRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(720)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => setAvailableWidth(Math.max(1, viewport.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [comparison.leagues.length, comparison.series.length])

  if (!comparison.leagues.length || !comparison.series.length) {
    return <p className="character-league-chart-empty" role="status">表示できるランク別{metricLabel}がありません。</p>
  }

  const horizontal = availableWidth < 620
  const width = Math.max(260, availableWidth)
  const grouped = comparison.series.length > 1
  const modernStyle = controlTypeBarStyle('modern')
  const displays = comparison.series.map(series => comparison.leagues.map((_, index) => {
    const point = series.points[index]
    const projected = leaguePercentageChartValue(point?.value, axis)
    const label = point?.label ?? '未登録'
    const direction = projected.outside === 'below' ? horizontal ? '←' : '↓'
      : projected.outside === 'above' ? horizontal ? '→' : '↑' : ''
    const displayedLabel = projected.value === null || showValues || projected.outside
      ? `${direction}${label}${point?.lowSample ? ' i' : ''}` : point?.lowSample ? 'i' : ''
    return { ...projected, label, displayedLabel }
  }))
  const states = displays.flat().map(point => point.displayedLabel)
  const hasOutside = displays.some(series => series.some(point => point.outside !== null))
  const rightInset = horizontal ? Math.max(20, ...states.map(text => textWidth(text) + 12)) : 18
  const left = horizontal ? grouped ? 114 : 98 : 48
  const right = width - rightInset
  const top = horizontal ? 32 : grouped && (showValues || hasOutside) ? 94 : 40
  const rowHeight = 26
  const groupHeight = comparison.series.length * rowHeight + 22
  const bottom = horizontal ? top + comparison.leagues.length * groupHeight - 12 : top + 262
  const height = bottom + (horizontal ? 40 : grouped ? 80 : 62)
  const slot = (right - left) / comparison.leagues.length
  const barSlot = slot * .7 / comparison.series.length
  const barWidth = Math.min(32, Math.max(8, barSlot - 4))
  const y = (value: number) => bottom - (value - axis.start) / (axis.end - axis.start) * (bottom - top)
  const valueX = (value: number) => left + (value - axis.start) / (axis.end - axis.start) * (right - left)
  const ticks = leaguePercentageChartTicks(axis, horizontal && right - left < 180, referenceValue)

  return <figure className="character-league-chart" aria-labelledby={titleId}>
    {axis.start > 0 && <figcaption className="character-league-chart-range" aria-live="polite">拡大表示 · {axis.start}〜{axis.end}%</figcaption>}
    {grouped && <ul className="character-league-chart-legend" aria-label="操作タイプ">
      {comparison.series.map(series => {
        const style = controlTypeBarStyle(series.controlType)
        const swatchStyle: CSSProperties = {
          backgroundColor: style.fill, borderColor: style.ink,
          backgroundImage: style.hatch ? `repeating-linear-gradient(135deg, ${style.ink} 0, ${style.ink} 1px, ${style.fill} 1px, ${style.fill} 6px)` : undefined,
        }
        return <li key={series.controlType}><span className="character-league-chart-swatch" style={swatchStyle} aria-hidden="true" />{style.label}</li>
      })}
    </ul>}
    <div ref={viewportRef} className="character-league-chart-viewport">
      <div className="character-league-chart-scroll" role="region" aria-label={`ランク別${metricLabel}グラフ・スクロール領域`}
        tabIndex={availableWidth < width ? 0 : undefined}>
        <svg className="character-league-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="group" aria-labelledby={titleId} aria-describedby={descriptionId} data-chart-orientation={horizontal ? 'horizontal' : 'vertical'}
          data-axis-start={axis.start} data-axis-end={axis.end}>
          <title id={titleId}>{`${comparison.characterName}のランク別${metricLabel}`}</title>
          <desc id={descriptionId}>{sourceDescription}表示範囲は{axis.start}%から{axis.end}%、棒の基点は{axis.start}%です。{referenceValue !== undefined ? `破線は${referenceValue}%です。` : null}
            {axis.start > 0 ? '下限未満の部分を省略した拡大表示です。' : ''}範囲外の値は端のマークと矢印付きの実際の値で表示します。
            {grouped ? '各ランクにクラシックとモダンの棒を並べ、モダンには斜線を付けています。' : ''}
            {showValues ? `数値は小数点以下${valuePrecision}桁で表示します。` : '数値は各棒のツールチップと比較表で確認できます。'}
            欠損には棒を描かず状態を表示します。</desc>
          <defs><pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill={modernStyle.fill} />
            <path d="M -1 1 L 1 -1 M 0 6 L 6 0 M 5 7 L 7 5" stroke={modernStyle.ink} strokeWidth="1" />
          </pattern></defs>
          <g aria-hidden="true">
            <text className="character-league-chart-axis-title" x={left} y="16">{metricLabel}（%）</text>
            {ticks.map(tick => <g key={tick}>
              <line className={tick === referenceValue ? 'character-league-chart-reference' : 'character-league-chart-grid'}
                data-reference-value={tick === referenceValue ? referenceValue : undefined}
                x1={horizontal ? valueX(tick) : left} x2={horizontal ? valueX(tick) : right}
                y1={horizontal ? top : y(tick)} y2={horizontal ? bottom : y(tick)} />
              <text className="character-league-chart-tick" x={horizontal ? valueX(tick) : left - 8}
                y={horizontal ? bottom + 20 : y(tick) + 4}
                textAnchor={horizontal ? tick === axis.start ? 'start' : tick === axis.end ? 'end' : 'middle' : 'end'}>{tick}%</text>
            </g>)}
            <path className="character-league-chart-axis" d={`M ${left} ${top} V ${bottom} H ${right}`} />
            {axis.start > 0 && <path className="character-league-chart-axis-break"
              d={horizontal ? `M ${left + 3} ${bottom - 4} l 3 8 3 -8 3 8` : `M ${left - 4} ${bottom - 4} l 8 -3 -8 -3 8 -3`} />}
          </g>
          {comparison.leagues.map((league, leagueIndex) => {
            const center = left + slot * (leagueIndex + .5)
            const groupTop = top + leagueIndex * groupHeight
            const labelLines = leagueName(league).split(' ').length
            return <g key={league} data-character-league={league}>
              <g aria-hidden="true"><RankLabel label={leagueName(league)}
                x={horizontal ? left - (grouped ? 32 : 12) : center}
                y={horizontal ? groupTop + comparison.series.length * rowHeight / 2 + 4 - (labelLines - 1) * 7 : bottom + (grouped ? 38 : 22)}
                anchor={horizontal ? 'end' : 'middle'} /></g>
              {comparison.series.map((series, seriesIndex) => {
                const point = series.points[leagueIndex]
                const { value, displayValue, outside, label, displayedLabel } = displays[seriesIndex][leagueIndex]
                const style = controlTypeBarStyle(series.controlType)
                const barCenter = center + (seriesIndex - (comparison.series.length - 1) / 2) * barSlot
                const rowCenter = groupTop + (seriesIndex + .5) * rowHeight
                const valueTop = displayValue === null ? bottom : y(displayValue)
                const barEnd = displayValue === null ? left : valueX(displayValue)
                const labelX = horizontal ? barEnd + (outside === 'below' ? 12 : 6) : barCenter
                const labelY = horizontal ? rowCenter + 4 : valueTop - (outside === 'below' ? 12 : 8)
                const rotateLabel = !horizontal && grouped && (showValues || value === null || outside !== null)
                const outsideText = outside ? `、表示範囲${axis.start}〜${axis.end}%より${outside === 'above' ? '上' : '下'}` : ''
                const markerPath = horizontal
                  ? `M ${barEnd} ${rowCenter} l ${outside === 'below' ? 7 : -7} -5 v 10 Z`
                  : `M ${barCenter} ${valueTop} l -5 ${outside === 'below' ? -7 : 7} h 10 Z`
                return <g key={series.controlType} role="img" data-control-type={series.controlType}
                  data-percent-hundredths={value === null ? undefined : point?.percentHundredths}
                  data-percent-thousandths={value === null ? undefined : point?.percentThousandths}
                  data-range-status={outside ?? undefined}
                  aria-label={`${comparison.characterName}、${leagueName(league)}、${style.label}、${label}${outsideText}${point?.lowSample ? '、公式の少数試合表示' : ''}`}>
                  <title>{`${leagueName(league)} ${style.label}：${label}${outsideText}${point?.lowSample ? '（公式の少数試合表示）' : ''}`}</title>
                  <g aria-hidden="true">
                    {value !== null && outside !== 'below' && <rect className="character-league-chart-bar"
                      fill={style.hatch ? `url(#${patternId})` : style.fill} stroke={style.ink} strokeWidth={style.hatch ? 1 : 0}
                      x={horizontal ? left : barCenter - barWidth / 2} y={horizontal ? rowCenter - 8 : valueTop}
                      width={horizontal ? barEnd - left : barWidth} height={horizontal ? 16 : bottom - valueTop} />}
                    {value === axis.start && <line className="character-league-chart-zero" stroke={style.ink}
                      x1={horizontal ? left : barCenter - barWidth / 2} x2={horizontal ? left : barCenter + barWidth / 2}
                      y1={horizontal ? rowCenter - 8 : bottom} y2={horizontal ? rowCenter + 8 : bottom} />}
                    {outside && <path className="character-league-chart-outside" d={markerPath} />}
                    {displayedLabel && <text className="character-league-chart-value" textAnchor={horizontal || rotateLabel ? 'start' : 'middle'}
                      x={rotateLabel ? undefined : labelX} y={rotateLabel ? undefined : labelY}
                      transform={rotateLabel ? `translate(${labelX + 3},${labelY}) rotate(-60)` : undefined}>{displayedLabel}</text>}
                    {grouped && <text className="character-league-chart-control"
                      x={horizontal ? left - 12 : barCenter} y={horizontal ? rowCenter + 4 : bottom + 16}
                      textAnchor={horizontal ? 'end' : 'middle'}>{style.shortLabel}</text>}
                  </g>
                </g>
              })}
            </g>
          })}
        </svg>
      </div>
    </div>
  </figure>
}
