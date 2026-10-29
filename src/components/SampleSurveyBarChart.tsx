import { useId, useMemo } from 'react'
import { sampleSurveyBarAxis, sampleSurveyBarNumber, sampleSurveyBarValue } from '../lib/sampleSurveyBarChart'
import '../sample-survey-chart.css'

export type SampleSurveyBarRow = {
  id: string
  label: string
  value: number | null
  stateLabel?: string
}

type Props = {
  title: string
  unit: string
  rows: readonly SampleSurveyBarRow[]
  percent?: boolean
}

/** CSS grid keeps every label readable without scaling SVG text on narrow screens. */
export function SampleSurveyBarChart({ title, unit, rows, percent = false }: Props) {
  const titleId = useId()
  const values = useMemo(() => rows.map(row => sampleSurveyBarValue(row.value, percent)), [rows, percent])
  const axis = useMemo(() => sampleSurveyBarAxis(values, percent), [values, percent])
  const hasValues = values.some(value => value !== null)
  if (rows.length === 0) return <p className="sample-survey-bars-empty" role="status">未取得</p>
  return <figure className="sample-survey-bars" aria-labelledby={titleId}>
    <figcaption id={titleId} className="sample-survey-bars-title">{title}（{unit}）</figcaption>
    <div className="sample-survey-bars-rows">
      {rows.map((row, index) => {
        const value = values[index]
        const valueLabel = value === null ? row.stateLabel ?? '算出不可' : `${sampleSurveyBarNumber(value)}${unit}`
        return <div key={row.id} className="sample-survey-bars-row" role="img" aria-label={`${row.label}：${valueLabel}`}>
          <span className="sample-survey-bars-name" aria-hidden="true">{row.label}</span>
          <span className={`sample-survey-bars-track${value === null ? ' sample-survey-bars-track-missing' : ''}`} aria-hidden="true">
            {value !== null && <span className="sample-survey-bars-fill" style={{ width: `${value / axis.maximum * 100}%` }} />}
          </span>
          <span className="sample-survey-bars-value" aria-hidden="true">{valueLabel}</span>
        </div>
      })}
    </div>
    {hasValues && <div className="sample-survey-bars-axis" aria-hidden="true">
      <div className="sample-survey-bars-ticks">
        {axis.ticks.map((tick, index) => <span key={index}>{sampleSurveyBarNumber(tick)}</span>)}
      </div>
      <span className="sample-survey-bars-axis-unit">{unit}</span>
    </div>}
  </figure>
}
