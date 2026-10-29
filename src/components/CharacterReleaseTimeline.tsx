import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buildCharacterReleaseTimeline } from '../lib/characterReleaseTimeline'
import { buildCharacterReleaseTimelineLayout } from '../lib/characterReleaseTimelineLayout'
import type { CharacterReleaseRow } from '../types/characterReleases'
import type { CharacterReleaseTimelineDirection } from '../types/characterReleaseTimeline'
import '../character-release-timeline.css'

type Props = {
  id: string
  rows: readonly CharacterReleaseRow[]
  direction: CharacterReleaseTimelineDirection
}

export function CharacterReleaseTimeline({ id, rows, direction }: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(320)
  const data = useMemo(() => buildCharacterReleaseTimeline(rows), [rows])
  const layout = useMemo(() => buildCharacterReleaseTimelineLayout(data.events, direction, availableWidth), [data.events, direction, availableWidth])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    let frame: number | null = null
    let measuredWidth = 0
    const measure = () => {
      const width = viewport.clientWidth
      if (width <= 0 || width === measuredWidth) return
      measuredWidth = width
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        setAvailableWidth(previous => previous === width ? previous : width)
      })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(viewport)
    if (!observer) window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  const range = layout.dateRange
  const dateText = (value: string) => value.replaceAll('-', '/')
  const releasedDates = new Set(data.events.filter(event => event.status === 'released').map(event => event.date))
  const points = [...layout.entries].sort((first, second) => Number(first.event.status === 'released') - Number(second.event.status === 'released'))

  return <figure id={id} className="character-release-timeline" aria-labelledby={titleId}>
    <figcaption id={titleId} className="character-release-timeline-period">
      <span className="win-rates-visually-hidden">キャラ実装日のタイムライン</span>
      {range && <>{dateText(range.start)}{range.start !== range.end && `–${dateText(range.end)}`}</>}
    </figcaption>
    <div ref={viewportRef} className="character-release-timeline-viewport">
      {layout.entries.length === 0 ? <p className="character-release-state" role="status">表示できる実装日がありません。</p>
        : <div className="character-release-timeline-scroll" role="region" aria-label="実装日タイムライン・スクロール領域"
          tabIndex={layout.width > availableWidth ? 0 : undefined}>
          <svg className="character-release-timeline-svg" width={layout.width} height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-labelledby={titleId} aria-describedby={descriptionId}
            data-chart-direction={direction}>
            <title>キャラ実装日のタイムライン</title>
            <desc id={descriptionId}>日付の差に比例する間隔で実装日を配置します。
              {direction === 'horizontal' ? '左から右へ' : '上から下へ'}古い日付から並びます。
              同日実装は状態ごとにまとめ、配信予定は中抜きの点で示します。実装日未確認のキャラは軸に配置しません。</desc>
            <g aria-hidden="true">
              <line className="character-release-timeline-axis" {...layout.axis} />
              {layout.ticks.map(tick => <text key={tick.key} className="character-release-timeline-tick"
                x={tick.x} y={tick.y} textAnchor={tick.anchor}>{tick.label}</text>)}
              <text className="character-release-timeline-axis-title" x={layout.width / 2}
                y={direction === 'horizontal' ? layout.height - 8 : 15} textAnchor="middle">
                実装日 · {direction === 'horizontal' ? '横' : '縦'}の距離＝経過日数
              </text>
              {layout.entries.map(entry => <line key={entry.event.key} className="character-release-timeline-connector" {...entry.connector} />)}
            </g>
            {layout.entries.map(entry => {
              const { event, labelX, labelY, labelWidth, anchor } = entry
              const names = event.rows.map(row => row.character.name).join('、')
              const labelLeft = anchor === 'middle' ? labelX - labelWidth / 2 : anchor === 'end' ? labelX - labelWidth : labelX
              return <g key={event.key} role="img" aria-label={`${entry.dateLabel}：${names}`} data-release-date={event.date} data-release-status={event.status}>
                <title>{entry.dateLabel}：{names}</title>
                <g aria-hidden="true">
                  <rect className="character-release-timeline-label-background" x={labelLeft - 3} y={labelY - 32}
                    width={labelWidth + 6} height={40 + Math.max(0, entry.labelLines.length - 1) * 16} />
                  <text className="character-release-timeline-date" x={labelX} y={labelY - 18} textAnchor={anchor}>{entry.dateLabel}</text>
                  <text className="character-release-timeline-name" x={labelX} y={labelY} textAnchor={anchor}>
                    {entry.labelLines.map((line, index) => <tspan key={index} x={labelX} dy={index === 0 ? 0 : 16}>{line}</tspan>)}
                  </text>
                </g>
              </g>
            })}
            <g aria-hidden="true">{points.map(entry => <circle key={entry.event.key}
              className={`character-release-timeline-point${entry.event.status === 'scheduled' ? ' is-scheduled' : ''}`}
              cx={entry.x} cy={entry.y} r={entry.event.status === 'scheduled' ? releasedDates.has(entry.event.date) ? 6 : 4.5 : 3.5}
              data-release-point={entry.event.key} />)}</g>
          </svg>
        </div>}
    </div>
    {data.undated.length > 0 && <p className="character-release-timeline-undated" role="status">
      実装日未確認：{data.undated.map(row => row.character.name).join('、')}
    </p>}
  </figure>
}
