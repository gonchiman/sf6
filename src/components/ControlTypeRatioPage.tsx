import { useEffect, useId, useMemo, useState } from 'react'
import { createControlTypeRatioRows } from '../lib/controlTypeRatio'
import { createCharacterControlTypeRatioRows } from '../lib/characterControlTypeRatio'
import { timestampLabel } from '../lib/dateTime'
import { initialUsageRateSelection, loadUsageRateHistory, loadUsageRateManifest, usageRateSelectedMonths } from '../lib/usageRates'
import { monthLabel } from '../lib/winRateHistory'
import type { UsageRateHistoryResult, UsageRateManifest, UsageRateSelection } from '../types/usageRates'
import { ControlTypeRatioDetailsTable } from './ControlTypeRatioDetailsTable'
import { CharacterControlTypeRatioTable } from './CharacterControlTypeRatioTable'
import { ControlTypeRatioFilters } from './ControlTypeRatioFilters'
import { ControlTypeRatioTable, controlTypeRatioRowLabel } from './ControlTypeRatioTable'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import { ratioErrorLabel, ratioPercentLabel, usageRateLeagueLabel } from './controlTypeRatioFormatting'
import '../win-rates.css'
import '../monthly-win-rate-statistics.css'
import '../control-type-ratio.css'

type BootstrapState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; manifest: UsageRateManifest }

type HistoryState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error' }
  | { key: string; status: 'ready'; results: UsageRateHistoryResult[] }

