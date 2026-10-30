import { useEffect, useId, useMemo, useState } from 'react'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { ADJUSTMENT_ANALYSIS_CATEGORIES, analyzeBalanceAdjustmentPatch, filterAdjustmentAnalysisRows } from '../lib/balanceAdjustmentAnalysis'
import { balanceAdjustmentPatchDetails, loadBalanceAdjustmentDetails } from '../lib/balanceAdjustmentDetails'
import { loadBalanceAdjustmentCatalog } from '../lib/balanceAdjustments'
import { loadCharacterManifest } from '../lib/characters'
import { timestampLabel } from '../lib/dateTime'
import { balanceAdjustmentDetailHash } from '../lib/routes'
import type { AdjustmentAnalysisFilters, AdjustmentAnalysisRow } from '../types/balanceAdjustmentAnalysis'
import type { BalanceAdjustmentCatalog } from '../types/balanceAdjustments'
import type { BalanceAdjustmentDetailsCatalog } from '../types/balanceAdjustmentDetails'
import { balanceAdjustmentDateLabel, COMMON_ADJUSTMENT_SCOPE } from './BalanceAdjustmentTable'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import '../table.css'
import '../win-rates.css'
import '../balance-adjustment-analysis.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; history: BalanceAdjustmentCatalog; details: BalanceAdjustmentDetailsCatalog }

const INITIAL_FILTERS: AdjustmentAnalysisFilters = { subjectId: 'all', categoryId: 'all', status: 'all' }

