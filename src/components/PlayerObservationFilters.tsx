import { playerObservationDateRange } from '../lib/playerObservations'
import type { PlayerObservationDataset, PlayerObservationSelection } from '../types/playerObservations'

type Props = {
  dataset: PlayerObservationDataset
  selection: PlayerObservationSelection
  onChange: (selection: PlayerObservationSelection) => void
}

export function PlayerObservationFilters({ dataset, selection, onChange }: Props) {
  const range = playerObservationDateRange(dataset)
  const changeDate = (key: 'fromDate' | 'toDate', value: string) => {
    if (!value) return
    const next = { ...selection, [key]: value }
    if (next.fromDate > next.toDate) {
      if (key === 'fromDate') next.toDate = value
      else next.fromDate = value
    }
    onChange(next)
  }

  return <div className="win-rates-filters player-observation-filters">
    <label><span>開始日</span><input type="date" aria-label="開始日" value={selection.fromDate}
      min={range.fromDate} max={range.toDate} disabled={dataset.runs.length === 0}
      onChange={event => changeDate('fromDate', event.target.value)} /></label>
    <label><span>終了日</span><input type="date" aria-label="終了日" value={selection.toDate}
      min={range.fromDate} max={range.toDate} disabled={dataset.runs.length === 0}
      onChange={event => changeDate('toDate', event.target.value)} /></label>
    <label><span>取得状態</span><select aria-label="取得状態" value={selection.status}
      disabled={dataset.runs.length === 0}
      onChange={event => onChange({ ...selection, status: event.target.value as PlayerObservationSelection['status'] })}>
      <option value="all">すべて</option>
      <option value="baseline">基準走査</option>
      <option value="running">取得中</option>
      <option value="complete">走査完了</option>
      <option value="partial">部分取得</option>
      <option value="failed">取得失敗</option>
      <option value="missing">欠測</option>
    </select></label>
  </div>
}