export function ControlTypeRatioPage() {
  const contentId = useId()
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [selection, setSelection] = useState<UsageRateSelection | null>(null)
  const [historyState, setHistoryState] = useState<HistoryState | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [view, setView] = useState<'overall' | 'characters'>('overall')

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void loadUsageRateManifest().then(manifest => {
      if (!current) return
      setSelection(initialUsageRateSelection(manifest))
      setBootstrap({ status: 'ready', manifest })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [bootstrapVersion])

  const manifest = bootstrap.status === 'ready' ? bootstrap.manifest : null
  const requestKey = manifest && selection ? JSON.stringify([manifest.generatedAt, selection]) : null

  useEffect(() => {
    if (!manifest || !selection || !requestKey) return
    let current = true
    const requestedKey = requestKey
    setHistoryState({ key: requestedKey, status: 'loading' })
    void loadUsageRateHistory(manifest, selection).then(results => {
      if (current) setHistoryState({ key: requestedKey, status: 'ready', results })
    }).catch(() => {
      if (current) setHistoryState({ key: requestedKey, status: 'error' })
    })
    return () => { current = false }
  }, [manifest, selection, requestKey, historyVersion])

  // Hide the previous condition's estimates before the new request effect starts.
  const currentState = historyState?.key === requestKey ? historyState : null
  const rows = useMemo(() => currentState?.status === 'ready'
    ? createControlTypeRatioRows(currentState.results) : [], [currentState])
  const selectedMonths = useMemo(() => selection ? usageRateSelectedMonths(selection) : [], [selection])
  const effectiveSelectedMonth = selectedMonth && selectedMonths.includes(selectedMonth)
    ? selectedMonth : selectedMonths.at(-1) ?? null
  const selectedRow = rows.find(row => row.month === effectiveSelectedMonth)
  const estimate = selectedRow?.estimate
  const selectedDataset = selectedRow?.dataset
  const characterRows = useMemo(() => selectedDataset
    ? createCharacterControlTypeRatioRows(selectedDataset, estimate ?? undefined) : [], [selectedDataset, estimate])
  const failedCount = rows.filter(row => row.status === 'error').length

  useEffect(() => {
    if (effectiveSelectedMonth && effectiveSelectedMonth !== selectedMonth) setSelectedMonth(effectiveSelectedMonth)
  }, [effectiveSelectedMonth, selectedMonth])

  if (bootstrap.status === 'loading') return <DataLoadState loading message="期間と条件を読み込み中…" />
  if (bootstrap.status === 'error' || !manifest || !selection) {
    return <DataLoadState message="期間と条件を読み込めませんでした。"
      onRetry={() => setBootstrapVersion(version => version + 1)} />
  }

  const datasets = currentState?.status === 'ready' ? currentState.results.flatMap(result =>
    result.status === 'ready' ? [result.dataset] : []) : []
  const sourceNotes = [...new Set(datasets.flatMap(dataset => dataset.source.notes))]
  const sourcePopulations = [...new Set(datasets.map(dataset => dataset.source.population))]
  const sourceMetrics = [...new Set(datasets.map(dataset => dataset.source.metric))]
  const sourceUnits = [...new Set(datasets.map(dataset => dataset.source.unit))]

  return <section className="control-type-ratio-page" aria-label="操作タイプ比率（推定）">
    <StatisticsPanel title="条件選択" headerContent={<span className="monthly-statistics-panel-summary">
      総合版 · {usageRateLeagueLabel(selection.league)} · {monthLabel(selection.fromMonth)}〜{monthLabel(selection.toMonth)}
    </span>}>
      <div className="win-rates-view-selector control-ratio-view-selector" role="group" aria-label="比率の表示">
        {([['overall', '全体'], ['characters', 'キャラ別']] as const).map(([value, label]) => <button
          key={value} type="button" className="win-rates-button" aria-pressed={view === value}
          aria-controls={`${contentId}-table`} onClick={() => setView(value)}>{label}</button>)}
      </div>
      <ControlTypeRatioFilters manifest={manifest} selection={selection} onChange={setSelection} />
      {view === 'characters' && effectiveSelectedMonth && <div className="win-rates-filters control-ratio-month-filter">
        <label><span>確認する月</span><select aria-label="確認する月" value={effectiveSelectedMonth}
          onChange={event => setSelectedMonth(event.target.value)}>
          {selectedMonths.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
        </select></label>
      </div>}
      <p className="control-ratio-note">ランクマッチの公開使用率をもとにした推定値です。プレイヤー人数の比率とは断定できません。</p>
    </StatisticsPanel>

    <StatisticsPanel title="テーブル" headerContent={currentState?.status === 'ready'
      && <span className="monthly-statistics-panel-summary">{view === 'overall' ? `${rows.length}か月の推定比率`
        : `${effectiveSelectedMonth ? monthLabel(effectiveSelectedMonth) : '—'}のキャラ別推定比率`}</span>}>
      <div id={`${contentId}-table`} className="control-ratio-view-panel">
      {(!currentState || currentState.status === 'loading') && <DataLoadState loading message="月別の使用率を読み込み中…" />}
      {currentState?.status === 'error' && <DataLoadState message="月別の使用率を読み込めませんでした。"
        onRetry={() => setHistoryVersion(version => version + 1)} />}
      {currentState?.status === 'ready' && <div className="control-ratio-table-content">
        {failedCount > 0 && <div className="control-ratio-load-error" role="alert">
          <span>{rows.length}か月中{failedCount}か月を読み込めませんでした。</span>
          <button type="button" className="win-rates-button" onClick={() => setHistoryVersion(version => version + 1)}>再読み込み</button>
        </div>}
        {view === 'overall' && <>
          <ControlTypeRatioTable rows={rows} selectedMonth={effectiveSelectedMonth} onSelect={setSelectedMonth} />
          <p className="control-ratio-note">対象月を選択すると、その月の計算根拠を確認できます。最大再現誤差は公開ALLとのずれで、推定比率の信頼度や信頼区間を表す値ではありません。</p>
        </>}
        {view === 'characters' && <>
          {selectedDataset ? <CharacterControlTypeRatioTable rows={characterRows} />
            : <p className="control-ratio-character-state" role="status">{effectiveSelectedMonth ? monthLabel(effectiveSelectedMonth) : '—'}：{selectedRow ? controlTypeRatioRowLabel(selectedRow) : 'データを確認できません。'}</p>}
          <p className="control-ratio-note">各キャラを使う場合のモダン・クラシック比率を、全体の推定比率から計算しています。公式ALL使用率は全体に占めるそのキャラの使用率です。比率の分母と計算根拠は下の詳細で確認できます。</p>
        </>}

        {selectedRow && <details className="win-rates-details">
          <summary>選択月の計算根拠 · {monthLabel(selectedRow.month)}</summary>
          <div className="win-rates-details-content control-ratio-evidence-content">
            {estimate?.status === 'estimated' ? <>
              <p>{monthLabel(selectedRow.month)} · {usageRateLeagueLabel(selection.league)}：モダン {ratioPercentLabel(estimate.modernRatio)}% ／ クラシック {ratioPercentLabel(estimate.classicRatio)}%（推定）。比較対象は{estimate.characterCount}キャラです。</p>
              <p>最大再現誤差 {ratioErrorLabel(estimate.maxAbsoluteErrorPoints)} ポイント、RMS再現誤差 {ratioErrorLabel(estimate.rmsErrorPoints)} ポイント。</p>
              <ControlTypeRatioDetailsTable details={estimate.details} />
            </> : <p role="status">{controlTypeRatioRowLabel(selectedRow)}</p>}
            {selectedDataset && <dl className="win-rates-source">
              <div><dt>取得日時</dt><dd><time dateTime={selectedDataset.capturedAt}>{timestampLabel(selectedDataset.capturedAt)}</time></dd></div>
              <div><dt>生成日時</dt><dd><time dateTime={selectedDataset.generatedAt}>{timestampLabel(selectedDataset.generatedAt)}</time></dd></div>
              <div><dt>データ形式</dt><dd>Version {selectedDataset.schemaVersion}</dd></div>
            </dl>}
          </div>
        </details>}

        <details className="win-rates-details">
          <summary>推定方法・前提・出典</summary>
          <div className="win-rates-details-content control-ratio-evidence-content">
            <p>同じ月・リーグのALL、CLASSIC、MODERNのキャラクター別使用率を比較します。ALLが両操作タイプを同じ方法で集計した混合分布になっていることが前提です。</p>
            <p className="control-ratio-formula">モダンの比率をpとして、再現ALL = (1 − p) × CLASSIC + p × MODERN。各キャラの再現ALLと公式ALLの差の二乗の合計が最小になるpを求めます。クラシックの比率は1 − pです。</p>
            <p className="control-ratio-formula">キャラ内のモダン比率 = p × そのキャラのMODERN使用率 ÷ 再現ALL。クラシック比率 = (1 − p) × そのキャラのCLASSIC使用率 ÷ 再現ALL。分母は推定したそのキャラの合計使用率です。両比率の合計が100%になるよう同じ分母を使い、丸め済みの公式ALL使用率で割る方法とは区別します。</p>
            <p>キャラ別の比率は、全体の推定比率と各操作タイプ内のキャラ使用率から求めた推定値です。MODERN・CLASSICの公式使用率そのものや、各キャラだけで全体比率を逆算した値とは異なります。再現ALLが0の場合、そのキャラ内の比率は算出しません。</p>
            <p>公式使用率は表示時に丸められています。計算には保存された表示値を使用し、推定比率は表示時だけ小数2桁に丸めます。最大再現誤差とRMS再現誤差はポイントで表示し、0でない微小な差を0とは表示しません。</p>
            <p>読み込み時に3分布の形式・条件・キャラの一致を確認し、確認できないデータは「読込失敗」と表示します。使用率の値に欠損がある場合、両タイプの分布が同じ場合、推定比率が0〜100%の範囲外になる場合は、理由と「推定不可」を表示します。未登録の月と読込失敗を0%で補完しません。公式の集計単位や分母が未確認のため、人数・試合数の復元や信頼区間の計算は行いません。</p>
            <dl className="win-rates-source">
              <div><dt>出典</dt><dd><a href={manifest.source.url} target="_blank" rel="noreferrer">{manifest.source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
              <div><dt>一覧生成日時</dt><dd><time dateTime={manifest.generatedAt}>{timestampLabel(manifest.generatedAt)}</time></dd></div>
              <div><dt>データ形式</dt><dd>Version {manifest.schemaVersion}</dd></div>
              <div><dt>対象</dt><dd>{sourcePopulations.join('、') || '未確認'}</dd></div>
              <div><dt>指標</dt><dd>{sourceMetrics.join('、') || '未確認'}</dd></div>
              <div><dt>集計単位</dt><dd>{sourceUnits.join('、') || '未確認'}</dd></div>
            </dl>
            {sourceNotes.length > 0 && <ul>{sourceNotes.map(note => <li key={note}>{note}</li>)}</ul>}
          </div>
        </details>
      </div>}
      </div>
    </StatisticsPanel>
  </section>
}