export function BalanceAdjustmentAnalysisPage() {
  const sourcePanelId = useId()
  const tableId = useId()
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [loadVersion, setLoadVersion] = useState(0)
  const [eventId, setEventId] = useState<string | null>(null)
  const [filters, setFilters] = useState<AdjustmentAnalysisFilters>(INITIAL_FILTERS)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setLoadState({ status: 'loading' })
    void Promise.all([loadBalanceAdjustmentCatalog(), loadCharacterManifest()])
      .then(async ([history, manifest]) => ({ history, details: await loadBalanceAdjustmentDetails(history, manifest) }))
      .then(({ history, details }) => { if (current) setLoadState({ status: 'ready', history, details }) })
      .catch(() => { if (current) setLoadState({ status: 'error' }) })
    return () => { current = false }
  }, [loadVersion])

  const events = useMemo(() => loadState.status === 'ready'
    ? [...loadState.history.events].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)) : [], [loadState])
  const event = events.find(item => item.id === eventId) ?? events[0] ?? null
  const patch = loadState.status === 'ready' && event ? balanceAdjustmentPatchDetails(loadState.details, event) : null
  const analysis = useMemo(() => patch ? analyzeBalanceAdjustmentPatch(patch) : null, [patch])
  const subjects = useMemo(() => {
    const found = new Map<string, string>()
    for (const row of analysis?.rows ?? []) found.set(row.subjectId, row.subjectName)
    return [...found].map(([id, name]) => ({ id, name }))
  }, [analysis])
  const effectiveFilters = subjects.some(subject => subject.id === filters.subjectId) || filters.subjectId === 'all'
    ? filters : { ...filters, subjectId: 'all' }
  const visibleRows = useMemo(() => filterAdjustmentAnalysisRows(analysis?.rows ?? [], effectiveFilters),
    [analysis, effectiveFilters.subjectId, effectiveFilters.categoryId, effectiveFilters.status])
  const selected = visibleRows.find(row => row.id === selectedId) ?? visibleRows[0] ?? null
  const unclassifiedCount = visibleRows.filter(row => row.status === 'unclassified').length

  const changeFilter = (next: Partial<AdjustmentAnalysisFilters>) => {
    setFilters(previous => ({ ...previous, ...next }))
    setSelectedId(null)
  }

  if (loadState.status !== 'ready') return <section className="balance-adjustment-analysis-page" aria-label="バトル変更分析">
    <StatisticsPanel title="条件">
      {loadState.status === 'loading'
        ? <DataLoadState loading message="バトル変更データを読み込み中…" />
        : <DataLoadState message="バトル変更データを読み込めませんでした。" onRetry={() => setLoadVersion(version => version + 1)} />}
    </StatisticsPanel>
  </section>

  return <section className="balance-adjustment-analysis-page" aria-label="バトル変更分析">
    <StatisticsPanel title="条件" headerContent={analysis && <span className="monthly-statistics-panel-summary">
      公式{analysis.sourceRowCount}行・分解{analysis.rows.length}件
    </span>}>
      <div className="win-rates-filters balance-adjustment-analysis-filters">
        <label><span>バトル変更日</span><select aria-label="バトル変更日" value={event?.id ?? ''} disabled={events.length === 0}
          onChange={change => { setEventId(change.target.value); setFilters(INITIAL_FILTERS); setSelectedId(null) }}>
          {events.length === 0 ? <option value="">履歴なし</option>
            : events.map(item => <option key={item.id} value={item.id}>{balanceAdjustmentDateLabel(item)}</option>)}
        </select></label>
        <label><span>対象</span><select aria-label="対象" aria-controls={tableId} disabled={!analysis} value={effectiveFilters.subjectId}
          onChange={change => changeFilter({ subjectId: change.target.value })}>
          <option value="all">すべて</option>
          {subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
        </select></label>
        <label><span>変更要素</span><select aria-label="変更要素" aria-controls={tableId} disabled={!analysis} value={filters.categoryId}
          onChange={change => changeFilter({ categoryId: change.target.value as AdjustmentAnalysisFilters['categoryId'] })}>
          <option value="all">すべて</option>
          {ADJUSTMENT_ANALYSIS_CATEGORIES.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}
        </select></label>
        <label><span>分類状況</span><select aria-label="分類状況" aria-controls={tableId} disabled={!analysis} value={filters.status}
          onChange={change => changeFilter({ status: change.target.value as AdjustmentAnalysisFilters['status'] })}>
          <option value="all">すべて</option><option value="candidate">分類候補あり</option><option value="unclassified">未分類</option>
        </select></label>
      </div>
    </StatisticsPanel>

    <StatisticsPanel title="分類一覧" headerContent={analysis && <span className="monthly-statistics-panel-summary" aria-live="polite">
      表示{visibleRows.length}件・未分類{unclassifiedCount}件
    </span>}>
      {!event ? <DataLoadState message="バトル変更履歴がありません。" />
        : !analysis ? <DataLoadState message="選択した日付の変更内容は未取込です。" />
          : <AdjustmentAnalysisTable rows={visibleRows} selectedId={selected?.id ?? null} tableId={tableId}
            sourcePanelId={sourcePanelId} onSelect={setSelectedId} />}
    </StatisticsPanel>

    <StatisticsPanel id={sourcePanelId} title="原文" headerContent={selected && <span className="monthly-statistics-panel-summary">
      {selected.status === 'candidate' ? '分類候補' : '未分類'}
    </span>}>
      {selected && patch && event ? <div className="balance-adjustment-analysis-source" aria-live="polite">
        <h3>{selected.subjectName} · {selected.target || '変更箇所の記載なし'}</h3>
        <p className="balance-adjustment-analysis-description"><HighlightedDescription row={selected} /></p>
        <dl className="balance-adjustment-analysis-facts">
          <dt>公式分類</dt><dd>{selected.officialCategoryLabel || '記載なし'}</dd>
          <dt>変更要素</dt><dd>{ADJUSTMENT_ANALYSIS_CATEGORIES.find(category => category.id === selected.categoryId)?.label ?? '未分類'} · {selected.elementLabel}</dd>
          <dt>条件</dt><dd>{selected.condition ?? '未抽出'}</dd>
          <dt>変更前</dt><dd>{selected.beforeValue ?? '未抽出'}</dd>
          <dt>変更後</dt><dd>{selected.afterValue ?? '未抽出'}</dd>
          <dt>増減量</dt><dd>{selected.deltaValue ?? '未抽出'}</dd>
        </dl>
        <div className="balance-adjustment-analysis-source-meta">
          <a href={selected.source.url} target="_blank" rel="noreferrer">公式の原文<span className="win-rates-visually-hidden">（新しいタブ）</span></a>
          <a href={balanceAdjustmentDetailHash(event.id, selected.subjectId === 'common' ? COMMON_ADJUSTMENT_SCOPE : selected.subjectId)}>バトル変更詳細</a>
          <span>同じ公式行から分解{analysis?.rows.filter(row => row.sourceChangeId === selected.sourceChangeId).length ?? 0}件</span>
          <span>取得：{timestampLabel(patch.capturedAt)}</span>
        </div>
      </div> : <p className="balance-adjustment-analysis-empty" role="status">
        {!analysis ? '原文を表示できません。' : '該当する変更はありません。'}
      </p>}
    </StatisticsPanel>
  </section>
}

