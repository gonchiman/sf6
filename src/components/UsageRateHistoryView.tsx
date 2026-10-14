import { useEffect, useMemo, useState } from 'react'
import { controlTypeBarStyle } from '../lib/controlTypeBarStyles'
import { timestampLabel } from '../lib/dateTime'
import {
  createCharacterUsageRateHistory, formatUsageRateHistoryPoint, usageRateHistoryRequestKey,
  type selectUsageRateHistoryConditions,
} from '../lib/usageRateHistory'
import {
  loadUsageRateHistory, usageRateCalendarMonths, USAGE_RATE_EDITION_LEAGUES, USAGE_RATE_EDITION_SOURCES,
} from '../lib/usageRates'
import { monthLabel } from '../lib/winRateHistory'
import type { UsageRateEdition, UsageRateHistoryResult, UsageRateManifest } from '../types/usageRates'
import { DataLoadState } from './DataLoadState'
import { MonthlyUsageRateTable } from './MonthlyUsageRateTable'
import { StatisticsPanel } from './StatisticsPanel'
import { UsageRateHistoryChart, UsageRateHistorySeriesKey } from './UsageRateHistoryChart'
import { usageRateLeagueLabel } from './controlTypeRatioFormatting'
import '../win-rate-history.css'
import '../usage-rate-history.css'

type Selection = NonNullable<ReturnType<typeof selectUsageRateHistoryConditions>>
type Character = { characterId: string; name: string }
type HistoryState =
  | { key: string; version: number; status: 'loading' }
  | { key: string; version: number; status: 'error' }
  | { key: string; version: number; status: 'ready'; results: UsageRateHistoryResult[] }

