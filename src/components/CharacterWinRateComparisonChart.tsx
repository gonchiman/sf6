import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { characterLeagueChartAxis, characterLeagueChartValue, type CharacterLeagueChartRange } from '../lib/characterLeagueChartAxis'
import { chartTextWidth as textWidth } from '../lib/chartTextWidth'
import { controlTypeBarStyle } from '../lib/controlTypeBarStyles'
import { formatHistoryValue } from '../lib/winRateHistory'
import { leagueLabel } from '../lib/winRateConditions'
import type { CharacterWinRateComparison } from '../types/characterWinRateComparison'
import '../character-league-win-rate-chart.css'
import '../character-win-rate-comparison-chart.css'

type Props = { comparison: CharacterWinRateComparison; range: CharacterLeagueChartRange; showValues: boolean }

export function CharacterWinRateComparisonChart({ comparison, range, showValues }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const patternId = `character-comparison-modern-${useId().replace(/:/g, '')}`
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
  }, [comparison.rows.length])

  if (!comparison.rows.length) return <p className="character-league-chart-empty" role="status">表示できるキャラ別勝率がありません。</p>

  const axis = characterLeagueChartAxis(range)
  const grouped = comparison.operationMode === 'separate'
  const seriesCount = grouped ? 2 : 1
  const horizontal = availableWidth < 620 || (availableWidth - 73) / comparison.rows.length < (grouped ? 48 : 24)
  const stackedNames = horizontal && availableWidth < 400
  const displays = comparison.rows.map(row => row.series.map(series => {
    const projected = characterLeagueChartValue(series.point, axis)
    const label = formatHistoryValue(series.point)
    const direction = projected.outside === 'below' ? horizontal ? '←' : '↓'
      : projected.outside === 'above' ? horizontal ? '→' : '↑' : ''
    const displayedLabel = projected.value === null || showValues || projected.outside
      ? `${direction}${label}${series.point.total?.lowSample ? ' i' : ''}` : series.point.total?.lowSample ? 'i' : ''
    return { ...projected, label, displayedLabel }
  }))
  const labels = displays.flat().map(point => point.displayedLabel)
  const width = Math.max(220, availableWidth)
  const longestName = Math.max(...comparison.rows.map(row => textWidth(row.name)))
  const left = horizontal ? stackedNames ? grouped ? 20 : 8 : Math.max(grouped ? 118 : 98, longestName + (grouped ? 40 : 16)) : 48
  const rightInset = horizontal ? Math.max(28, ...labels.map(label => textWidth(label) + 12)) : 25
  const right = width - rightInset
  const top = horizontal ? 56 : Math.max(48, ...labels.map(label => textWidth(label) + 32))
  const rowHeight = stackedNames ? 20 : 24
  const groupHeight = (stackedNames ? 20 : 0) + seriesCount * rowHeight + 8
  const bottom = horizontal ? top + comparison.rows.length * groupHeight : top + 262
  const height = bottom + (horizontal ? 46 : Math.max(103, Math.ceil(longestName * Math.sin(Math.PI / 3)) + 54))
  const slot = (right - left) / comparison.rows.length
  const clusterWidth = slot * .8
  const barSlot = clusterWidth / seriesCount
  const gap = Math.min(3, clusterWidth / (2 * seriesCount))
  const barWidth = Math.min(28, barSlot - gap)
  const y = (value: number) => bottom - (value - axis.start) / (axis.end - axis.start) * (bottom - top)
  const valueX = (value: number) => left + (value - axis.start) / (axis.end - axis.start) * (right - left)
  const ticks = horizontal && right - left < 120 ? [axis.start, axis.end]
    : horizontal && right - left < 240 ? [axis.start, 50, axis.end] : axis.ticks
  const controls = comparison.rows[0].series.map(series => series.controlType)
  const modernStyle = controlTypeBarStyle('modern')

  return <figure className="character-league-chart character-comparison-chart" aria-labelledby={titleId}>
    {axis.start > 0 && <figcaption className="character-league-chart-range" aria-live="polite">拡大表示 · {axis.start}〜{axis.end}%</figcaption>}
    {(grouped || !ticks.includes(50)) && <ul className="character-league-chart-legend" aria-label="キャラ比較グラフの凡例">
      {grouped && controls.map(control => {
        const style = controlTypeBarStyle(control)
        const swatchStyle: CSSProperties = {
          backgroundColor: style.fill, borderColor: style.ink,
          backgroundImage: style.hatch ? `repeating-linear-gradient(135deg, ${style.ink} 0, ${style.ink} 1px, ${style.fill} 1px, ${style.fill} 6px)` : undefined,
        }
        return <li key={control}><span className="character-league-chart-swatch" style={swatchStyle} aria-hidden="true" />{style.label}</li>
      })}
      {!ticks.includes(50) && <li><span className="character-comparison-reference-key" aria-hidden="true" />50%基準</li>}
    </ul>}
    <div ref={viewportRef} className="character-league-chart-viewport">
      <div className="character-league-chart-scroll" role="region" aria-label="全キャラの勝率グラフ・スクロール領域"
        tabIndex={availableWidth < width ? 0 : undefined}>
        <svg className="character-league-chart-svg character-comparison-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="group" aria-labelledby={titleId} aria-describedby={descriptionId} data-chart-orientation={horizontal ? 'horizontal' : 'vertical'}
          data-league={comparison.league} data-axis-start={axis.start} data-axis-end={axis.end}>
          <title id={titleId}>{leagueLabel(comparison.league)}のキャラ別勝率</title>
          <desc id={descriptionId}>選択した月とランクの公式Totalを百分率に換算して全キャラを比較します。
            表示範囲は{axis.start}%から{axis.end}%、棒の基点は{axis.start}%です。破線は50%です。
            {axis.start > 0 && '下限未満の部分を省略した拡大表示です。範囲外は端のマークと矢印付きの実際の勝率で表示します。'}
            {grouped && '各キャラにクラシックとモダンを並べ、モダンには斜線を付けます。勝率順はクラシックの値で並べています。'}
            数値は小数点以下2桁です。欠損には棒を描かず状態を表示します。iは公式の少数試合表示です。</desc>
          <defs><pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill={modernStyle.fill} />
            <path d="M -1 1 L 1 -1 M 0 6 L 6 0 M 5 7 L 7 5" stroke={modernStyle.ink} strokeWidth="1" />
          </pattern></defs>
          <g aria-hidden="true">
            <text className="character-league-chart-axis-title" x={left} y="16">勝率（%）</text>
            {ticks.map(tick => <g key={tick}>
              <line className={tick === 50 ? 'character-league-chart-reference' : 'character-league-chart-grid'}
                data-reference-value={tick === 50 ? 50 : undefined}
                x1={horizontal ? valueX(tick) : left} x2={horizontal ? valueX(tick) : right}
                y1={horizontal ? top : y(tick)} y2={horizontal ? bottom : y(tick)} />
              {(horizontal ? [top - 14, bottom + 20] : [y(tick) + 4]).map((labelY, index) => <text key={index}
                className="character-league-chart-tick" x={horizontal ? valueX(tick) : left - 8} y={labelY}
                textAnchor={horizontal ? tick === axis.start ? 'start' : tick === axis.end ? 'end' : 'middle' : 'end'}>{tick}%</text>)}
            </g>)}
            {!ticks.includes(50) && <line className="character-league-chart-reference" data-reference-value="50"
              x1={valueX(50)} x2={valueX(50)} y1={top} y2={bottom} />}
            <path className="character-league-chart-axis" d={`M ${left} ${top} V ${bottom} H ${right}`} />
            {axis.start > 0 && <path className="character-league-chart-axis-break"
              d={horizontal ? `M ${left + 3} ${bottom - 4} l 3 8 3 -8 3 8` : `M ${left - 4} ${bottom - 4} l 8 -3 -8 -3 8 -3`} />}
          </g>
          {comparison.rows.map((row, rowIndex) => {
            const center = left + slot * (rowIndex + .5)
            const groupTop = top + rowIndex * groupHeight
            return <g key={row.characterId} data-comparison-character={row.characterId}>
              <g aria-hidden="true"><text className="character-comparison-name"
                x={horizontal ? stackedNames ? 8 : left - (grouped ? 32 : 12) : undefined}
                y={horizontal ? stackedNames ? groupTop + 12 : groupTop + seriesCount * rowHeight / 2 + 4 : undefined}
                transform={horizontal ? undefined : `translate(${center + 3},${bottom + (grouped ? 38 : 17)}) rotate(-60)`}
                textAnchor={horizontal ? stackedNames ? 'start' : 'end' : 'end'}>{row.name}</text></g>
              {row.series.map((series, seriesIndex) => {
                const { value, displayValue, outside, label, displayedLabel } = displays[rowIndex][seriesIndex]
                const style = controlTypeBarStyle(series.controlType)
                const barCenter = center + (seriesIndex - (seriesCount - 1) / 2) * barSlot
                const rowCenter = groupTop + (stackedNames ? 20 : 0) + (seriesIndex + .5) * rowHeight
                const valueTop = displayValue === null ? bottom : y(displayValue)
                const barEnd = displayValue === null ? left : valueX(displayValue)
                const outsideText = outside ? `、表示範囲${axis.start}〜${axis.end}%より${outside === 'above' ? '上' : '下'}` : ''
                const markerPath = horizontal ? `M ${barEnd} ${rowCenter} l ${outside === 'below' ? 7 : -7} -5 v 10 Z`
                  : `M ${barCenter} ${valueTop} l -5 ${outside === 'below' ? -7 : 7} h 10 Z`
                return <g key={series.controlType} role="img" data-control-type={series.controlType}
                  data-percent-hundredths={value === null ? undefined : series.point.percentHundredths} data-range-status={outside ?? undefined}
                  aria-label={`${row.name}、${leagueLabel(comparison.league)}、${style.label}、${label}${outsideText}${series.point.total?.lowSample ? '、公式の少数試合表示' : ''}`}>
                  <title>{`${row.name} ${style.label}：${label}${outsideText}${series.point.total?.lowSample ? '（公式の少数試合表示）' : ''}`}</title>
                  <g aria-hidden="true">
                    {value !== null && outside !== 'below' && <rect className="character-league-chart-bar"
                      fill={style.hatch ? `url(#${patternId})` : style.fill} stroke={style.ink} strokeWidth={style.hatch ? 1 : 0}
                      x={horizontal ? left : barCenter - barWidth / 2} y={horizontal ? rowCenter - 8 : valueTop}
                      width={horizontal ? barEnd - left : barWidth} height={horizontal ? 16 : bottom - valueTop} />}
                    {value === axis.start && <line className="character-league-chart-zero" stroke={style.ink}
                      x1={horizontal ? left : barCenter - barWidth / 2} x2={horizontal ? left : barCenter + barWidth / 2}
                      y1={horizontal ? rowCenter - 8 : bottom} y2={horizontal ? rowCenter + 8 : bottom} />}
                    {outside && <path className="character-league-chart-outside" d={markerPath} />}
                    {displayedLabel && <text className="character-league-chart-value" textAnchor="start"
                      x={horizontal ? barEnd + (outside === 'below' ? 12 : 6) : undefined} y={horizontal ? rowCenter + 4 : undefined}
                      transform={horizontal ? undefined : `translate(${barCenter + 3},${valueTop - (outside === 'below' ? 12 : 8)}) rotate(-90)`}>{displayedLabel}</text>}
                    {grouped && <text className="character-comparison-control" x={horizontal ? left - 8 : barCenter}
                      y={horizontal ? rowCenter + 4 : bottom + 16} textAnchor={horizontal ? 'end' : 'middle'}>{style.shortLabel}</text>}
                  </g>
                </g>
              })}
            </g>
          })}
          <text className="character-league-chart-axis-title" aria-hidden="true" x={horizontal ? left : (left + right) / 2}
            y={height - 8} textAnchor={horizontal ? 'start' : 'middle'}>キャラクター</text>
        </svg>
      </div>
    </div>
  </figure>
}
