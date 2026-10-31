import { useEffect, useId, useMemo, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { leagueLabel } from '../lib/winRateConditions'
import { loadWinRateManifest } from '../lib/winRates'
import { loadUsageRateManifest } from '../lib/usageRates'
import { monthLabel } from '../lib/winRateHistory'
import {
  correlationHistoryRequestKey, correlationMonths, createCorrelationHistory, loadCorrelationHistory,
} from '../lib/winUsageCorrelation'
import { correlationPageCalendars, initialCorrelationPageState, updateCorrelationPageState } from '../lib/correlationPageSelection'
import {
  createLeagueCorrelationRows, leagueCorrelationRequestKey, loadLeagueCorrelationComparison,
} from '../lib/leagueWinUsageCorrelation'
import type { LeagueCorrelationResults, LeagueCorrelationRow } from '../lib/leagueWinUsageCorrelation'
import type { WinRateManifest } from '../types/winRates'
import type { UsageRateManifest } from '../types/usageRates'
import type { MonthlyLineChartSeries } from '../types/monthlyLineChart'
import type {
  CorrelationExclusionReason, CorrelationHistoryResults, CorrelationPoint, CorrelationRow,
} from '../types/winUsageCorrelation'
import { DataLoadState } from './DataLoadState'
import { ContentTabs } from './ContentTabs'
import { MonthlyLineChart } from './MonthlyLineChart'
import { StatisticsPanel } from './StatisticsPanel'
import { WinUsageScatterChart } from './WinUsageScatterChart'
import '../win-rates.css'
import '../win-rate-history.css'
import '../table.css'
import '../win-usage-correlation.css'

type Manifests = { win: WinRateManifest; usage: UsageRateManifest }
type Bootstrap = { status: 'loading' | 'error' } | ({ status: 'ready' } & Manifests)
type Loaded = { key: string; version: number } & (
  { status: 'loading' | 'error' } | { status: 'ready'; results: CorrelationHistoryResults }
)
type LeagueLoaded = { key: string; version: number } & (
  { status: 'loading' | 'error' } | { status: 'ready'; results: LeagueCorrelationResults }
)
type Metric = 'pearson' | 'spearman'
type Tab = 'month' | 'history'
type PageState = ReturnType<typeof initialCorrelationPageState>
type PagePatch = Parameters<typeof updateCorrelationPageState>[2]
type Calendars = ReturnType<typeof correlationPageCalendars>
const CONTROL_LABELS = { combined: '合算', classic: 'クラシック', modern: 'モダン' } as const
const EXCLUSION_LABELS: Record<CorrelationExclusionReason, string> = {
  'win-unlisted': '勝率未掲載', 'usage-unlisted': '使用率未掲載', 'win-missing': '勝率欠損',
  'usage-missing': '使用率欠損', 'low-sample': '少数サンプル', 'non-common': '期間の共通対象外',
}
const AXIS = { start: -1, end: 1, ticks: [-1, -0.5, 0, 0.5, 1] }
const coefficientLabel = (value: number | null) => value === null ? '—' : (Math.abs(value) < 0.0005 ? 0 : value).toFixed(3)
const unavailableLabel = (row: CorrelationRow) => row.status === 'error' ? 'データを読み込めませんでした。'
  : row.status === 'unavailable' ? '勝率と使用率の両方のデータが揃っていません。'
    : row.status === 'incomplete' ? '期間内のデータが揃っていないため、共通キャラを確認できません。' : ''
const coefficientReason = (row: CorrelationRow) => row.unavailableReason === 'insufficient-characters' ? '対象が3キャラ未満のため相関係数を表示できません。'
  : row.unavailableReason === 'constant-win-rate' ? '勝率がすべて同じため相関係数を算出できません。'
    : row.unavailableReason === 'constant-usage-rate' ? '使用率がすべて同じため相関係数を算出できません。' : ''

function CorrelationTabs({ id, value, onChange }: { id: string; value: Tab; onChange: (value: Tab) => void }) {
  return <ContentTabs id={id} label="相関の表示" className="correlation-tabs"
    options={[[ 'month', '対象月' ], [ 'history', '期間推移' ]]} value={value} onChange={onChange} />
}

function ConditionInputs({ state, calendars, view, metric, onMetricChange, onChange }: {
  state: PageState; calendars: Calendars; view: Tab; metric: Metric
  onMetricChange: (metric: Metric) => void; onChange: (patch: PagePatch) => void
}) {
  const { selection, selectedMonth, mode } = state
  const calendar = calendars.find(item => item.edition === selection.edition && item.controlType === selection.controlType)!
  const editions = [...new Set(calendars.map(item => item.edition))]
  const controls = calendars.filter(item => item.edition === selection.edition).map(item => item.controlType)
  const monthOptions = mode === 'common' ? correlationMonths(selection) : calendar.months
  return <div className="win-rates-filters correlation-filters">
    <label><span>統計</span><select aria-label="統計" value={selection.edition} onChange={event => onChange({ edition: event.target.value as PagePatch['edition'] })}>
      {editions.map(edition => <option key={edition} value={edition}>{edition === 'general' ? '総合版' : 'マスター版'}</option>)}
    </select></label>
    <label><span>操作タイプ</span>{controls.length > 1 ? <select aria-label="操作タイプ" value={selection.controlType} onChange={event => onChange({ controlType: event.target.value as PagePatch['controlType'] })}>
      {controls.map(control => <option key={control} value={control}>{CONTROL_LABELS[control]}</option>)}
    </select> : <span className="correlation-fixed-control">{CONTROL_LABELS[selection.controlType]}</span>}</label>
    {view === 'month' ? <label><span>対象月</span><select aria-label="対象月" value={selectedMonth} onChange={event => onChange({ selectedMonth: event.target.value })}>
      {monthOptions.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
    </select></label> : <label><span>ランク</span><select aria-label="ランク" value={selection.league} onChange={event => onChange({ league: event.target.value })}>
      {calendar.leagues.map(league => <option key={league} value={league}>{leagueLabel(league)}</option>)}
    </select></label>}
    <label><span>集計対象</span><select aria-label="集計対象" value={mode} onChange={event => onChange({ mode: event.target.value as PagePatch['mode'] })}>
      <option value="monthly">各月に両方の値があるキャラ</option><option value="common">選択期間の共通キャラ</option>
    </select></label>
    {(view === 'history' || mode === 'common') && <>
      <label><span>開始月</span><select aria-label="開始月" value={selection.fromMonth} onChange={event => onChange({ fromMonth: event.target.value })}>
        {calendar.months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
      </select></label>
      <label><span>終了月</span><select aria-label="終了月" value={selection.toMonth} onChange={event => onChange({ toMonth: event.target.value })}>
        {calendar.months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
      </select></label>
    </>}
    {view === 'history' && <label><span>指標</span><select aria-label="相関係数" value={metric} onChange={event => onMetricChange(event.target.value as Metric)}>
      <option value="pearson">Pearson</option><option value="spearman">Spearman</option>
    </select></label>}
  </div>
}

function CharacterTable({ points }: { points: readonly CorrelationPoint[] }) {
  const [sort, setSort] = useState<{ key: 'name' | 'winRate' | 'usageRate'; ascending: boolean }>({ key: 'usageRate', ascending: false })
  const rows = useMemo(() => [...points].sort((a, b) => {
    const value = sort.key === 'name' ? a.name.localeCompare(b.name, 'ja') : a[sort.key] - b[sort.key]
    return (sort.ascending ? value : -value) || a.characterId.localeCompare(b.characterId)
  }), [points, sort])
  return <div className="data-table-scroll correlation-character-scroll" role="region" tabIndex={0} aria-label="キャラ別の勝率と使用率・スクロール領域">
    <table className="data-table correlation-character-table">
      <caption className="win-rates-visually-hidden">同じ月・リーグ・操作タイプで両方の値があるキャラ</caption>
      <thead><tr>{([{ key: 'name', label: 'キャラ' }, { key: 'winRate', label: '勝率（%）' }, { key: 'usageRate', label: '使用率（%）' }] as const).map(item => <th key={item.key} scope="col"
        aria-sort={sort.key === item.key ? sort.ascending ? 'ascending' : 'descending' : 'none'}>
        <button className="correlation-sort" type="button" onClick={() => setSort({ key: item.key, ascending: sort.key === item.key ? !sort.ascending : item.key === 'name' })}>
          {item.label}{sort.key === item.key ? sort.ascending ? ' ↑' : ' ↓' : ''}
        </button>
      </th>)}</tr></thead>
      <tbody>{rows.map(point => <tr key={point.characterId}><th scope="row">{point.name}</th><td>{point.winRate.toFixed(2)}</td><td>{point.usageRate.toFixed(3)}</td></tr>)}</tbody>
    </table>
  </div>
}

function LeagueTable({ rows, selectedLeague, onSelect }: {
  rows: readonly LeagueCorrelationRow[]; selectedLeague: string; onSelect: (league: string) => void
}) {
  const hasNotes = rows.some(({ row }) => row.status !== 'ready' || row.unavailableReason
    || row.exclusions.length > 0 || row.usageTotalMismatch)
  const signedCoefficient = (value: number | null) => {
    const label = coefficientLabel(value)
    return value !== null && value >= 0.0005 ? `+${label}` : label
  }
  return <div className="data-table-scroll correlation-league-scroll" role="region" tabIndex={0} aria-label="ランク別の相関係数・スクロール領域">
    <table className="data-table correlation-league-table">
      <caption className="win-rates-visually-hidden">各ランク内のキャラ間で求めた勝率と使用率の相関係数</caption>
      <thead><tr><th scope="col">ランク</th><th scope="col">Pearson r</th><th scope="col">Spearman ρ</th><th scope="col">対象キャラ数</th>{hasNotes && <th scope="col">状態</th>}</tr></thead>
      <tbody>{rows.map(({ league, row }) => <tr key={league} className={league === selectedLeague ? 'is-selected' : undefined}>
        <th scope="row"><button type="button" className="correlation-month-button" aria-pressed={league === selectedLeague} onClick={() => onSelect(league)}>{leagueLabel(league)}</button></th><td>{signedCoefficient(row.pearson)}</td><td>{signedCoefficient(row.spearman)}</td><td>{row.status === 'ready' ? row.points.length : '—'}</td>
        {hasNotes && <td className="correlation-league-notes">
          {row.status !== 'ready' ? unavailableLabel(row) : <>
            {row.unavailableReason && <span>{coefficientReason(row)}</span>}
            {row.usageTotalMismatch && <span>使用率の掲載値合計：{row.usagePublishedTotal?.toFixed(3)}%</span>}
            {row.exclusions.length > 0 && <details><summary>除外{row.exclusions.length}キャラ</summary><ul>{row.exclusions.map(item => <li key={item.characterId}>{item.name}：{item.reasons.map(reason => EXCLUSION_LABELS[reason]).join('、')}</li>)}</ul></details>}
          </>}
        </td>}
      </tr>)}</tbody>
    </table>
  </div>
}

export function WinUsageCorrelationPage() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [page, setPage] = useState<PageState | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadVersion, setLoadVersion] = useState(0)
  const [leagueLoaded, setLeagueLoaded] = useState<LeagueLoaded | null>(null)
  const [leagueLoadVersion, setLeagueLoadVersion] = useState(0)
  const [metric, setMetric] = useState<Metric>('pearson')
  const [showNames, setShowNames] = useState(false)
  const [tab, setTab] = useState<Tab>('month')
  const id = useId()

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void Promise.all([loadWinRateManifest(), loadUsageRateManifest()]).then(([win, usage]) => {
      if (!current) return
      setPage(initialCorrelationPageState(correlationPageCalendars(win, usage)))
      setBootstrap({ status: 'ready', win, usage })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [bootstrapVersion])

  const manifests = bootstrap.status === 'ready' ? bootstrap : null
  const calendars = useMemo(() => manifests ? correlationPageCalendars(manifests.win, manifests.usage) : [], [manifests])
  const selection = page?.selection ?? null
  const mode = page?.mode ?? 'monthly'
  const month = page?.selectedMonth ?? null
  const requestKey = manifests && selection ? correlationHistoryRequestKey(manifests.win, manifests.usage, selection) : null
  const historyQuery = useMemo(() => manifests && selection && requestKey
    ? { ...manifests, selection, key: requestKey } : null, [manifests, requestKey])
  useEffect(() => {
    if (!historyQuery) return
    let current = true
    const { win, usage, selection, key } = historyQuery
    setLoaded({ key, version: loadVersion, status: 'loading' })
    void loadCorrelationHistory(win, usage, selection).then(results => {
      if (current) setLoaded({ key, version: loadVersion, status: 'ready', results })
    }).catch(() => { if (current) setLoaded({ key, version: loadVersion, status: 'error' }) })
    return () => { current = false }
  }, [historyQuery, loadVersion])

  const leagueRequestKey = manifests && selection && month
    ? leagueCorrelationRequestKey(manifests.win, manifests.usage, selection, month, mode) : null
  // The key covers all comparison inputs, so changing only the detail league retains the table.
  const leagueQuery = useMemo(() => manifests && selection && month && leagueRequestKey
    ? { ...manifests, selection, month, mode, key: leagueRequestKey } : null, [manifests, leagueRequestKey])
  useEffect(() => {
    if (!leagueQuery) return
    let current = true
    const { win, usage, selection, month, mode, key } = leagueQuery
    setLeagueLoaded({ key, version: leagueLoadVersion, status: 'loading' })
    void loadLeagueCorrelationComparison(win, usage, selection, month, mode).then(results => {
      if (current) setLeagueLoaded({ key, version: leagueLoadVersion, status: 'ready', results })
    }).catch(() => { if (current) setLeagueLoaded({ key, version: leagueLoadVersion, status: 'error' }) })
    return () => { current = false }
  }, [leagueQuery, leagueLoadVersion])
  const currentLeagues = leagueLoaded?.key === leagueRequestKey && leagueLoaded.version === leagueLoadVersion ? leagueLoaded : null
  const leagueResults = currentLeagues?.status === 'ready' ? currentLeagues.results : null
  const leagueRows = useMemo(() => leagueQuery && leagueResults
    ? createLeagueCorrelationRows(leagueQuery.win, leagueQuery.usage, leagueQuery.selection, leagueQuery.month, leagueResults, leagueQuery.mode) : null,
  [leagueQuery, leagueResults])

  const current = loaded?.key === requestKey && loaded.version === loadVersion ? loaded : null
  const readyResults = current?.status === 'ready' ? current.results : null
  const history = useMemo(() => manifests && selection && readyResults
    ? createCorrelationHistory(manifests.win, manifests.usage, selection, readyResults, mode) : null,
  [manifests, selection, readyResults, mode])
  const rows = history?.rows ?? []
  // The single-month view remains usable when its month is outside the trend period.
  const row = leagueRows?.find(item => item.league === selection?.league)?.row ?? null
  const historyRow = rows.find(row => row.month === month) ?? null
  const sourceRow = tab === 'month' ? row : historyRow ?? rows.at(-1) ?? null
  const series = useMemo<MonthlyLineChartSeries[]>(() => [{ id: metric, label: metric === 'pearson' ? 'Pearson' : 'Spearman',
    points: rows.map(row => ({ month: row.month, value: row[metric] })), style: { color: 'var(--text-soft)', marker: 'circle' } }], [rows, metric])

  if (bootstrap.status === 'loading') return <DataLoadState loading message="勝率と使用率の条件を読み込み中…" />
  if (!manifests || !page || !selection || !month) return <DataLoadState message="勝率と使用率の条件を読み込めませんでした。" onRetry={() => setBootstrapVersion(value => value + 1)} />
  const change = (patch: PagePatch) => setPage(current => current ? updateCorrelationPageState(calendars, current, patch) : current)
  const selectMonth = (selectedMonth: string) => change({ selectedMonth })
  const retry = () => { setLoadVersion(value => value + 1); setLeagueLoadVersion(value => value + 1) }
  const failed = rows.filter(row => row.status === 'error')
  const leagueFailures = leagueResults && Object.values(leagueResults).some(results => results
    && (results.winResults.some(result => result.status === 'error') || results.usageResults.some(result => result.status === 'error')))
  const metricName = metric === 'pearson' ? 'Pearson' : 'Spearman'
  const historyLoadingState = current?.status === 'error'
    ? <DataLoadState message="勝率と使用率を読み込めませんでした。" onRetry={retry} />
    : <DataLoadState loading message="月別の勝率と使用率を読み込み中…" />
  const monthLoadingState = currentLeagues?.status === 'error'
    ? <DataLoadState message="ランク別の勝率と使用率を読み込めませんでした。" onRetry={retry} />
    : <DataLoadState loading message="ランク別の相関係数を読み込み中…" />

  return <section className="win-usage-correlation-page" aria-label="勝率と使用率の相関">
    <CorrelationTabs id={id} value={tab} onChange={setTab} />
    <div className="correlation-tab-panel" id={`${id}-panel-month`} role="tabpanel" aria-labelledby={`${id}-tab-month`} hidden={tab !== 'month'}>
      <StatisticsPanel title="対象月の比較">
        <ConditionInputs state={page} calendars={calendars} view="month" metric={metric} onMetricChange={setMetric} onChange={change} />
        <div className="correlation-month-content">
          <section aria-labelledby={`${id}-ranks`}>
            <h3 id={`${id}-ranks`} className="correlation-subheading">ランク別の相関係数</h3>
            {leagueRows ? <>
              <LeagueTable rows={leagueRows} selectedLeague={selection.league} onSelect={league => change({ league })} />
              {leagueFailures && <div className="history-load-error" role="alert"><span>一部のランクのデータを読み込めませんでした。</span><button className="win-rates-button" type="button" onClick={retry}>再読み込み</button></div>}
            </> : monthLoadingState}
          </section>
          <section className="correlation-detail" aria-labelledby={`${id}-detail`}>
            <div className="correlation-detail-heading"><h3 id={`${id}-detail`}>{leagueLabel(selection.league)}の詳細</h3><span className="correlation-panel-summary">{monthLabel(month)}</span></div>
            {!row ? monthLoadingState : row.status !== 'ready' ? <div className="correlation-message" role="status">{unavailableLabel(row)}</div> : <>
              <dl className="correlation-summary" aria-live="polite">
                <div><dt>Pearson r</dt><dd>{coefficientLabel(row.pearson)}</dd></div>
                <div><dt>Spearman ρ</dt><dd>{coefficientLabel(row.spearman)}</dd></div>
                <div><dt>対象／掲載</dt><dd>{row.points.length}／{row.listedCount} キャラ</dd></div>
              </dl>
              {row.unavailableReason && <div className="correlation-message" role="status">{coefficientReason(row)}</div>}
              {row.usageTotalMismatch && <div className="correlation-message" role="status">使用率の掲載値合計：{row.usagePublishedTotal?.toFixed(3)}%</div>}
              <div className="correlation-detail-grid">
                <section aria-labelledby={`${id}-scatter`}>
                  <div className="correlation-detail-heading"><h3 id={`${id}-scatter`}>散布図</h3><label className="correlation-check"><input type="checkbox" checked={showNames} onChange={event => setShowNames(event.target.checked)} /><span>キャラ名</span></label></div>
                  {tab === 'month' && <WinUsageScatterChart points={row.points} showNames={showNames} />}
                </section>
                <section aria-labelledby={`${id}-characters`}>
                  <h3 id={`${id}-characters`} className="correlation-subheading">キャラ別の数値</h3>
                  {row.points.length ? <CharacterTable points={row.points} /> : <div className="correlation-message">両方の値が揃うキャラがありません。</div>}
                </section>
              </div>
            </>}
          </section>
        </div>
      </StatisticsPanel>
    </div>

    <div className="correlation-tab-panel" id={`${id}-panel-history`} role="tabpanel" aria-labelledby={`${id}-tab-history`} hidden={tab !== 'history'}>
      <StatisticsPanel title={`${leagueLabel(selection.league)}の相関係数の推移`}>
        <ConditionInputs state={page} calendars={calendars} view="history" metric={metric} onMetricChange={setMetric} onChange={change} />
        <div className="correlation-history-content">
          {failed.length > 0 && <div className="history-load-error" role="alert"><span>読み込めなかった月：{failed.map(row => monthLabel(row.month)).join('、')}</span><button className="win-rates-button" type="button" onClick={retry}>再読み込み</button></div>}
          {mode === 'common' && history?.commonUnavailable && <div className="correlation-message" role="status">期間内のデータが揃っていないため、共通キャラの相関を算出できません。</div>}
          {!history ? historyLoadingState : <>
            {tab === 'history' && <MonthlyLineChart series={series} selectedMonth={month} onSelect={selectMonth}
              title={`${leagueLabel(selection.league)}の${metricName}相関係数の月別推移`}
              description="各月のキャラ間の勝率と使用率の相関係数。縦軸は−1から1で、欠損月・計算できない月は線をつなぎません。選択月は散布図と連動します。"
              regionLabel="相関係数の推移グラフ" axisLabel="相関係数" axis={AXIS} formatTick={value => value.toFixed(1)}
              valueLabel={(_, selected) => coefficientLabel(rows.find(row => row.month === selected)?.[metric] ?? null)}
              reference={{ value: 0, label: '' }} />}
            {historyRow && <div className="correlation-selected-month" aria-live="polite">{monthLabel(month)}　{metricName} {coefficientLabel(historyRow[metric])}</div>}
            <details className="win-rates-details correlation-history-values"><summary>月別の相関係数</summary><div className="win-rates-details-content">
              <div className="data-table-scroll correlation-month-scroll" role="region" tabIndex={0} aria-label="月別の相関係数・スクロール領域"><table className="data-table correlation-month-table">
                <thead><tr><th scope="col">対象月</th><th scope="col">Pearson r</th><th scope="col">Spearman ρ</th><th scope="col">対象キャラ数</th><th scope="col">状態</th></tr></thead>
                <tbody>{rows.map(item => <tr key={item.month} className={item.month === month ? 'is-selected' : undefined}><th scope="row"><button type="button" className="correlation-month-button" aria-pressed={item.month === month} onClick={() => selectMonth(item.month)}>{monthLabel(item.month)}</button></th>
                  <td>{coefficientLabel(item.pearson)}</td><td>{coefficientLabel(item.spearman)}</td><td>{item.status === 'ready' ? item.points.length : '—'}</td><td>{item.status === 'ready' ? item.unavailableReason ? '算出不可' : '取得済み' : item.status === 'error' ? '読込失敗' : item.status === 'incomplete' ? '共通対象未確定' : '未登録'}</td></tr>)}</tbody>
              </table></div>
            </div></details>
          </>}
        </div>
      </StatisticsPanel>
    </div>

      <details className="win-rates-details"><summary>計算方法・見方</summary><div className="win-rates-details-content">
        <p>同じ月・統計・リーグ・操作タイプで、各キャラの公式Total換算値と公式使用率を1組として同じ重みで計算します。Totalの5.058は50.58%、使用率の保存値9566は9.566%です。計算後に相関係数を小数第3位へ丸めます。</p>
        <p>Pearsonは値の直線的な関係、Spearmanは順位の関係を表します。同順位には平均順位を使います。−1は逆向き、1は同じ向きの関係で、0はそれぞれの方法での相関がない状態です。対象が3キャラ未満、またはどちらかの値がすべて同じ場合は「—」です。</p>
        <p>推移は各月のキャラ間の相関です。1キャラの月ごとの勝率と使用率の相関ではありません。「選択期間の共通キャラ」は全月に有効な両方の値がある同じキャラだけを使います。選択月を含む期間に未登録・読込失敗がある場合、共通キャラの係数は算出しません。</p>
        <p>ランク別の表は対象月・統計・操作タイプを揃え、各ランク内のキャラ間で計算します。「選択期間の共通キャラ」はランクごとに適用するため、対象キャラの集合はランク間で一致するとは限りません。表のランク選択は散布図・推移・キャラ別の数値に適用されます。</p>
        <p>欠損・片方に未掲載・少数サンプルのキャラを除外し、0%で補いません。実際の0%は含めます。使用率を100%へ再正規化せず、操作タイプやリーグ同士の割合も合算しません。使用率のALL（全体）に対応する勝率がないため、リーグ別に比較します。</p>
        <p>使用件数・試合数の分母、勝率Totalの厳密な算出方法、ミラー戦・引き分け・切断の扱いは取得データから確認できません。信頼区間や有意差は表示せず、相関からキャラの絶対的な強さや因果関係は判断しません。</p>
      </div></details>
      <details className="win-rates-details"><summary>除外状況・出典</summary><div className="win-rates-details-content">
        <dl className="win-rates-source">
          <div><dt>対象条件</dt><dd>{selection.edition === 'general' ? '総合版' : 'マスター版'}・{leagueLabel(selection.league)}・{CONTROL_LABELS[selection.controlType]}</dd></div>
          <div><dt>{tab === 'month' && mode === 'monthly' ? '対象月' : '対象期間'}</dt><dd>{tab === 'month' && mode === 'monthly' ? monthLabel(month) : `${monthLabel(selection.fromMonth)}〜${monthLabel(selection.toMonth)}`}</dd></div>
          <div><dt>集計対象</dt><dd>{mode === 'monthly' ? '各月に両方の値があるキャラ' : '選択期間の共通キャラ'}</dd></div>
          <div><dt>一覧生成日時</dt><dd>勝率：{timestampLabel(manifests.win.generatedAt)}<br />使用率：{timestampLabel(manifests.usage.generatedAt)}</dd></div>
          <div><dt>データ形式</dt><dd>勝率 Version {manifests.win.schemaVersion}／使用率 Version {manifests.usage.schemaVersion}</dd></div>
        </dl>
        {sourceRow && <>
          <dl className="win-rates-source"><div><dt>{tab === 'history' ? '出典対象月' : '対象月'}</dt><dd>{monthLabel(sourceRow.month)}</dd></div>
            <div><dt>対象／掲載</dt><dd>{sourceRow.status === 'ready' ? sourceRow.points.length : '—'}／{sourceRow.listedCount ?? '—'} キャラ</dd></div>
            {([{ key: 'win', label: '勝率', source: sourceRow.winSource, captured: sourceRow.winCapturedAt, generated: sourceRow.winGeneratedAt }, { key: 'usage', label: '使用率', source: sourceRow.usageSource, captured: sourceRow.usageCapturedAt, generated: sourceRow.usageGeneratedAt }] as const).map(item => <div key={item.key}><dt>{item.label}の出典・取得日時</dt><dd>{item.source ? <a href={item.source.url} target="_blank" rel="noreferrer">{item.source.title}</a> : '—'}<br />{item.captured ? timestampLabel(item.captured) : '—'}<br />生成：{item.generated ? timestampLabel(item.generated) : '—'}</dd></div>)}
            <div><dt>使用率の掲載値合計</dt><dd>{sourceRow.usagePublishedTotal === null ? '—' : `${sourceRow.usagePublishedTotal.toFixed(3)}%`}{sourceRow.usageTotalMismatch ? '（公式値の合計不一致を確認済み）' : ''}</dd></div>
          </dl>
          {sourceRow.usageTotalMismatch && <p>{sourceRow.usageTotalMismatch.reason} 確認：{timestampLabel(sourceRow.usageTotalMismatch.verifiedAt)}</p>}
          {sourceRow.status !== 'ready' && <p>{unavailableLabel(sourceRow)} 勝率：{sourceRow.winStatus === 'ready' ? '取得済み' : sourceRow.winStatus === 'error' ? '読込失敗' : '未登録'}／使用率：{sourceRow.usageStatus === 'ready' ? '取得済み' : sourceRow.usageStatus === 'error' ? '読込失敗' : '未登録'}</p>}
          {sourceRow.exclusions.length > 0 ? <div className="data-table-scroll" role="region" tabIndex={0} aria-label="除外キャラ・スクロール領域"><table className="data-table"><thead><tr><th scope="col">キャラ</th><th scope="col">除外理由</th></tr></thead><tbody>{sourceRow.exclusions.map(item => <tr key={item.characterId}><th scope="row">{item.name}</th><td>{item.reasons.map(reason => EXCLUSION_LABELS[reason]).join('、')}</td></tr>)}</tbody></table></div> : sourceRow.status === 'ready' && <p>除外キャラはありません。</p>}
        </>}
      </div></details>
  </section>
}