export function UsageRateHistoryPeriodFilters({ manifest, edition, selection, onChange }: {
  manifest: UsageRateManifest
  edition: UsageRateEdition
  selection: Selection | null
  onChange: (selection: Selection) => void
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

export function UsageRateHistoryView({ active, manifest, edition, selection, onSelectionChange,
  operationMode, character, characters, onCharacterChange }: {
  active: boolean
  manifest: UsageRateManifest
  edition: UsageRateEdition
  selection: Selection | null
  onSelectionChange: (selection: Selection) => void
  operationMode: 'combined' | 'separate'
  character: Character
  characters: readonly Character[]
  onCharacterChange: (characterId: string) => void
}) {
  const [state, setState] = useState<HistoryState | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const requestKey = selection ? usageRateHistoryRequestKey(manifest, selection) : null

  useEffect(() => {
    if (!active || !selection || !requestKey) return
    // Preserve the graph and the open table when returning to unchanged conditions.
    if (state?.key === requestKey && state.version === historyVersion && state.status === 'ready') return
    let current = true
    const key = requestKey
    setState({ key, version: historyVersion, status: 'loading' })
    void loadUsageRateHistory(manifest, selection).then(results => {
      if (current) setState({ key, version: historyVersion, status: 'ready', results })
    }).catch(() => { if (current) setState({ key, version: historyVersion, status: 'error' }) })
    return () => { current = false }
  }, [active, manifest, selection, requestKey, historyVersion])

  // The chosen character and operation mode only project these validated files.
  const currentState = state?.key === requestKey ? state : null
  const results = currentState?.status === 'ready' ? currentState.results : null
  const history = useMemo(() => selection && results
    ? createCharacterUsageRateHistory(manifest, selection, character, operationMode, results) : null,
  [manifest, selection, character, operationMode, results])
  const points = history?.series[0]?.points ?? []
  const effectiveSelectedMonth = selectedMonth && points.some(point => point.month === selectedMonth)
    ? selectedMonth : selectedMonth && points.length && selectedMonth < points[0].month ? points[0].month : points.at(-1)?.month ?? null
  const selectedIndex = points.findIndex(point => point.month === effectiveSelectedMonth)
  const selectedPoint = points[selectedIndex]
  const selectedValues = history?.series.map(series => ({ controlType: series.controlType, point: series.points[selectedIndex] })) ?? []
  const selectedValueText = selectedValues.map(item =>
    `${controlTypeBarStyle(item.controlType).label} ${item.point ? formatUsageRateHistoryPoint(item.point) : '未登録'}`).join('、')
  const failedCount = results?.filter(result => result.status === 'error').length ?? 0
  const source = selectedPoint?.source ?? (edition === 'general' ? manifest.source : USAGE_RATE_EDITION_SOURCES.master)
  const datasets = results?.flatMap(result => result.status === 'ready' ? [result.dataset] : []) ?? []
  const populations = [...new Set(datasets.map(dataset => dataset.source.population))]
  const metrics = [...new Set(datasets.map(dataset => dataset.source.metric))]
  const units = [...new Set(datasets.map(dataset => dataset.source.unit))]
  const notes = [...new Set(datasets.flatMap(dataset => dataset.source.notes))]
  const totalMismatches = history?.series.flatMap(series => series.points.flatMap(point => point.totalMismatch ? [{
    key: `${point.month}:${series.controlType}`,
    label: `${monthLabel(point.month)} ${usageRateLeagueLabel(selection!.league)}（${controlTypeBarStyle(series.controlType).label}）${(point.totalMismatch.observedPercentThousandths / 1000).toFixed(3)}%`,
    evidence: point.totalMismatch,
  }] : [])) ?? []
  const retry = () => setHistoryVersion(version => version + 1)

  if (!selection) return <DataLoadState message="選択した統計区分の使用率データが登録されていません。" />
  return <section className="usage-rate-history-view" aria-label="キャラクターの月別使用率">
    <StatisticsPanel title={`${character.name}の月別使用率`} headerContent={<div className="win-rates-chart-controls">
      <label className="win-rates-character-select"><span>キャラクター</span>
        <select aria-label="グラフのキャラクター" value={character.characterId}
          onChange={event => onCharacterChange(event.target.value)}>
          {!characters.some(item => item.characterId === character.characterId) &&
            <option value={character.characterId}>{character.name}</option>}
          {characters.map(item => <option key={item.characterId} value={item.characterId}>{item.name}</option>)}
        </select>
      </label>
      <label className="win-rates-character-select"><span>リーグ</span>
        <select aria-label="推移のリーグ" value={selection.league}
          onChange={event => onSelectionChange({ ...selection, league: event.target.value })}>
          {USAGE_RATE_EDITION_LEAGUES[edition].map(league => <option key={league} value={league}>{usageRateLeagueLabel(league)}</option>)}
        </select>
      </label>
    </div>}>
      {(!currentState || currentState.status === 'loading') && <DataLoadState loading message="月別の使用率を読み込み中…" />}
      {currentState?.status === 'error' && <DataLoadState message="月別の使用率を読み込めませんでした。" onRetry={retry} />}
      {history && effectiveSelectedMonth && <>
        {failedCount > 0 && <div className="win-rates-comparison-error" role="alert">
          <span>{points.length}か月中{failedCount}か月を読み込めませんでした。</span>
          <button type="button" className="win-rates-button" onClick={retry}>再読み込み</button>
        </div>}
        <UsageRateHistoryChart history={history} selectedMonth={effectiveSelectedMonth} onSelect={setSelectedMonth} />
        <div className="history-selected" aria-live="polite">
          <span>{monthLabel(effectiveSelectedMonth)}</span>
          <dl className="history-selected-values">{selectedValues.map(item => <div key={item.controlType}>
            <dt><UsageRateHistorySeriesKey controlType={item.controlType} />{controlTypeBarStyle(item.controlType).label}</dt>
            <dd><strong>{item.point ? formatUsageRateHistoryPoint(item.point) : '未登録'}</strong></dd>
          </div>)}</dl>
        </div>
        <label className="history-month-slider"><span>確認する月</span>
          <input type="range" min={0} max={Math.max(0, points.length - 1)} step={1} value={selectedIndex}
            disabled={points.length < 2} aria-label="確認する月" aria-valuetext={`${monthLabel(effectiveSelectedMonth)} ${selectedValueText}`}
            onChange={event => setSelectedMonth(points[Number(event.target.value)].month)} />
        </label>
      </>}
    </StatisticsPanel>
    {history && effectiveSelectedMonth && <>
      <details className="win-rates-details usage-rate-history-table" open={tableOpen}
        onToggle={event => setTableOpen(event.currentTarget.open)}>
        <summary>月別の使用率</summary>
        {tableOpen && <div className="usage-rate-history-table-body"><MonthlyUsageRateTable history={history}
          selectedMonth={effectiveSelectedMonth} onSelect={setSelectedMonth} /></div>}
      </details>
      {totalMismatches.length > 0 && <p className="win-rates-comparison-error" role="status">
        {`公開値の合計不一致：${totalMismatches.map(item => item.label).join('、')}。元の公表値を表示しています。`}
      </p>}
      <dl className="win-rates-source">
        <div><dt>対象期間</dt><dd>{monthLabel(selection.fromMonth)}〜{monthLabel(selection.toMonth)}</dd></div>
        {selectedPoint?.capturedAt && <div><dt>選択月の取得日時</dt><dd>
          <time dateTime={selectedPoint.capturedAt}>{timestampLabel(selectedPoint.capturedAt)}</time>
        </dd></div>}
        <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}
          <span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
      </dl>
      <details className="win-rates-details"><summary>データの範囲と表記</summary><div className="win-rates-details-content">
        <dl><div><dt>対象</dt><dd>{populations.join('、') || '未確認'}</dd></div>
          <div><dt>指標</dt><dd>{metrics.join('、') || '未確認'}</dd></div>
          <div><dt>単位</dt><dd>{units.join('、') || '未確認'}</dd></div></dl>
        <p>月別の公式使用率を、小数第3位までの保存された百分率で表示します。月や操作タイプの平均、合計100%への再正規化は行いません。</p>
        {edition === 'general' ? <p>合算は公式ALLの操作タイプ分布です。操作タイプ別はそれぞれのタイプ内でのキャラ使用率です。ALL（全体）は全リーグを対象とした公式の分布で、各リーグから合算した値ではありません。</p>
          : <p>マスター版は公式の4区分を表示し、操作タイプは合算のみです。</p>}
        <p>縦軸は0%から始まり、全ての公表値が収まる範囲を使います。数値のない月では線を切ります。「未掲載」「未登録」、公式の欠損表記「-」「-.---」、「読込失敗」を0%で補完しません。</p>
        {totalMismatches.length > 0 && <><p>合計不一致の確認記録</p><ul>{totalMismatches.map(item => <li key={item.key}>
          {item.label}：{item.evidence.reason}（確認日時：<time dateTime={item.evidence.verifiedAt}>{timestampLabel(item.evidence.verifiedAt)}</time>）。
          <a href={item.evidence.sourceUrl} target="_blank" rel="noreferrer">公式掲載ページ
            <span className="win-rates-visually-hidden">（新しいタブ）</span></a>
        </li>)}</ul></>}
        <div className="data-table-scroll win-rates-metadata-scroll" role="region" tabIndex={0} aria-label="月別の取得日時・スクロール領域">
          <table className="data-table win-rates-metadata-table"><caption className="win-rates-visually-hidden">月別の取得状態・取得日時・生成日時</caption>
            <thead><tr><th scope="col">対象月</th><th scope="col">状態</th><th scope="col">取得日時</th><th scope="col">生成日時</th></tr></thead>
            <tbody>{results?.map(result => <tr key={result.month}>
              <th scope="row">{monthLabel(result.month)}</th>
              <td>{result.status === 'ready' ? '取得済み' : result.status === 'error' ? '読込失敗' : '未登録'}</td>
              <td>{result.status === 'ready' ? <time dateTime={result.dataset.capturedAt}>{timestampLabel(result.dataset.capturedAt)}</time> : '—'}</td>
              <td>{result.status === 'ready' ? <time dateTime={result.dataset.generatedAt}>{timestampLabel(result.dataset.generatedAt)}</time> : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {notes.length > 0 && <><p>保存データの注記</p><ul>{notes.map(note => <li key={note}>{note}</li>)}</ul></>}
      </div></details>
    </>}
  </section>
}