function AdjustmentAnalysisTable({ rows, selectedId, tableId, sourcePanelId, onSelect }: {
  rows: readonly AdjustmentAnalysisRow[]
  selectedId: string | null
  tableId: string
  sourcePanelId: string
  onSelect: (id: string) => void
}) {
  const { scrollRef, selectedRowRef } = useSelectedRowScroll(rows, selectedId, true)
  return <div ref={scrollRef} className="data-table-scroll balance-adjustment-analysis-scroll" role="region" tabIndex={0}
    aria-label="分解したバトル変更の分類一覧・スクロール領域">
    <table id={tableId} className="data-table balance-adjustment-analysis-table">
      <caption className="win-rates-visually-hidden">バトル変更の分類候補と変更前後の値</caption>
      <colgroup><col className="balance-adjustment-analysis-subject-column" /><col className="balance-adjustment-analysis-target-column" />
        <col className="balance-adjustment-analysis-element-column" /><col className="balance-adjustment-analysis-direction-column" />
        <col className="balance-adjustment-analysis-value-column" /><col className="balance-adjustment-analysis-value-column" /><col className="balance-adjustment-analysis-value-column" /></colgroup>
      <thead><tr><th scope="col">対象</th><th scope="col">変更箇所</th><th scope="col">変更要素</th><th scope="col">変化</th>
        <th scope="col">変更前</th><th scope="col">変更後</th><th scope="col">増減量</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} ref={row.id === selectedId ? selectedRowRef : undefined}
        className={row.id === selectedId ? 'is-selected' : undefined}>
        <th scope="row">{row.subjectName}</th>
        <td className="balance-adjustment-analysis-target-cell"><button type="button" className="balance-adjustment-analysis-select"
          aria-pressed={row.id === selectedId} aria-controls={sourcePanelId} aria-label={`${row.subjectName}・${row.target || '変更箇所の記載なし'}・${row.elementLabel}の原文を表示`}
          onClick={() => onSelect(row.id)}>{row.target || '記載なし'}</button></td>
        <td>{row.elementLabel}</td><td>{row.direction}</td>
        <td className="balance-adjustment-analysis-number">{row.beforeValue ?? '—'}</td>
        <td className="balance-adjustment-analysis-number">{row.afterValue ?? '—'}</td>
        <td className="balance-adjustment-analysis-number">{row.deltaValue ?? '—'}</td>
      </tr>)}{rows.length === 0 && <tr><td colSpan={7} className="balance-adjustment-analysis-empty-cell">該当する変更はありません。</td></tr>}</tbody>
    </table>
  </div>
}

function HighlightedDescription({ row }: { row: AdjustmentAnalysisRow }) {
  const start = Math.max(0, Math.min(row.description.length, row.evidence.start))
  const end = Math.max(start, Math.min(row.description.length, row.evidence.end))
  return <>{row.description.slice(0, start)}{end > start && <mark>{row.description.slice(start, end)}</mark>}{row.description.slice(end)}</>
}
