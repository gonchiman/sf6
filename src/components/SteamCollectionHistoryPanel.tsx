import { useEffect, useMemo, useRef, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { resolveSteamPlayerCountTimeWindow } from '../lib/steamPlayerCount'
import { steamPlayerCountGameLabel } from '../lib/steamPlayerCountGameColors'
import type { SteamPlayerCountComparisonState } from '../lib/steamPlayerCountComparisonFeed'
import { buildSteamHistoryRows, readSteamHistoryDays, steamHistoryBounds, steamHistoryUtcDates, type SteamHistoryDayRead } from '../lib/steamCollectionHistoryView'
import type { SteamPlayerCountAppId, SteamPlayerCountDayType, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import { steamPlayerCountNumber } from './SteamPlayerCountCharts'

const pageSize = 50
const refreshIntervalMs = 5 * 60_000
const bundledBase = `${import.meta.env.BASE_URL}data/steam-collection-history/`

export function SteamCollectionHistoryPanel({ state, selection, dayType, appIds, onRefreshObservations }: {
  state: SteamPlayerCountComparisonState
  selection: SteamPlayerCountRangeSelection
  dayType: SteamPlayerCountDayType
  appIds: readonly SteamPlayerCountAppId[]
  onRefreshObservations: () => void
}) {
  const { now, range, entries } = state
  const bounds = steamHistoryBounds(range, resolveSteamPlayerCountTimeWindow(selection, now), now)
  const datesKey = steamHistoryUtcDates(bounds).join(',')
  const refreshKey = Math.floor(now.getTime() / refreshIntervalMs)
  const [loaded, setLoaded] = useState<{ datesKey: string; days: SteamHistoryDayRead[] }>()
  const dayCache = useRef(new Map<string, SteamHistoryDayRead>())
  const [retry, setRetry] = useState(0)
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [position, setPosition] = useState({ scope: '', page: 0 })
  const scope = JSON.stringify([appIds, dayType, selection, onlyMissing])

  useEffect(() => {
    if (!datesKey) return
    const controller = new AbortController()
    void readSteamHistoryDays(datesKey.split(','), bundledBase, controller.signal, dayCache.current).then(days => {
      if (!controller.signal.aborted) setLoaded({ datesKey, days })
    })
    return () => controller.abort()
  }, [datesKey, refreshKey, retry])

  const days = loaded?.datesKey === datesKey ? loaded.days : null
  const rows = useMemo(() => {
    if (!days) return []
    const all = buildSteamHistoryRows(bounds, now, dayType, appIds, days, entries)
    return onlyMissing ? all.filter(row => row.result === '欠測' || row.result === '一部取得') : all
  }, [days, bounds.start, bounds.end, now, dayType, appIds, entries, onlyMissing])
  const pageCount = Math.ceil(rows.length / pageSize)
  const page = Math.min(position.scope === scope ? position.page : 0, Math.max(0, pageCount - 1))
  const visible = rows.slice(page * pageSize, (page + 1) * pageSize)
  const failed = days?.some(day => day.failed)
  const loading = !!datesKey && !days

  return <StatisticsPanel title="取得履歴" headerContent={<span className="monthly-statistics-panel-summary" aria-live="polite">
    {loading ? '読込中' : `${steamPlayerCountNumber(rows.length)}件`}
  </span>}>
    <div className="steam-collection-history-controls">
      <label className="win-rates-chart-value-toggle">
        <input type="checkbox" checked={onlyMissing} onChange={event => setOnlyMissing(event.currentTarget.checked)} />
        欠測・一部取得のみ
      </label>
    </div>
    {state.status === 'error' && <DataLoadState message="観測データの読込失敗" onRetry={onRefreshObservations} />}
    {failed && <DataLoadState message="取得履歴の一部を読み込めませんでした。" onRetry={() => setRetry(value => value + 1)} />}
    {loading ? <DataLoadState loading message="取得履歴を読み込み中…" />
      : visible.length ? <div className="data-table-scroll steam-player-count-table-scroll" role="region" aria-label="取得履歴の一覧" tabIndex={0}>
        <table className="data-table steam-player-count-table steam-collection-history-table">
          <caption className="win-rates-visually-hidden">選択したゲームの取得履歴</caption>
          <thead><tr><th scope="col">予定（JST）</th><th scope="col">結果</th><th scope="col">欠測理由</th><th scope="col">ログ</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.scheduledAt}>
            <th scope="row"><time dateTime={row.scheduledAt}>{timestampLabel(row.scheduledAt).replace(/ JST$/, '')}</time></th>
            <td className={row.result === '欠測' || row.result === '一部取得' ? 'steam-collection-history-gap' : undefined}>{row.result}{appIds.length > 1 && <span className="steam-collection-history-count"> {row.successCount} / {appIds.length}作品</span>}</td>
            <td>{row.reasons.length ? <ul>{row.reasons.map(({ appId, label }, index) => <li key={`${appId ?? 'dispatch'}:${index}`}>
              {appIds.length > 1 && appId ? `${steamPlayerCountGameLabel(appId)}：` : ''}{label}
            </li>)}</ul> : '—'}</td>
            <td>{row.logs.length ? <ul>{row.logs.map(({ kind, runId, attempt }) => <li key={`${kind}:${runId}:${attempt}`}>
              <a href={`https://github.com/gonchiman/sf6/actions/runs/${runId}/attempts/${attempt}`} target="_blank" rel="noreferrer">
                {kind}<span className="win-rates-visually-hidden">（新しいタブ）</span>
              </a>
            </li>)}</ul> : '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>
        : !failed && state.status !== 'error' && <div className="steam-player-count-empty" role="status">
          {onlyMissing ? '欠測・一部取得の記録なし' : '対象期間の取得記録なし'}
        </div>}
    {pageCount > 1 && <div className="steam-collection-history-pagination" role="group" aria-label="取得履歴のページ">
      <button className="win-rates-button" type="button" disabled={page === 0} onClick={() => setPosition({ scope, page: page - 1 })}>前へ</button>
      <span aria-live="polite">{page + 1} / {pageCount} ページ</span>
      <button className="win-rates-button" type="button" disabled={page >= pageCount - 1} onClick={() => setPosition({ scope, page: page + 1 })}>次へ</button>
    </div>}
  </StatisticsPanel>
}
