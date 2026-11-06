import { useMemo, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { buildSteamPlayerCountGameComparison } from '../lib/steamPlayerCountComparison'
import { resolveSteamPlayerCountTimeWindow } from '../lib/steamPlayerCount'
import { STEAM_PLAYER_COUNT_GAMES } from '../lib/steamPlayerCountGames'
import { steamPlayerCountGameLabel } from '../lib/steamPlayerCountGameColors'
import { useSteamPlayerCountComparison } from '../lib/useSteamPlayerCountComparison'
import type { SteamPlayerCountAppId, SteamPlayerCountDayType, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount'
import type { SteamPlayerCountGameComparison } from '../types/steamPlayerCountComparison'
import { ComparisonSelection } from './ComparisonSelection'
import { ContentTabs } from './ContentTabs'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import { SteamPlayerCountFilters } from './SteamPlayerCountFilters'
import { steamPlayerCountNumber } from './SteamPlayerCountCharts'
import { SteamPlayerCountGameHourlyChart, SteamPlayerCountGameKey, SteamPlayerCountGameSummaryChart } from './SteamPlayerCountComparisonCharts'

const TABS = [['hourly', '時間帯比較'], ['summary', '期間比較'], ['table', '時間帯一覧']] as const
type Tab = (typeof TABS)[number][0]

export function SteamPlayerCountGameComparisonTable({ comparison }: { comparison: SteamPlayerCountGameComparison }) {
  return <div className="data-table-scroll steam-player-count-table-scroll" role="region" aria-label="ゲーム別・時間帯別の集計" tabIndex={0}>
    <table className="data-table steam-player-count-table steam-player-count-comparison-table">
      <caption className="win-rates-visually-hidden">共通観測によるゲーム別の時間帯平均同時接続数と比較日数</caption>
      <thead><tr><th scope="col">時間帯（JST）</th>
        {comparison.series.map(series => <th scope="col" key={series.game.appId}>
          <span className="steam-player-count-game-key"><SteamPlayerCountGameKey appId={series.game.appId} />{steamPlayerCountGameLabel(series.game.appId)}</span>
          <span className="steam-player-count-table-unit">平均（人）</span>
        </th>)}
        <th scope="col">共通比較日数</th><th scope="col">共通観測／予定</th>
      </tr></thead>
      <tbody>{comparison.hourly.map(row => <tr key={row.hour}>
        <th scope="row">{String(row.hour).padStart(2, '0')}時台</th>
        {comparison.series.map(series => {
          const value = series.hourly.find(item => item.hour === row.hour)?.mean ?? null
          return <td key={series.game.appId} className={value === null ? 'is-unavailable' : undefined}>
            {value === null ? <><span aria-hidden="true">—</span><span className="win-rates-visually-hidden">算出不可</span></> : steamPlayerCountNumber(value)}
          </td>
        })}
        <td>{row.validDays} / {row.totalDays} 日</td>
        <td>{steamPlayerCountNumber(row.observedSlots)} / {steamPlayerCountNumber(row.expectedSlots)} 区間</td>
      </tr>)}</tbody>
    </table>
  </div>
}

export function SteamPlayerCountComparisonView({ appIds, onAppIdsChange, dayType, onDayTypeChange, selection, onSelectionChange }: {
  appIds: readonly SteamPlayerCountAppId[]
  onAppIdsChange: (value: SteamPlayerCountAppId[]) => void
  dayType: SteamPlayerCountDayType
  onDayTypeChange: (value: SteamPlayerCountDayType) => void
  selection: SteamPlayerCountRangeSelection
  onSelectionChange: (value: SteamPlayerCountRangeSelection) => void
}) {
  const [tab, setTab] = useState<Tab>('hourly')
  const [scale, setScale] = useState<'people' | 'index'>('people')
  const [metric, setMetric] = useState<'mean' | 'peak'>('mean')
  const state = useSteamPlayerCountComparison(appIds, selection)
  const comparison = useMemo(() => buildSteamPlayerCountGameComparison(state.entries, state.comparisonRange, dayType, state.now,
    resolveSteamPlayerCountTimeWindow(selection, state.now)), [state.entries, state.comparisonRange, state.now, dayType, selection])
  const coverage = `共通 ${comparison.commonDays} 日・${steamPlayerCountNumber(comparison.commonHours)} 時間（${steamPlayerCountNumber(comparison.commonSlots)} 区間）`
  const failedLabels = state.failedAppIds.map(steamPlayerCountGameLabel).join('・')

  return <section className="steam-player-count-page steam-player-count-comparison" aria-label="Steam同時接続数のゲーム比較">
    <div className="steam-player-count-context"><span>対象：Steam・世界全体・全モード</span><span>時刻：JST</span><span>取得予定：15分ごと</span></div>
    <StatisticsPanel title="表示条件" headerContent={<span className="monthly-statistics-panel-summary">日本時間</span>}>
      <ComparisonSelection items={STEAM_PLAYER_COUNT_GAMES.map(game => ({ id: String(game.appId), name: steamPlayerCountGameLabel(game.appId) }))}
        selectedIds={appIds.map(String)} onChange={ids => onAppIdsChange(STEAM_PLAYER_COUNT_GAMES.filter(game => ids.includes(String(game.appId))).map(game => game.appId))}
        label="比較ゲーム" selectionLabel="比較中のゲーム" pickerLabel="ゲームを選択" legendLabel="ゲーム"
        renderKey={id => <SteamPlayerCountGameKey appId={Number(id) as SteamPlayerCountAppId} />}
        layout="grid" showOptionKeys minimumSelectionLabel={null} selectionCountLabel={count => `${count}作品`} />
      <SteamPlayerCountFilters dayType={dayType} onDayTypeChange={onDayTypeChange} selection={selection}
        onSelectionChange={onSelectionChange} range={state.range} dataRange={state.dataRange} status={state.status}
        available={state.dataRange !== null} dataRangeLabel="共通データ範囲" now={state.now} />
    </StatisticsPanel>
    {state.refreshError && <div className="steam-player-count-message" role="status">
      <span>更新確認失敗{failedLabels ? `：${failedLabels}` : ''}</span><span>前回確認済みデータ</span>
      <button type="button" className="win-rates-button" onClick={state.refresh}>更新を確認</button>
    </div>}
    {state.status === 'loading' ? <DataLoadState loading message="比較するゲームの観測データを読み込み中…" />
      : state.status === 'error' ? <DataLoadState message={`比較データの読込失敗${failedLabels ? `：${failedLabels}` : ''}`} onRetry={state.refresh} />
        : <>
          <ContentTabs id="steam-game-comparison" label="比較の表示内容" options={TABS} value={tab} onChange={setTab} className="steam-player-count-tabs" />
          <section className="steam-player-count-panel" id="steam-game-comparison-panel-hourly" role="tabpanel"
            aria-labelledby="steam-game-comparison-tab-hourly" hidden={tab !== 'hourly'}>
            <StatisticsPanel title="時間帯別の平均同時接続数" headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
              <div className="win-rates-view-selector steam-player-count-comparison-controls" role="group" aria-label="折れ線の表示尺度">
                <button type="button" className="win-rates-button" aria-pressed={scale === 'people'} onClick={() => setScale('people')}>人数</button>
                <button type="button" className="win-rates-button" aria-pressed={scale === 'index'} onClick={() => setScale('index')}>各ゲーム平均＝100</button>
              </div>
              <SteamPlayerCountGameHourlyChart series={comparison.series} scale={scale} />
            </StatisticsPanel>
          </section>
          <section className="steam-player-count-panel" id="steam-game-comparison-panel-summary" role="tabpanel"
            aria-labelledby="steam-game-comparison-tab-summary" hidden={tab !== 'summary'}>
            <StatisticsPanel title={metric === 'mean' ? '期間平均の同時接続数' : '期間内の観測最大同時接続数'}
              headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
              <div className="win-rates-view-selector steam-player-count-comparison-controls" role="group" aria-label="棒グラフの集計値">
                <button type="button" className="win-rates-button" aria-pressed={metric === 'mean'} onClick={() => setMetric('mean')}>期間平均</button>
                <button type="button" className="win-rates-button" aria-pressed={metric === 'peak'} onClick={() => setMetric('peak')}>観測最大</button>
              </div>
              <SteamPlayerCountGameSummaryChart series={comparison.series} metric={metric} />
            </StatisticsPanel>
          </section>
          <section className="steam-player-count-panel" id="steam-game-comparison-panel-table" role="tabpanel"
            aria-labelledby="steam-game-comparison-tab-table" hidden={tab !== 'table'}>
            <StatisticsPanel title="時間帯別の集計" headerContent={<span className="monthly-statistics-panel-summary">{coverage}</span>}>
              <SteamPlayerCountGameComparisonTable comparison={comparison} />
            </StatisticsPanel>
          </section>
          <p className="steam-player-count-meta steam-player-count-basis">対象：全選択ゲームで1時間4区間がそろった日時・平均：日ごとに等重み
            {tab === 'hourly' && scale === 'index' ? '・指数の基準：ゲーム別の期間平均＝100' : ''}</p>
        </>}
    {state.entries.length > 0 && <dl className="steam-player-count-collection steam-player-count-game-updates">
      {state.entries.map(entry => {
        const latest = entry.publication.manifest.days.map(day => day.lastObservedAt).sort().at(-1)
        return <div key={entry.game.appId}><dt><a href={entry.game.sourceUrl} target="_blank" rel="noreferrer"
          aria-label={`${entry.game.label}の取得元（新しいタブ）`}>{steamPlayerCountGameLabel(entry.game.appId)}</a></dt>
          <dd>{latest ? <>最終観測 <time dateTime={latest}>{timestampLabel(latest)}</time></> : '未取得'}
            {entry.publication.source === 'bundled' ? '・同梱データ' : ''}
            {latest && Date.now() - Date.parse(latest) > 90 * 60 * 1000 ? '・90分以上更新なし' : ''}</dd></div>
      })}
    </dl>}
  </section>
}
