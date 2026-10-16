import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LEGEND_ANALYSIS_BIN_SIZE } from '../lib/legendAnalysis'
import type { LegendMrDistribution } from '../types/legendAnalysis'
import '../table.css'

type Props = {
  current: LegendMrDistribution
  previous: LegendMrDistribution | null
  currentLabel: string
  previousLabel: string | null
}

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const valueFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 })
const percentageFormat = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const valueLabel = (value: number | null) => value === null ? '—' : valueFormat.format(value)
const percentLabel = (value: number | null) => value === null ? '—' : `${percentageFormat.format(value)}%`
const SUMMARY_METRICS = [
  { key: 'min', label: '最小' }, { key: 'p25', label: '第1四分位' }, { key: 'median', label: '中央値' },
  { key: 'p75', label: '第3四分位' }, { key: 'max', label: '最大' },
] as const

export function LegendMrDistributionChart({ current, previous, currentLabel, previousLabel }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const rows = useMemo(() => {
    const bounds = [...current.bins, ...(previous?.bins ?? [])].map(bin => bin.lower)
    const start = bounds.length ? Math.min(...bounds) : 0
    const end = bounds.length ? Math.max(...bounds) : 0
    const lowers = bounds.length ? Array.from({ length: (end - start) / LEGEND_ANALYSIS_BIN_SIZE + 1 },
      (_, index) => start + index * LEGEND_ANALYSIS_BIN_SIZE) : []
    const currentBins = new Map(current.bins.map(bin => [bin.lower, bin.count]))
    const previousBins = new Map(previous?.bins.map(bin => [bin.lower, bin.count]) ?? [])
    return lowers.map(lower => {
      const count = currentBins.get(lower) ?? 0
      const previousCount = previous ? previousBins.get(lower) ?? 0 : null
      return { lower, upper: lower + LEGEND_ANALYSIS_BIN_SIZE, count, previousCount,
        percent: current.count > 0 ? count / current.count * 100 : null,
        previousPercent: previous && previous.count > 0 ? previousCount! / previous.count * 100 : null }
    })
  }, [current, previous])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => { if (viewport.clientWidth > 0) setAvailableWidth(viewport.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [rows.length])

  const maximum = Math.max(0, ...rows.flatMap(row => [row.percent ?? 0, row.previousPercent ?? 0]))
  const step = maximum <= 10 ? 2 : maximum <= 25 ? 5 : maximum <= 50 ? 10 : 20
  const axisMaximum = Math.max(step, Math.ceil(maximum / step) * step)
  const ticks = Array.from({ length: axisMaximum / step + 1 }, (_, index) => index * step)
  const width = Math.max(320, availableWidth, 92 + rows.length * 62)
  const left = 52
  const right = width - 28
  const top = 30
  const bottom = 258
  const height = 314
  const slot = rows.length ? (right - left) / rows.length : 0
  const barWidth = Math.min(previous ? 22 : 34, slot * (previous ? .32 : .62))
  const y = (value: number) => bottom - value / axisMaximum * (bottom - top)
  const series = [{ label: '今回', captureLabel: currentLabel, data: current },
    ...(previous ? [{ label: '前回', captureLabel: previousLabel ?? '前回取得', data: previous }] : [])]

  return <div className="legend-analysis-content">
    <figure className="legend-analysis-chart" aria-label="レジェンド帯のMR分布">
      <ul className="legend-analysis-chart-legend" aria-label="MR分布の凡例">
        <li><span className="legend-analysis-swatch" aria-hidden="true" />今回：{currentLabel}</li>
        {previous && <li><span className="legend-analysis-swatch is-previous" aria-hidden="true" />前回：{previousLabel}</li>}
      </ul>
      <div ref={viewportRef} className="legend-analysis-chart-viewport">
        {rows.length === 0 ? <p className="legend-analysis-message" role="status">掲載数が0件のため、MRの分布と要約値は算出できません。</p>
          : <div className="legend-analysis-chart-scroll" role="region" aria-label="50 MR刻みの分布グラフ・スクロール領域" tabIndex={0}>
            <svg className="legend-analysis-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
              role="group" aria-labelledby={titleId} aria-describedby={descriptionId} data-axis-start="0" data-axis-end={axisMaximum}>
              <title id={titleId}>レジェンド帯のMR分布</title>
              <desc id={descriptionId}>横軸は50 MR刻みの共通階級、縦軸は各取得回の掲載エントリー数を分母にした割合です。縦軸は0%起点です。
                今回は灰色の棒{previous ? '、前回は破線の輪郭で区別します' : 'で表示します'}。各階級は下限以上、上限未満です。全件数・割合は下の数値表でも確認できます。</desc>
              <g aria-hidden="true">
                <text className="legend-analysis-chart-axis-title" x={left} y="15">掲載数に占める割合（%）</text>
                {ticks.map(tick => <g key={tick}>
                  <line className="legend-analysis-chart-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
                  <text className="legend-analysis-chart-tick" x={left - 10} y={y(tick) + 4} textAnchor="end">{tick}%</text>
                </g>)}
                <path className="legend-analysis-chart-axis" d={`M ${left} ${top} V ${bottom} H ${right}`} />
                {rows.map((row, index) => <text key={row.lower} className="legend-analysis-chart-tick" x={left + slot * index}
                  y={bottom + 20} textAnchor="middle">{integerFormat.format(row.lower)}</text>)}
                <text className="legend-analysis-chart-tick" x={right} y={bottom + 20} textAnchor="middle">{integerFormat.format(rows.at(-1)!.upper)}</text>
                <text className="legend-analysis-chart-axis-title" x={(left + right) / 2} y={height - 9} textAnchor="middle">MR（50刻み・下限以上／上限未満）</text>
              </g>
              {rows.map((row, index) => {
                const center = left + slot * (index + .5)
                const description = `${row.lower}以上${row.upper}未満、今回 ${integerFormat.format(row.count)}件、${percentLabel(row.percent)}${previous ? `、前回 ${integerFormat.format(row.previousCount!)}件、${percentLabel(row.previousPercent)}` : ''}`
                return <g key={row.lower} role="img" aria-label={description}>
                  <title>{description}</title>
                  <g aria-hidden="true">
                    <rect className="legend-analysis-chart-hit" x={left + slot * index} y={top} width={slot} height={bottom - top} />
                    {[{ value: row.percent, offset: previous ? -barWidth - 1 : -barWidth / 2, previous: false },
                      ...(previous ? [{ value: row.previousPercent, offset: 1, previous: true }] : [])].map(item => item.value === null ? null
                      : item.value === 0 ? <line key={String(item.previous)} className="legend-analysis-chart-zero"
                        x1={center + item.offset} x2={center + item.offset + barWidth} y1={bottom} y2={bottom} />
                        : <rect key={String(item.previous)} className={item.previous ? 'legend-analysis-chart-previous' : 'legend-analysis-chart-current'}
                          x={center + item.offset} y={y(item.value)} width={barWidth} height={bottom - y(item.value)} />)}
                  </g>
                </g>
              })}
            </svg>
          </div>}
      </div>
    </figure>
    <p className="legend-analysis-note">割合の分母は今回{integerFormat.format(current.count)}件{previous ? `、前回${integerFormat.format(previous.count)}件` : ''}。各回の掲載集団を比較しており、同じエントリーのMR増減ではありません。</p>
    <div className="data-table-scroll legend-analysis-mr-summary-scroll" role="region" tabIndex={0} aria-label="MRの要約値・スクロール領域">
      <table className="data-table legend-analysis-mr-summary">
        <caption className="win-rates-visually-hidden">各取得回のMRの要約値。単位MR。0件の要約値は算出できません。</caption>
        <thead><tr><th scope="col">取得回</th>{SUMMARY_METRICS.map(metric => <th key={metric.key} scope="col">{metric.label}<span className="legend-analysis-unit">MR</span></th>)}</tr></thead>
        <tbody>{series.map(item => <tr key={item.label}><th scope="row" title={item.captureLabel}>{item.label}</th>
          {SUMMARY_METRICS.map(metric => <td key={metric.key}>{valueLabel(item.data[metric.key])}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <details className="win-rates-details">
      <summary>MR階級ごとの数値</summary>
      <div className="win-rates-details-content">
        <div className="data-table-scroll legend-analysis-mr-bins-scroll" role="region" tabIndex={0} aria-label="MR階級ごとの掲載数と割合・スクロール領域">
          <table className="data-table legend-analysis-mr-bins">
            <caption className="win-rates-visually-hidden">今回と前回に共通する50 MR刻みの階級。割合の分母は各回の掲載総数です。</caption>
            <thead><tr><th scope="col">MR階級</th><th scope="col">今回<span className="legend-analysis-unit">件</span></th><th scope="col">今回<span className="legend-analysis-unit">%</span></th>
              {previous && <><th scope="col">前回<span className="legend-analysis-unit">件</span></th><th scope="col">前回<span className="legend-analysis-unit">%</span></th></>}
            </tr></thead>
            <tbody>{rows.map(row => <tr key={row.lower}><th scope="row">{integerFormat.format(row.lower)}以上<br />{integerFormat.format(row.upper)}未満</th>
              <td>{integerFormat.format(row.count)}</td><td>{row.percent === null ? '—' : percentageFormat.format(row.percent)}</td>
              {previous && <><td>{integerFormat.format(row.previousCount!)}</td><td>{row.previousPercent === null ? '—' : percentageFormat.format(row.previousPercent)}</td></>}
            </tr>)}
              {rows.length === 0 && <tr><td colSpan={previous ? 5 : 3}>掲載数が0件のため階級はありません。</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  </div>
}
