import { usageRateCalendarMonths } from '../lib/usageRates'
import { monthLabel } from '../lib/winRateHistory'
import type { UsageRateHistorySelection } from '../types/usageRateHistory'
import type { UsageRateEdition, UsageRateManifest } from '../types/usageRates'

export function UsageRateHistoryPeriodFilters({ manifest, edition, selection, onChange }: {
  manifest: UsageRateManifest
  edition: UsageRateEdition
  selection: UsageRateHistorySelection | null
  onChange: (selection: UsageRateHistorySelection) => void
}) {
  if (!selection) return null
  const months = usageRateCalendarMonths(manifest, edition)
  const changeMonth = (key: 'fromMonth' | 'toMonth', month: string) => {
    const next = { ...selection, [key]: month }
    if (next.fromMonth > next.toMonth) {
      if (key === 'fromMonth') next.toMonth = month
      else next.fromMonth = month
    }
    onChange(next)
  }
  return <>
    <label><span>開始月</span><select aria-label="開始月" value={selection.fromMonth}
      onChange={event => changeMonth('fromMonth', event.target.value)}>
      {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
    </select></label>
    <label><span>終了月</span><select aria-label="終了月" value={selection.toMonth}
      onChange={event => changeMonth('toMonth', event.target.value)}>
      {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
    </select></label>
  </>
}
