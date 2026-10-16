import { timestampLabel } from '../lib/dateTime'
import type { LegendAnalysisDescriptor } from '../types/legendAnalysis'

type Props = {
  descriptors: readonly LegendAnalysisDescriptor[]
  actId: string | null
  selectedId: string | null
  actLabel?: string
  onActChange: (actId: string) => void
  onCaptureChange: (id: string) => void
}

export function LegendAnalysisFilters({ descriptors, actId, selectedId, actLabel, onActChange, onCaptureChange }: Props) {
  const acts = [...new Set(descriptors.map(item => item.actId))]
  const captures = descriptors.filter(item => item.actId === actId)
  return <div className="win-rates-filters legend-analysis-filters">
    <label><span>Act</span><select aria-label="Act" value={actId ?? ''} disabled={acts.length < 2}
      onChange={event => onActChange(event.target.value)}>
      {acts.length === 0 && <option value="">未取得</option>}
      {acts.map(value => <option key={value} value={value}>{value === actId && actLabel ? actLabel : /^act-\d+$/.test(value) ? value.replace('act-', 'Act ') : value}</option>)}
    </select></label>
    <label><span>取得日</span><select aria-label="取得日" value={selectedId ?? ''} disabled={captures.length < 2}
      onChange={event => onCaptureChange(event.target.value)}>
      {captures.length === 0 && <option value="">未取得</option>}
      {captures.map(item => <option key={item.id} value={item.id}>{timestampLabel(item.captureEndedAt)}</option>)}
    </select></label>
  </div>
}
