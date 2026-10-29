import { useRef, type KeyboardEvent } from 'react'
import '../win-rates.css'
import '../sample-survey-chart.css'

export const SAMPLE_SURVEY_THEMES = [
  ['activity', '活動・使用状況'],
  ['rating', 'LP・MR'],
  ['character', 'キャラ別成績'],
  ['matchup', '相手キャラ別'],
  ['battle', '戦闘傾向'],
  ['recent', '直近の戦歴'],
  ['attributes', '属性・補助情報'],
] as const

export type SampleSurveyTheme = typeof SAMPLE_SURVEY_THEMES[number][0]

type Props = {
  value: SampleSurveyTheme
  onChange: (value: SampleSurveyTheme) => void
  idPrefix: string
  panelId: string
}

/** The same roving-tab keyboard pattern as the sibling project's AnalysisTabs. */
export function SampleSurveyTabs({ value, onChange, idPrefix, panelId }: Props) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = SAMPLE_SURVEY_THEMES.length
    const next = event.key === 'ArrowRight' ? (index + 1) % count
      : event.key === 'ArrowLeft' ? (index - 1 + count) % count
        : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null
    if (next === null) return
    event.preventDefault()
    onChange(SAMPLE_SURVEY_THEMES[next][0])
    window.requestAnimationFrame(() => buttons.current[next]?.focus({ preventScroll: true }))
  }
  return <div className="sample-survey-theme-tabs" role="tablist" aria-label="集計テーマ">
    {SAMPLE_SURVEY_THEMES.map(([theme, label], index) => <button
      key={theme} ref={element => { buttons.current[index] = element }}
      id={`${idPrefix}-tab-${theme}`} type="button" role="tab"
      className="win-rates-button" aria-selected={value === theme} aria-controls={panelId}
      tabIndex={value === theme ? 0 : -1}
      onClick={() => onChange(theme)} onKeyDown={event => navigate(event, index)}>{label}</button>)}
  </div>
}
