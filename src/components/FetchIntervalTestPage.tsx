import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { DEFAULT_FETCH_INTERVAL_INPUT, fetchIntervalDraft, fetchIntervalRows, fetchIntervalStateLabels, isFetchIntervalConfig, isFetchIntervalRun } from '../lib/fetchIntervalTest'
import { parallelFetchIntervals, plannedParallelFetchAttempts } from '../lib/parallelFetch'
import { cloudConfig, cloudRunUrl, isCloudRunActive, parseParallelFetchResult } from '../lib/parallelFetchCloud'
import { cloudStateLabels, durationLabel, errorLabels } from '../lib/parallelFetchLabels'
import { useParallelFetchCloud } from '../lib/useParallelFetchCloud'
import type { CloudRun, ParallelFetchResult } from '../types/parallelFetchCloud'
import type { ParallelFetchConfig, ParallelFetchReport } from '../types/parallelFetch'
import { ParallelFetchCloudStatus } from './ParallelFetchCloudStatus'
import { ParallelFetchIntervalInput } from './ParallelFetchIntervalInput'
import { StatisticsPanel } from './StatisticsPanel'
import '../table.css'
import '../parallel-fetch.css'
import '../fetch-interval-test.css'

const MAX_REPORT_BYTES = 2 * 1024 * 1024
const environmentLabels = { 'github-actions': 'GitHub Actions', local: 'ローカル', unknown: '実行先未記録' }
type ResultChoice = { key: string; label: string; config: ParallelFetchConfig; result: ParallelFetchResult | null; run: CloudRun | null }

function envelope(run: CloudRun): ParallelFetchResult | null {
  return run.report ? { schemaVersion: 1, kind: 'parallel-fetch-result', environment: 'github-actions', cloud: run, report: run.report } : null
}

export function FetchIntervalResults({ config, report, run }: { config: ParallelFetchConfig; report: ParallelFetchReport | null; run: CloudRun | null }) {
  const [selectedInterval, setSelectedInterval] = useState<number | null>(null)
  const missingState = report ? undefined : run ? isCloudRunActive(run) ? run.state === 'queued' || run.state === 'dispatching' || run.state === 'dispatch-unknown'
    ? 'queued' : 'awaiting-result' : 'unavailable' : 'not-run'
  const rows = fetchIntervalRows(config, report, missingState)
  const selected = rows.find(row => row.intervalMs === selectedInterval) ?? rows[0]
  return <div className="fetch-interval-results">
    <p className="parallel-fetch-source">直列 · LP 1〜20ページ · 各1回 · {parallelFetchIntervals(config).map(value => `${value / 1000}秒`).join(' → ')}</p>
    {report?.errorCode && !report.trials.some(trial => trial.errorCode === report.errorCode) && <p className="parallel-fetch-message" role="status">{errorLabels[report.errorCode]}</p>}
    <div className="data-table-scroll" role="region" tabIndex={0} aria-label="取得開始間隔の比較結果・横スクロール領域">
      <table className="data-table fetch-interval-table">
        <caption className="parallel-fetch-visually-hidden">同一実行内の開始間隔別の測定結果</caption>
        <thead><tr><th scope="col">開始間隔</th><th scope="col">状態</th><th scope="col">取得ページ</th><th scope="col">測定時間</th><th scope="col">記録</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.intervalMs} className={selected?.intervalMs === row.intervalMs ? 'is-selected' : undefined}>
          <th scope="row">{row.intervalMs / 1000} 秒</th>
          <td className="fetch-interval-state">{fetchIntervalStateLabels[row.state]}</td>
          <td>{row.completedPages === null ? '—' : `${row.completedPages} / ${config.pageCount}`}</td>
          <td>{row.measurementMs !== null ? durationLabel(row.measurementMs) : row.trial ? '未完了' : '—'}</td>
          <td><button type="button" className="fetch-interval-record" aria-label={`${row.intervalMs / 1000}秒の記録を見る`} aria-pressed={selected?.intervalMs === row.intervalMs} onClick={() => setSelectedInterval(row.intervalMs)}>詳細</button></td>
        </tr>)}</tbody>
      </table>
    </div>
    {selected && <section className="fetch-interval-detail" aria-label={`${selected.intervalMs / 1000}秒の記録`} aria-live="polite">
      <h3>{selected.intervalMs / 1000}秒の記録</h3>
      <dl className="fetch-interval-details">
        <div><dt>到達点</dt><dd>{selected.locationLabel}</dd></div>
        <div><dt>ページ読取時間（成功時の中央値）</dt><dd>{durationLabel(selected.medianReadMs)}</dd></div>
        <div><dt>準備時間</dt><dd>{durationLabel(selected.trial?.preparationMs ?? null)}</dd></div>
        <div><dt>準備・測定の経過時間</dt><dd>{durationLabel(selected.trial?.totalMs ?? null)}</dd></div>
        <div className="fetch-interval-detail-wide"><dt>停止理由</dt><dd>{selected.errorCode ? errorLabels[selected.errorCode] : selected.state === 'complete' ? 'なし' : selected.state === 'incomplete' ? '完了条件を満たしていません' : '—'}</dd></div>
        <div className="fetch-interval-detail-wide"><dt>最後の取得で確認できた状態</dt><dd>{selected.diagnosticLabels.length ? selected.diagnosticLabels.join(' · ') : '記録なし'}</dd></div>
      </dl>
    </section>}
  </div>
}

