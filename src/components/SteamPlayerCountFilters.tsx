import type { ReactNode } from 'react'
import { getSteamPlayerCountJstDate, parseSteamPlayerCountDate, resolveSteamPlayerCountRange, resolveSteamPlayerCountTimeWindow } from '../lib/steamPlayerCount'
import { timestampLabel } from '../lib/dateTime'
import type { SteamPlayerCountDateRange, SteamPlayerCountDayType, SteamPlayerCountPeriod, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount'

const PERIODS = [['24h', '直近24時間'], ['7d', '直近7日'], ['30d', '直近30日'], ['all', '全期間'], ['custom', '日付指定']] as const satisfies readonly (readonly [SteamPlayerCountPeriod, string])[]
const DATE_PRESETS = [['today', '今日'], ['yesterday', '昨日']] as const
export const steamPlayerCountRangeLabel = ({ from, to }: SteamPlayerCountDateRange) => from === to
  ? from.replaceAll('-', '/') : `${from.replaceAll('-', '/')} 〜 ${to.replaceAll('-', '/')}`

export function SteamPlayerCountFilters({ children, dayType, onDayTypeChange, selection, onSelectionChange, range,
  dataRange, status, available, dataRangeLabel = 'データ範囲', now = new Date() }: {
  children?: ReactNode
  dayType: SteamPlayerCountDayType
  onDayTypeChange: (value: SteamPlayerCountDayType) => void
  selection: SteamPlayerCountRangeSelection
  onSelectionChange: (value: SteamPlayerCountRangeSelection) => void
  range: SteamPlayerCountDateRange
  dataRange: SteamPlayerCountDateRange | null
  status: 'loading' | 'ready' | 'error'
  available: boolean
  dataRangeLabel?: string
  now?: Date
}) {
  const period = typeof selection !== 'string' || selection === 'today' || selection === 'yesterday' ? 'custom' : selection
  const dateRange = typeof selection === 'string' ? range : selection
  const timeWindow = resolveSteamPlayerCountTimeWindow(selection, now)
  const today = getSteamPlayerCountJstDate(now)
  const changeDate = (key: keyof SteamPlayerCountDateRange, value: string) => {
    if (!value) return
    try { parseSteamPlayerCountDate(value) } catch { return }
    const bounded = value > today ? today : value
    const next = { ...dateRange, [key]: bounded }
    if (next.from > next.to) {
      if (key === 'from') next.to = bounded
      else next.from = bounded
    }
    onSelectionChange(next)
  }
  return <div className="win-rates-filters steam-player-count-filters">
    {children}
    <label><span>曜日</span><select aria-label="曜日" value={dayType}
      onChange={event => onDayTypeChange(event.target.value as SteamPlayerCountDayType)}>
      <option value="all">すべて</option><option value="weekday">月〜金</option><option value="weekend">土・日</option>
    </select></label>
    <div className="steam-player-count-period">
      <span className="steam-player-count-filter-label">期間</span>
      <div className="win-rates-view-selector steam-player-count-period-buttons" role="group" aria-label="期間">
        {PERIODS.map(([value, label]) => <button key={value} className="win-rates-button" type="button" aria-pressed={period === value}
          onClick={() => { if (period !== value) onSelectionChange(value === 'custom' ? { ...range } : value) }}>{label}</button>)}
      </div>
    </div>
    {period === 'custom' && <div className="steam-player-count-custom-dates">
      <div className="win-rates-view-selector steam-player-count-date-presets" role="group" aria-label="日付の候補">
        {DATE_PRESETS.map(([value, label]) => {
          const preset = resolveSteamPlayerCountRange(value, null, now)
          return <button key={value} className="win-rates-button" type="button"
            aria-pressed={dateRange.from === preset.from && dateRange.to === preset.to}
            onClick={() => onSelectionChange(preset)}>{label}</button>
        })}
      </div>
      <label><span>開始日</span><input type="date" aria-label="開始日" value={dateRange.from} max={today}
        onChange={event => changeDate('from', event.target.value)} /></label>
      <label><span>終了日</span><input type="date" aria-label="終了日" value={dateRange.to} max={today}
        onChange={event => changeDate('to', event.target.value)} /></label>
    </div>}
    <dl className="steam-player-count-range-summary" aria-live="polite" aria-atomic="true">
      <div><dt>表示期間</dt><dd>{timeWindow ? <>
        <time dateTime={timeWindow.from}>{timestampLabel(timeWindow.from).replace(/ JST$/, '')}</time>
        {' 〜 '}<time dateTime={timeWindow.to}>{timestampLabel(timeWindow.to)}</time>
      </> : period === 'all' && !available ? '—' : steamPlayerCountRangeLabel(range)}</dd></div>
      <div><dt>{dataRangeLabel}</dt><dd>{dataRange ? steamPlayerCountRangeLabel(dataRange)
        : status === 'error' ? '読込失敗' : status === 'loading' ? '読込中' : '未取得'}</dd></div>
    </dl>
  </div>
}
