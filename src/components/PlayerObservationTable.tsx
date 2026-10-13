import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { timestampLabel } from '../lib/dateTime'
import { playerObservationRunCountLabel, playerObservationRunStatusLabel } from '../lib/playerObservations'
import type { PlayerObservationRun } from '../types/playerObservations'
import '../table.css'

type Props = {
  runs: readonly PlayerObservationRun[]
  selectedId: string | null
  onSelect: (id: string) => void
}

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const dateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false })

function RunPeriod({ run }: { run: PlayerObservationRun }) {
  if (!run.startedAt) return <>
    <time dateTime={run.scheduledAt}>{dateFormat.format(new Date(run.scheduledAt))}</time>
    <span><time dateTime={run.scheduledAt}>{timeFormat.format(new Date(run.scheduledAt))}</time> · 取得なし</span>
  </>
  const start = new Date(run.startedAt)
  const end = run.endedAt ? new Date(run.endedAt) : null
  const sameDate = end !== null && dateFormat.format(start) === dateFormat.format(end)
  return <>
    <time dateTime={run.startedAt}>{dateFormat.format(start)}</time>
    <span><time dateTime={run.startedAt}>{timeFormat.format(start)}</time>〜{end && run.endedAt
      ? <time dateTime={run.endedAt}>{!sameDate && `${dateFormat.format(end)} `}{timeFormat.format(end)}</time>
      : run.status === 'running' ? '取得中' : '終了未記録'}</span>
  </>
}

function runPeriodLabel(run: PlayerObservationRun): string {
  if (!run.startedAt) return `予定日時 ${timestampLabel(run.scheduledAt)}、取得なし`
  return `取得開始 ${timestampLabel(run.startedAt)}、${run.endedAt ? `取得終了 ${timestampLabel(run.endedAt)}` : '取得終了日時未記録'}`
}

export function PlayerObservationTable({ runs, selectedId, onSelect }: Props) {
  const { scrollRef, selectedRowRef } = useSelectedRowScroll(runs, selectedId, true)

  return <div ref={scrollRef} className="data-table-scroll player-observation-scroll" role="region"
    tabIndex={0} aria-label="観測回一覧・スクロール領域">
    <table className="data-table player-observation-table">
      <caption className="win-rates-visually-hidden">観測回ごとの新規観測アカウント数と取得状態。日時は日本時間です。</caption>
      <colgroup><col className="player-observation-run-column" /><col /><col /><col className="player-observation-status-column" /></colgroup>
      <thead><tr>
        <th scope="col">観測回<span className="player-observation-unit">開始〜終了 · JST</span></th>
        <th scope="col">新規観測<span className="player-observation-unit">アカウント数（件）</span></th>
        <th scope="col">観測ID数<span className="player-observation-unit">重複を除いた件数</span></th>
        <th scope="col">取得状態</th>
      </tr></thead>
      <tbody>{runs.map(run => <tr key={run.id} ref={run.id === selectedId ? selectedRowRef : undefined}
        className={run.id === selectedId ? 'is-selected' : undefined}>
        <th scope="row" className="player-observation-run-cell"><button type="button" className="player-observation-run-button"
          aria-pressed={run.id === selectedId} aria-label={`${runPeriodLabel(run)}。${run.id}の取得詳細を選択`}
          title={runPeriodLabel(run)} onClick={() => onSelect(run.id)}>
          <RunPeriod run={run} />
        </button></th>
        <td className={`player-observation-count${run.newObservedCount === null ? ' is-unavailable' : ''}`}>
          {playerObservationRunCountLabel(run)}
        </td>
        <td>{run.observedIdCount === null ? '—' : integerFormat.format(run.observedIdCount)}</td>
        <td className="player-observation-status">{playerObservationRunStatusLabel(run)}
          {run.scope === 'probe' && <span className="player-observation-unit">部分範囲の実地検証</span>}
        </td>
      </tr>)}</tbody>
    </table>
  </div>
}