export function FetchIntervalTestPage() {
  const [intervalText, setIntervalText] = useState(DEFAULT_FETCH_INTERVAL_INPUT)
  const [imports, setImports] = useState<ParallelFetchResult[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const importGeneration = useRef(0)
  const cloud = useParallelFetchCloud(true)
  const draft = fetchIntervalDraft(intervalText)
  const activeRun = cloud.status?.runs.find(isCloudRunActive) ?? null
  const busy = !!activeRun || cloud.pending || cloud.unconfirmed
  const invalidServiceState = cloud.status?.error === 'state-invalid' || cloud.status?.error === 'state-save-failed'
  const choices = useMemo<ResultChoice[]>(() => [
    ...imports.map(result => ({ key: `import:${result.environment}:${result.report.runId}`,
      label: `JSON読込 · ${timestampLabel(result.report.startedAt)} · ${environmentLabels[result.environment]}`,
      config: result.report.config, result, run: null })),
    ...(cloud.status?.runs ?? []).filter(isFetchIntervalRun).map(run => ({ key: `cloud:${run.requestId}`,
      label: `${timestampLabel(run.createdAt)} · ${run.runId ? `#${run.runId}` : '実行番号未確定'} · ${cloudStateLabels[run.state]}`,
      config: run.report?.config ?? cloudConfig(run.mode, run.options, { historical: true }), result: envelope(run), run })),
  ], [imports, cloud.status?.runs])
  const selected = choices.find(choice => choice.key === selectedKey) ?? (selectedKey === null ? choices[0] : null)
  const result = selected?.result ?? null
  const report = result?.report ?? null
  const resultRun = selected?.run ?? result?.cloud ?? null
  const statusRun = activeRun && isFetchIntervalRun(activeRun) ? activeRun : selected?.run ?? null
  const canRun = !busy && !importing && !invalidServiceState && !!draft.config && cloud.connection === 'connected' && cloud.status?.readiness === 'ready'

  useEffect(() => () => { importGeneration.current += 1 }, [])
  useEffect(() => { if (selectedKey === null && choices.length) setSelectedKey(choices[0].key) }, [selectedKey, choices])

  const start = async (event: FormEvent) => {
    event.preventDefault()
    if (!canRun || !draft.options) return
    setFileError(null)
    const next = await cloud.command('run', { mode: 'interval-compare', options: draft.options })
    if (next?.activeRequestId) setSelectedKey(`cloud:${next.activeRequestId}`)
  }
  const importResult = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busy || importing) return
    const generation = ++importGeneration.current
    setImporting(true)
    setFileError(null)
    try {
      if (file.size > MAX_REPORT_BYTES) throw new Error('JSONは2 MB以下で指定してください。')
      let parsed: ParallelFetchResult
      try { parsed = parseParallelFetchResult(JSON.parse(await file.text())) }
      catch { throw new Error('取得テストの有効な結果JSONではありません。') }
      if (!isFetchIntervalConfig(parsed.report.config) || parsed.environment === 'local') {
        throw new Error('LP 1〜20ページ・並列1・全体共通間隔・各1回のActions結果を選択してください。')
      }
      if (generation !== importGeneration.current) return
      setImports(previous => [parsed, ...previous.filter(item => item.environment !== parsed.environment || item.report.runId !== parsed.report.runId)].slice(0, 20))
      setSelectedKey(`import:${parsed.environment}:${parsed.report.runId}`)
    } catch (error) {
      if (generation === importGeneration.current) setFileError(error instanceof Error ? error.message : '結果を読み込めません。')
    } finally { if (generation === importGeneration.current) setImporting(false) }
  }
  const exportResult = () => {
    if (!result) return
    const sanitized = parseParallelFetchResult(result)
    const url = URL.createObjectURL(new Blob([JSON.stringify(sanitized, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `fetch-interval-${sanitized.environment}-${sanitized.report.startedAt.slice(0, 10)}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <section className="parallel-fetch-page fetch-interval-page" aria-label="取得間隔テスト">
    <StatisticsPanel title="比較条件">
      <dl className="fetch-interval-fixed">
        <div><dt>実行環境</dt><dd>GitHub Actions</dd></div>
        <div><dt>並列数</dt><dd>1（直列）</dd></div>
        <div><dt>取得対象</dt><dd>LPランキング 1〜20ページ</dd></div>
        <div><dt>試行回数</dt><dd>各1回</dd></div>
      </dl>
      <form onSubmit={event => { void start(event) }}>
        <fieldset className="parallel-fetch-fields fetch-interval-fields" disabled={busy || importing}>
          <ParallelFetchIntervalInput value={intervalText} onChange={setIntervalText} error={draft.error} errorId="fetch-interval-config-error" />
          {import.meta.env.DEV && <div className="parallel-fetch-actions fetch-interval-start"><button type="submit" disabled={!canRun}>比較を実行</button></div>}
        </fieldset>
        {draft.error ? <p id="fetch-interval-config-error" className="parallel-fetch-message" role="alert">{draft.error}</p>
          : draft.config && <div className="fetch-interval-plan" aria-live="polite"><span>実行順</span><span>{parallelFetchIntervals(draft.config).map(value => `${value / 1000}秒`).join(' → ')}</span><span>準備を含め{plannedParallelFetchAttempts(draft.config)}リクエスト</span></div>}
      </form>
      <div className="fetch-interval-execution">
        <ParallelFetchCloudStatus cloud={cloud} run={statusRun} compact />
        {activeRun && !isFetchIntervalRun(activeRun) && <p className="parallel-fetch-message" role="status">別の取得テストが実行中 · <a href="#parallel-fetch-test">並列取得テストで確認</a></p>}
      </div>
    </StatisticsPanel>
    <StatisticsPanel title="比較結果" headerContent={<span className="monthly-statistics-panel-summary">同一実行内で比較</span>}>
      <div className="fetch-interval-result-tools">
        {choices.length > 0 && <label className="parallel-fetch-history"><span>実行履歴</span><select aria-label="取得間隔テストの実行履歴" value={selected?.key ?? ''} onChange={event => setSelectedKey(event.target.value)}>
          {!selected && <option value="">履歴を選択</option>}
          {choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
        </select></label>}
        <div className="parallel-fetch-file-actions">
          <input ref={fileInput} className="parallel-fetch-visually-hidden" type="file" tabIndex={-1} accept="application/json,.json" aria-label="取得間隔の結果JSON" onChange={event => { void importResult(event) }} disabled={busy || importing} />
          <button type="button" disabled={busy || importing} onClick={() => fileInput.current?.click()}>{importing ? '読込中' : '結果JSONを読み込む'}</button>
          <button type="button" disabled={!result} onClick={exportResult}>JSONを書き出す</button>
        </div>
      </div>
      {fileError && <p className="parallel-fetch-message" role="alert">{fileError}</p>}
      {selected ? <>
        <dl className="fetch-interval-source">
          <div><dt>実行先</dt><dd>{result ? environmentLabels[result.environment] : 'GitHub Actions'}{selected.key.startsWith('import:') && ' · JSON読込'}</dd></div>
          <div><dt>取得開始</dt><dd>{report ? timestampLabel(report.startedAt) : '結果未取得'}</dd></div>
          {resultRun?.runId && <div><dt>Actions実行</dt><dd><a href={cloudRunUrl(resultRun.runId)} target="_blank" rel="noreferrer">#{resultRun.runId}</a> · 試行 {resultRun.runAttempt}</dd></div>}
          {resultRun?.headSha && <div><dt>コード</dt><dd>{resultRun.headSha.slice(0, 8)}</dd></div>}
        </dl>
        <FetchIntervalResults key={selected.key} config={selected.config} report={report} run={selected.run} />
      </> : <p className="parallel-fetch-empty" role="status">比較結果はまだありません</p>}
    </StatisticsPanel>
  </section>
}
