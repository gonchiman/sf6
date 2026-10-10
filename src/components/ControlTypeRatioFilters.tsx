import { monthLabel } from '../lib/winRateHistory'
import { USAGE_RATE_LEAGUES, usageRateCalendarMonths } from '../lib/usageRates'
import type { UsageRateManifest, UsageRateSelection } from '../types/usageRates'
import { usageRateLeagueLabel } from './controlTypeRatioFormatting'

type Props = {
  manifest: UsageRateManifest
  selection: UsageRateSelection
  onChange: (selection: UsageRateSelection) => void
}

export function ControlTypeRatioFilters({ manifest, selection, onChange }: Props) {
  const months = usageRateCalendarMonths(manifest)
  const leagues = USAGE_RATE_LEAGUES.filter(league => manifest.datasets.some(dataset => dataset.league === league))
  const changeMonth = (key: 'fromMonth' | 'toMonth', month: string) => {
    const next = { ...selection, [key]: month }
    if (next.fromMonth > next.toMonth) {
      if (key === 'fromMonth') next.toMonth = month
      else next.fromMonth = month
    }
    onChange(next)
  }

  return <div className="win-rates-filters control-ratio-filters">
    <label><span>リーグ</span><select aria-label="リーグ" value={selection.league}
      onChange={event => onChange({ ...selection, league: event.target.value })}>
      {leagues.map(league => <option key={league} value={league}>{usageRateLeagueLabel(league)}</option>)}
    </select></label>
    <label><span>開始月</span><select aria-label="開始月" value={selection.fromMonth}
      onChange={event => changeMonth('fromMonth', event.target.value)}>
      {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
    </select></label>
    <label><span>終了月</span><select aria-label="終了月" value={selection.toMonth}
      onChange={event => changeMonth('toMonth', event.target.value)}>
      {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
    </select></label>
  </div>
}
