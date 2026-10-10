import { editionOf, leagueLabel, WIN_RATE_EDITIONS } from '../lib/winRateConditions'
import { historyCalendarMonths, monthLabel } from '../lib/winRateHistory'
import type { HistoryControlType, WinRateHistorySelection } from '../types/winRateHistory'
import type { WinRateEdition, WinRateManifest } from '../types/winRates'
import '../win-rates.css'
import '../win-rate-history.css'

const CONTROL_LABELS: Record<HistoryControlType, string> = {
  combined: '合算', classic: 'クラシック', modern: 'モダン',
}

type Props = {
  manifest: WinRateManifest
  selection: WinRateHistorySelection
  onChange: (selection: WinRateHistorySelection) => void
  showLeague?: boolean
}

/** Shared period and population controls for history and monthly statistics. */
export function WinRateHistoryFilters({ manifest, selection, onChange, showLeague = true }: Props) {
  const edition = editionOf(selection)
  const months = historyCalendarMonths(manifest)
  const editions = WIN_RATE_EDITIONS.filter(value => manifest.datasets.some(item => editionOf(item) === value))
  const editionDatasets = manifest.datasets.filter(item => editionOf(item) === edition)
  const leagues = [...new Set(editionDatasets.map(item => item.league))]

  const controlsFor = (nextEdition: WinRateEdition, league: string): HistoryControlType[] => {
    const modes = new Set(manifest.datasets.filter(item => editionOf(item) === nextEdition && item.league === league)
      .map(item => item.operationMode))
    return (Object.keys(CONTROL_LABELS) as HistoryControlType[])
      .filter(value => (nextEdition !== 'master' || value === 'combined')
        && modes.has(value === 'combined' ? 'combined' : 'separate'))
  }
  const controls = controlsFor(edition, selection.league)

  const changeMonth = (key: 'fromMonth' | 'toMonth', month: string) => {
    const next = { ...selection, [key]: month }
    if (next.fromMonth > next.toMonth) {
      if (key === 'fromMonth') next.toMonth = month
      else next.fromMonth = month
    }
    onChange(next)
  }

  return <div className="win-rates-filters history-filters">
    <label><span>統計</span><select aria-label="統計" value={edition} onChange={event => {
      const nextEdition = WIN_RATE_EDITIONS.find(value => value === event.target.value)
      if (!nextEdition) return
      const candidates = manifest.datasets.filter(item => editionOf(item) === nextEdition)
      const league = candidates.some(item => item.league === 'MASTER') ? 'MASTER' : candidates[0]?.league
      if (!league) return
      const availableControls = controlsFor(nextEdition, league)
      onChange({ ...selection, edition: nextEdition, league, controlType: availableControls[0] ?? 'combined' })
    }}>
      {editions.map(value => <option key={value} value={value}>{value === 'general' ? '総合版' : 'マスター版'}</option>)}
    </select></label>
    {showLeague && <label className="win-rates-league-filter"><span>リーグ</span><select aria-label="リーグ" value={selection.league} onChange={event => {
      const league = event.target.value
      const availableControls = controlsFor(edition, league)
      onChange({ ...selection, league, controlType: availableControls.includes(selection.controlType)
        ? selection.controlType : availableControls[0] ?? 'combined' })
    }}>
      {leagues.map(value => <option key={value} value={value}>{leagueLabel(value)}</option>)}
    </select></label>}
    <label><span>操作タイプ</span><select aria-label="操作タイプ" value={selection.controlType}
      onChange={event => onChange({ ...selection, controlType: event.target.value as HistoryControlType })}>
      {controls.map(value => <option key={value} value={value}>{CONTROL_LABELS[value]}</option>)}
    </select></label>
    <label><span>開始月</span><select aria-label="開始月" value={selection.fromMonth} onChange={event => changeMonth('fromMonth', event.target.value)}>
      {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
    </select></label>
    <label><span>終了月</span><select aria-label="終了月" value={selection.toMonth} onChange={event => changeMonth('toMonth', event.target.value)}>
      {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
    </select></label>
  </div>
}
