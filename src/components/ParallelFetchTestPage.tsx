import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { timestampLabel } from '../lib/dateTime'
import {
  DEFAULT_PARALLEL_FETCH_CONFIG, PARALLEL_FETCH_MAX_ATTEMPTS, PARALLEL_FETCH_MAX_CONCURRENCY,
  parallelFetchIntervals, parallelFetchIntervalScope, parseParallelFetchConfig, parseParallelFetchReport, plannedParallelFetchAttempts, summarizeParallelFetch,
} from '../lib/parallelFetch'
import { CLOUD_WORKFLOW_URL, DEFAULT_CLOUD_INTERVAL_OPTIONS, cloudConfig, cloudRunUrl, isCloudRunActive, parseParallelFetchResult } from '../lib/parallelFetchCloud'
import { parallelFetchConditionStatus, parallelFetchConcurrencyDraft, parallelFetchConfigError, parallelFetchIntervalDraft, parallelFetchIntervalScopeLabel, parallelFetchIntervalScopeLabels, parallelFetchPlanRows } from '../lib/parallelFetchPresentation'
import { useParallelFetchCloud } from '../lib/useParallelFetchCloud'
import type { CloudError, CloudIntervalOptions, CloudMode, CloudRun, CloudServiceStatus, CloudState, ParallelFetchResult } from '../types/parallelFetchCloud'
import type {
  ParallelFetchConfig, ParallelFetchErrorCode, ParallelFetchIntervalScope, ParallelFetchReport,
  ParallelFetchServiceStatus, ParallelFetchTrial, ParallelFetchWorker,
} from '../types/parallelFetch'
import { StatisticsPanel } from './StatisticsPanel'
import '../table.css'
import '../parallel-fetch.css'

const MAX_REPORT_BYTES = 2 * 1024 * 1024
const serviceUrl = `${import.meta.env.BASE_URL}__parallel-fetch`
const numberLabel = (value: number) => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(value)
const durationLabel = (value: number | null) => value === null ? '—' : `${numberLabel(value / 1000)} 秒`
const estimateLabel = (value: number | null) => value === null ? '算出不可'
  : value >= 86_400_000 ? `約 ${numberLabel(value / 86_400_000)} 日` : `約 ${numberLabel(value / 3_600_000)} 時間`
const errorLabels: Record<ParallelFetchErrorCode, string> = {
  cancelled: '停止しました', 'limit-reached': '取得回数・時間の上限', 'out-of-range': '対象ページが範囲外',
  'http-denied': 'アクセス制限', 'server-error': '取得先のサーバーエラー', 'http-error': '取得先の応答エラー',
  maintenance: 'メンテナンス中', 'login-required': 'ログインが必要',
  'authentication-unconfirmed': 'ログイン状態を確認できません', 'human-verification': 'ロボット認証が必要',
  'condition-mismatch': '取得条件が不一致', 'page-mismatch': 'ページ番号が不一致',
  'unsupported-dom': 'ページを読み取れません', timeout: '取得がタイムアウト', 'read-failed': 'ページ取得に失敗',
  'session-unavailable': '保存済みログイン情報を利用できません', 'browser-unavailable': '取得用ブラウザーを起動できません',
  'invalid-request': '取得条件が不正',
}
const trialStateLabels: Record<ParallelFetchTrial['state'], string> = {
  preparing: '準備中', running: '測定中', complete: '完了', stopped: '停止', error: '失敗',
}
const cloudModeLabels: Record<CloudMode, string> = { serial: '直列を3回', compare: '並列1・2を比較', 'interval-compare': '取得間隔 × 並列数' }
const conditionStateLabels = { ...trialStateLabels, 'not-run': '未実行', pending: '一部完了' }
const workerStateLabels: Record<ParallelFetchWorker['state'], string> = {
  idle: '待機', waiting: '取得間隔の待機', reading: '取得中', complete: '完了', stopped: '停止',
}
const environmentLabels: Record<ParallelFetchResult['environment'], string> = {
  local: 'ローカル', 'github-actions': 'GitHub Actions', unknown: '実行先未記録',
}
const cloudStateLabels: Record<CloudState, string> = {
  dispatching: '受付中', 'dispatch-unknown': '受付結果を確認中', queued: '待機中', preparing: '環境準備中',
  collecting: '取得中', 'loading-result': '結果を読込中', complete: '完了', failed: '失敗',
  'cancel-requested': '取消を要求済み', cancelled: '中止',
}
const cloudErrorLabels: Record<CloudError, string> = {
  'dispatch-uncertain': '受付結果が未確認です。再送せず実行状況を確認します。',
  'github-unavailable': 'GitHubとの接続を確認できません', 'workflow-unavailable': 'テスト用ワークフローが利用できません',
  'workflow-failed': 'Actionsの実行に失敗しました', 'artifact-missing': '結果ファイルがありません',
  'artifact-expired': '結果ファイルの保存期限が切れています', 'artifact-download-failed': '結果ファイルを取得できません',
  'invalid-report': '結果ファイルの形式が不正です', 'state-save-failed': '実行記録を保存できません',
  'state-invalid': '保存した実行記録を読み取れません', 'run-ambiguous': '対応するActionsの実行を特定できません',
  'cancel-failed': '取消を確認できません', 'already-running': '実行中のテストがあります',
  'invalid-request': '実行条件が不正です', forbidden: 'この画面から操作を送信できません', 'service-closed': '取得サービスは終了しています',
}
const readinessLabels: Record<CloudServiceStatus['readiness'], string> = {
  checking: 'GitHub接続を確認中', ready: 'GitHub接続済み', 'gh-unavailable': 'GitHub CLIを利用できません',
  'github-unavailable': 'GitHub認証・接続を確認できません', 'workflow-unavailable': 'テスト用ワークフローが利用できません',
}

type ResultChoice = { key: string; label: string; result: ParallelFetchResult | null; cloud: CloudRun | null }
function resultEnvelope(report: ParallelFetchReport, environment: 'local' | 'github-actions', cloud: CloudRun | null = null): ParallelFetchResult {
  return { schemaVersion: 1, kind: 'parallel-fetch-result', environment, cloud, report }
}
function resultLabel(result: ParallelFetchResult) {
  return `${environmentLabels[result.environment]}${result.cloud?.runId ? ` #${result.cloud.runId}` : ''} · ${timestampLabel(result.report.startedAt)} · ${parallelFetchIntervalScopeLabel(result.report.config)}`
}

function CloudStatus({ cloud, run }: { cloud: ReturnType<typeof useParallelFetchCloud>; run: CloudRun | null }) {
  const connected = cloud.connection === 'connected'
  const active = !!run && isCloudRunActive(run)
  const runConfig = run ? run.report?.config ?? cloudConfig(run.mode, run.options, { historical: true }) : null
  return <div className="parallel-fetch-status">
    <p className="parallel-fetch-connection" role="status">{cloud.connection === 'static' ? 'GitHub上で実行 · 結果JSONを読み込み'
      : cloud.connection === 'checking' ? '取得サービスを確認中' : !connected ? '取得サービスに接続できません'
        : cloud.status ? readinessLabels[cloud.status.readiness] : 'GitHub接続を確認中'}</p>
    <div className="parallel-fetch-progress-heading">
      <strong role="status" aria-live="polite">{cloud.pending ? '操作の受付を確認中' : run ? cloudStateLabels[run.state] : '未実行'}</strong>
      <div className="parallel-fetch-file-actions">
        {run && connected && <button type="button" disabled={cloud.pending} onClick={() => { void cloud.command('retry', { requestId: run.requestId }) }}>結果を再確認</button>}
        {active && run.runId && run.state !== 'cancel-requested' && connected && <button type="button" disabled={cloud.pending} onClick={() => { void cloud.command('stop', { requestId: run.requestId }) }}>実行を取り消す</button>}
      </div>
    </div>
    {cloud.commandError && <p className="parallel-fetch-message" role="alert">{cloud.commandError}</p>}
    {cloud.commandErrorCode && cloud.commandErrorCode !== cloud.status?.error && cloud.commandErrorCode !== run?.error && <p className="parallel-fetch-message" role="alert">{cloudErrorLabels[cloud.commandErrorCode]}</p>}
    {cloud.status?.error && <p className="parallel-fetch-message" role="status">{cloudErrorLabels[cloud.status.error]}</p>}
    {run?.error && run.error !== cloud.status?.error && <p className="parallel-fetch-message" role="status">{cloudErrorLabels[run.error]}</p>}
    {run?.report?.errorCode && <p className="parallel-fetch-message" role="status">{errorLabels[run.report.errorCode]}</p>}
    {run && <dl className="parallel-fetch-details">
      <div><dt>テスト</dt><dd>{cloudModeLabels[run.mode]}</dd></div>
      {runConfig && <>
        <div><dt>取得開始間隔</dt><dd>{parallelFetchIntervals(runConfig).map(value => value / 1000).join('・')} 秒</dd></div>
        <div><dt>間隔の適用範囲</dt><dd>{parallelFetchIntervalScopeLabel(runConfig)}</dd></div>
      </>}
      <div><dt>Actions実行</dt><dd>{run.runId ? `#${run.runId} · 試行 ${run.runAttempt}` : '実行番号を確認中'}</dd></div>
      <div><dt>受付日時</dt><dd><RecordedTime value={run.createdAt} /></dd></div>
      <div><dt>ジョブ開始</dt><dd><RecordedTime value={run.startedAt} /></dd></div>
      <div><dt>ジョブ終了</dt><dd><RecordedTime value={run.finishedAt} /></dd></div>
      <div><dt>ページ取得数</dt><dd>{run.report ? `${run.report.trials.reduce((total, trial) => total + trial.completedPages.length, 0)} ページ成功` : '結果ファイルの取得後に表示'}</dd></div>
    </dl>}
    <p className="parallel-fetch-source"><a href={run?.runId ? cloudRunUrl(run.runId) : CLOUD_WORKFLOW_URL} target="_blank" rel="noreferrer">GitHub Actionsで開く</a></p>
  </div>
}

function parseServiceStatus(value: unknown): ParallelFetchServiceStatus {
  if (!value || typeof value !== 'object') throw new Error('invalid-status')
  const status = value as Record<string, unknown>
  if (typeof status.available !== 'boolean' || typeof status.sessionAvailable !== 'boolean'
    || typeof status.token !== 'string' || status.token.length > 256
    || status.error !== undefined && status.error !== 'report-save-failed') throw new Error('invalid-status')
  return { available: status.available, sessionAvailable: status.sessionAvailable, token: status.token,
    report: status.report === null ? null : parseParallelFetchReport(status.report),
    ...(status.error === 'report-save-failed' ? { error: status.error } : {}) }
}

function useParallelFetchService() {
  const [status, setStatus] = useState<ParallelFetchServiceStatus | null>(null)
  const [connection, setConnection] = useState<'checking' | 'connected' | 'unavailable' | 'static'>(import.meta.env.DEV ? 'checking' : 'static')
  const [pending, setPending] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const commandPending = useRef(false)
  const controllers = useRef(new Set<AbortController>())

  useEffect(() => {
    mounted.current = true
    if (!import.meta.env.DEV) return () => { mounted.current = false }
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (!active) return
      if (!commandPending.current) {
        const requestGeneration = generation.current
        const controller = new AbortController()
        controllers.current.add(controller)
        const timeout = setTimeout(() => controller.abort(), 10_000)
        try {
          const response = await fetch(`${serviceUrl}/status`, { cache: 'no-store', signal: controller.signal })
          if (!response.ok) throw new Error('service-unavailable')
          const next = parseServiceStatus(await response.json())
          if (active && generation.current === requestGeneration) {
            setStatus(next)
            setConnection(next.available ? 'connected' : 'unavailable')
          }
        } catch {
          if (active && generation.current === requestGeneration) setConnection('unavailable')
        } finally {
          clearTimeout(timeout)
          controllers.current.delete(controller)
        }
      }
      if (active) timer = setTimeout(() => { void poll() }, 1000)
    }
    void poll()
    const ownedControllers = controllers.current
    return () => {
      active = false
      mounted.current = false
      generation.current += 1
      clearTimeout(timer)
      for (const controller of ownedControllers) controller.abort()
      ownedControllers.clear()
    }
  }, [])

  const command = async (action: 'run' | 'stop', config?: ParallelFetchConfig): Promise<ParallelFetchServiceStatus | null> => {
    if (!import.meta.env.DEV || commandPending.current || !status?.token || connection !== 'connected') return null
    commandPending.current = true
    const requestGeneration = ++generation.current
    setPending(true)
    setCommandError(null)
    const controller = new AbortController()
    controllers.current.add(controller)
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(`${serviceUrl}/${action}`, { method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Parallel-Fetch-Token': status.token },
        body: JSON.stringify(config ?? {}), signal: controller.signal })
      if (!response.ok) throw new Error('command-failed')
      const next = parseServiceStatus(await response.json())
      if (!mounted.current || generation.current !== requestGeneration) return null
      setStatus(next)
      setConnection(next.available ? 'connected' : 'unavailable')
      return next
    } catch {
      if (mounted.current && generation.current === requestGeneration) {
        setCommandError(action === 'run' ? '開始を確認できません。取得状況を再確認しています。' : '停止を確認できません。取得状況を再確認しています。')
      }
      return null
    } finally {
      clearTimeout(timeout)
      controllers.current.delete(controller)
      commandPending.current = false
      if (mounted.current && generation.current === requestGeneration) setPending(false)
    }
  }
  return { status, connection, pending, commandError, command }
}

function retryCount(trial: ParallelFetchTrial) {
  const keys = new Set<string>()
  let retries = 0
  for (const attempt of trial.attempts) {
    const key = `${attempt.phase}:${attempt.phase === 'prepare' ? attempt.worker : ''}:${attempt.page}`
    if (keys.has(key)) retries += 1
    keys.add(key)
  }
  return retries
}

function RecordedTime({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{timestampLabel(value)}</time> : <>—</>
}

function IntervalInput({ value, onChange, error, errorId }: { value: string; onChange: (text: string) => void; error: string | null; errorId: string }) {
  return <label><span>取得開始間隔（秒・カンマ区切り）</span>
    <input type="text" aria-label="取得開始間隔" value={value} onChange={event => onChange(event.target.value)}
      autoComplete="off" spellCheck={false} maxLength={128} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} />
  </label>
}

function IntervalScopeInput({ value, onChange, name }: { value: ParallelFetchIntervalScope; onChange: (value: ParallelFetchIntervalScope) => void; name: string }) {
  return <fieldset className="parallel-fetch-choice parallel-fetch-scope"><legend>間隔の適用範囲</legend>
    {(['global', 'per-tab'] as const).map(scope => <label key={scope} className={value === scope ? 'is-selected' : ''}>
      <input type="radio" name={name} value={scope} checked={value === scope} onChange={() => onChange(scope)} />
      <span>{parallelFetchIntervalScopeLabels[scope]}</span>
    </label>)}
  </fieldset>
}

function ExecutionPlan({ config }: { config: ParallelFetchConfig }) {
  const rows = parallelFetchPlanRows(config)
  return <div className="parallel-fetch-plan">
    <div className="parallel-fetch-progress-heading"><strong>実行順</strong><span>{parallelFetchIntervalScopeLabel(config)} · {parallelFetchIntervals(config).length * config.concurrencies.length} 条件 · 測定 {rows.length * config.pageCount} ページ</span></div>
    <ol>{rows.map(row => <li key={`${row.intervalMs}-${row.concurrency}-${row.repetition}`}>
      {row.intervalMs / 1000} 秒 · 並列 {row.concurrency}{config.repetitions > 1 && <> · {row.repetition} 回目</>}
    </li>)}</ol>
  </div>
}

function Conditions({ config }: { config: ParallelFetchConfig }) {
  return <dl className="parallel-fetch-details">
    <div><dt>対象</dt><dd>{config.target === 'lp' ? 'LP · 総合・最大LP' : 'MR · 総合・最大MR・現在のACT'} · 全地域・全プラットフォーム</dd></div>
    <div><dt>測定ページ</dt><dd>{numberLabel(config.startPage)}〜{numberLabel(config.startPage + config.pageCount - 1)}（各 {config.pageCount} ページ）</dd></div>
    <div><dt>比較条件</dt><dd>並列 {config.concurrencies.join('・')} · 各 {config.repetitions} 回</dd></div>
    <div><dt>取得開始間隔</dt><dd>{parallelFetchIntervals(config).map(value => value / 1000).join('・')} 秒</dd></div>
    <div><dt>間隔の適用範囲</dt><dd>{parallelFetchIntervalScopeLabel(config)}</dd></div>
  </dl>
}

function Results({ report }: { report: ParallelFetchReport }) {
  const rows = useMemo(() => summarizeParallelFetch(report), [report])
  const totals = report.trials.flatMap(trial => trial.attempts).flatMap(attempt => attempt.totalPages === null ? [] : [attempt.totalPages])
  const totalRange = totals.length ? `${numberLabel(Math.min(...totals))}〜${numberLabel(Math.max(...totals))} ページ` : '未確認'
  return <div className="parallel-fetch-results">
    <Conditions config={report.config} />
    <dl className="parallel-fetch-details">
      <div><dt>取得開始</dt><dd><RecordedTime value={report.startedAt} /></dd></div>
      <div><dt>取得終了</dt><dd><RecordedTime value={report.finishedAt} /></dd></div>
      <div><dt>観測した総ページ数</dt><dd>{totalRange}</dd></div>
      <div><dt>集計</dt><dd>完走した測定の中央値 · 失敗・再読は全測定の合計</dd></div>
      <div><dt>直列比の基準</dt><dd>{report.config.concurrencies.includes(1) ? '同じ適用範囲・取得間隔の並列1' : '並列1未選択'}</dd></div>
      <div><dt>失敗率の分母</dt><dd>準備・再読を含む取得回数</dd></div>
    </dl>
    <div className="data-table-scroll parallel-fetch-scroll" role="region" tabIndex={0} aria-label="取得間隔・並列数別の比較結果・横スクロール領域">
      <table className="data-table parallel-fetch-comparison"><caption className="parallel-fetch-visually-hidden">同じページを取得した取得間隔・並列数別の測定結果</caption>
        <thead><tr><th scope="col">間隔</th><th scope="col">並列数</th><th scope="col">状態</th><th scope="col">完走回数</th><th scope="col">所要時間<span>中央値</span></th><th scope="col">ページ／分</th><th scope="col">直列比</th><th scope="col">全巡回<span>参考概算</span></th><th scope="col">成功<span>ページ</span></th><th scope="col">失敗<span>回／率</span></th><th scope="col">再読<span>回</span></th></tr></thead>
        <tbody>{rows.map(row => { const condition = parallelFetchConditionStatus(report, row.intervalMs, row.concurrency); return <tr key={`${row.intervalMs}-${row.concurrency}`}>
          <th scope="row">{row.intervalMs / 1000} 秒</th><th scope="row">{row.concurrency}</th>
          <td className="parallel-fetch-state-cell">{conditionStateLabels[condition.state]}{condition.errorCode && <span>{errorLabels[condition.errorCode]}</span>}</td>
          <td>{row.completedTrials} / {row.plannedTrials}</td><td>{durationLabel(row.medianMs)}</td>
          <td>{row.pagesPerMinute === null ? '—' : numberLabel(row.pagesPerMinute)}</td><td>{row.speedup === null ? '算出不可' : `${numberLabel(row.speedup)} 倍`}</td>
          <td>{estimateLabel(row.estimatedFullScanMs)}</td><td>{condition.started ? row.successfulPages : '—'}</td><td>{condition.attempted ? `${row.failedAttempts} 回` : '—'}<span className="parallel-fetch-failure-rate">{row.failedAttemptRate === null ? '—' : `${numberLabel(row.failedAttemptRate * 100)}%`}</span></td><td>{condition.attempted ? row.retries : '—'}</td>
        </tr> })}</tbody>
      </table>
    </div>
    {report.trials.length > 0 && <div className="data-table-scroll parallel-fetch-scroll" role="region" tabIndex={0} aria-label="各測定の記録・横スクロール領域">
      <table className="data-table parallel-fetch-trials"><caption>各測定の記録</caption>
        <thead><tr><th scope="col">間隔・並列・回</th><th scope="col">状態</th><th scope="col">成功ページ</th><th scope="col">準備時間</th><th scope="col">測定時間</th><th scope="col">合計時間</th><th scope="col">失敗／再読</th></tr></thead>
        <tbody>{report.trials.map(trial => <tr key={`${trial.intervalMs ?? report.config.intervalMs}-${trial.concurrency}-${trial.repetition}`}>
          <th scope="row">{(trial.intervalMs ?? report.config.intervalMs) / 1000} 秒 · 並列 {trial.concurrency} · {trial.repetition} 回目</th>
          <td className="parallel-fetch-state-cell">{trialStateLabels[trial.state]}{trial.errorCode && <span>{errorLabels[trial.errorCode]}</span>}</td>
          <td>{trial.completedPages.length} / {report.config.pageCount}</td><td>{durationLabel(trial.preparationMs)}</td>
          <td>{durationLabel(trial.measurementMs)}</td><td>{durationLabel(trial.totalMs)}</td>
          <td>{trial.attempts.filter(attempt => attempt.errorCode !== null).length} / {retryCount(trial)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </div>
}

function ConcurrencyInput({ value, onChange, error, errorId }: { value: string; onChange: (text: string) => void; error: string | null; errorId: string }) {
  return <label><span>並列数（1〜{PARALLEL_FETCH_MAX_CONCURRENCY}・カンマ区切り）</span>
    <input type="text" aria-label="並列数" value={value} onChange={event => onChange(event.target.value)}
      autoComplete="off" spellCheck={false} maxLength={128} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} />
  </label>
}

export function ParallelFetchTestPage() {
  const [environment, setEnvironment] = useState<'local' | 'github-actions'>('local')
  const [cloudMode, setCloudMode] = useState<CloudMode>('interval-compare')
  const [cloudOptions, setCloudOptions] = useState<CloudIntervalOptions>(() => structuredClone(DEFAULT_CLOUD_INTERVAL_OPTIONS))
  const [config, setConfig] = useState<ParallelFetchConfig>(() => ({ ...DEFAULT_PARALLEL_FETCH_CONFIG, intervalScope: 'global', intervalMsList: [5000, 3000], concurrencies: [...DEFAULT_PARALLEL_FETCH_CONFIG.concurrencies] }))
  const [concurrencyText, setConcurrencyText] = useState(DEFAULT_PARALLEL_FETCH_CONFIG.concurrencies.join(','))
  const [cloudConcurrencyText, setCloudConcurrencyText] = useState(DEFAULT_CLOUD_INTERVAL_OPTIONS.concurrencies.join(','))
  const [intervalText, setIntervalText] = useState('5,3')
  const [cloudIntervalText, setCloudIntervalText] = useState(DEFAULT_CLOUD_INTERVAL_OPTIONS.intervalMsList.map(value => value / 1000).join(','))
  const [startPage, setStartPage] = useState(String(DEFAULT_PARALLEL_FETCH_CONFIG.startPage))
  const [localHistory, setLocalHistory] = useState<ParallelFetchResult[]>([])
  const [imports, setImports] = useState<ParallelFetchResult[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const importGeneration = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const service = useParallelFetchService()
  const cloud = useParallelFetchCloud(environment === 'github-actions')
  const liveReport = service.status?.report ?? null
  const running = liveReport?.state === 'running'
  const cloudRunning = !!cloud.status?.runs.some(isCloudRunActive)
  const busy = running || service.pending || cloudRunning || cloud.pending || cloud.unconfirmed
  const concurrency = parallelFetchConcurrencyDraft(concurrencyText)
  const cloudConcurrency = parallelFetchConcurrencyDraft(cloudConcurrencyText)
  const interval = parallelFetchIntervalDraft(intervalText)
  const cloudInterval = parallelFetchIntervalDraft(cloudIntervalText)
  const cloudSelectedOptions: CloudIntervalOptions = { ...cloudOptions, intervalScope: cloudOptions.intervalScope ?? 'global', intervalMsList: cloudInterval.values, concurrencies: cloudConcurrency.values }
  const cloudPreset: ParallelFetchConfig = cloudMode === 'interval-compare'
    ? { ...cloudConfig(cloudMode), ...cloudSelectedOptions, intervalMs: cloudInterval.values[0] ?? 5000 }
    : cloudConfig(cloudMode)
  const cloudInputError = cloudMode === 'interval-compare' ? cloudInterval.error ?? cloudConcurrency.error : null
  const cloudConfigError = cloudInputError ?? parallelFetchConfigError(cloudPreset)
  const cloudStateInvalid = cloud.status?.error === 'state-invalid' || cloud.status?.error === 'state-save-failed'
  const choices = useMemo<ResultChoice[]>(() => {
    const local = liveReport ? [resultEnvelope(liveReport, 'local'), ...localHistory.filter(item => item.report.runId !== liveReport.runId)] : localHistory
    return [
      ...imports.map(result => ({ key: `import:${result.environment}:${result.report.runId}`, label: `読込 · ${resultLabel(result)}`, result, cloud: result.cloud })),
      ...local.map(result => ({ key: `local:${result.report.runId}`, label: resultLabel(result), result, cloud: null })),
      ...(cloud.status?.runs ?? []).map(run => ({ key: `cloud:${run.requestId}`, label: `GitHub Actions${run.runId ? ` #${run.runId}` : ''} · ${timestampLabel(run.createdAt)} · ${parallelFetchIntervalScopeLabel(run.report?.config ?? cloudConfig(run.mode, run.options, { historical: true }))} · ${cloudStateLabels[run.state]}`,
        result: run.report ? resultEnvelope(run.report, 'github-actions', run) : null, cloud: run })),
    ]
  }, [liveReport, localHistory, imports, cloud.status?.runs])
  const selected = choices.find(choice => choice.key === selectedKey) ?? (selectedKey === null ? choices[0] : null)
  const result = selected?.result ?? null
  const report = result?.report ?? null
  const latestTrial = liveReport?.trials.at(-1)
  const cloudRun = cloud.status?.runs.find(run => run.requestId === cloud.status?.activeRequestId)
    ?? cloud.status?.runs.find(run => selected?.cloud?.requestId === run.requestId)
    ?? [...(cloud.status?.runs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  const draft = { ...config, startPage: Number(startPage), concurrencies: concurrency.values, intervalMs: interval.values[0] ?? 5000, intervalMsList: interval.values }
  const configError = concurrency.error ?? interval.error ?? parallelFetchConfigError(draft)
  const planned = configError ? null : plannedParallelFetchAttempts(draft)
  let validConfig: ParallelFetchConfig | null = null
  if (!configError) try { validConfig = parseParallelFetchConfig(draft) } catch { /* Invalid form values stay editable. */ }
  const connected = service.connection === 'connected'
  const connectionLabel = service.connection === 'static' ? '結果JSONの表示モード'
    : service.connection === 'checking' ? '取得サービスを確認中'
      : !connected ? '取得サービスに接続できません'
        : service.status?.sessionAvailable ? '接続済み · 保存済みログイン情報あり' : '接続済み · 保存済みログイン情報なし'
  const runState = !liveReport ? '未実行' : liveReport.state === 'running' ? latestTrial?.state === 'preparing' ? '準備中' : '測定中'
    : liveReport.state === 'complete' ? '完了' : liveReport.state === 'stopped' ? '停止' : '失敗'
  useEffect(() => () => { importGeneration.current += 1 }, [])
  useEffect(() => {
    if (!liveReport || liveReport.state === 'running') return
    setLocalHistory(previous => {
      const saved = previous.find(item => item.report.runId === liveReport.runId)
      if (saved && JSON.stringify(saved.report) === JSON.stringify(liveReport)) return previous
      return [resultEnvelope(liveReport, 'local'), ...previous.filter(item => item.report.runId !== liveReport.runId)].slice(0, 20)
    })
  }, [liveReport])
  useEffect(() => {
    if (selectedKey === null && choices.length) setSelectedKey(choices[0].key)
  }, [selectedKey, choices])

  const run = async (event: FormEvent) => {
    event.preventDefault()
    if (!validConfig || busy || importing || !connected || !service.status?.sessionAvailable) return
    setFileError(null)
    const started = await service.command('run', validConfig)
    if (started?.report) setSelectedKey(`local:${started.report.runId}`)
  }
  const runCloud = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || importing || cloudStateInvalid || cloudConfigError || cloud.connection !== 'connected' || cloud.status?.readiness !== 'ready') return
    setFileError(null)
    const next = await cloud.command('run', cloudMode === 'interval-compare' ? { mode: cloudMode, options: cloudSelectedOptions } : { mode: cloudMode })
    if (next?.activeRequestId) setSelectedKey(`cloud:${next.activeRequestId}`)
  }
  const importReport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busy) return
    const generation = ++importGeneration.current
    setImporting(true)
    setFileError(null)
    try {
      if (file.size > MAX_REPORT_BYTES) throw new Error('too-large')
      const next = parseParallelFetchResult(JSON.parse(await file.text()))
      if (importGeneration.current === generation) {
        setImports(previous => [next, ...previous.filter(item => item.report.runId !== next.report.runId || item.environment !== next.environment)].slice(0, 20))
        setSelectedKey(`import:${next.environment}:${next.report.runId}`)
      }
    } catch {
      if (importGeneration.current === generation) setFileError(file.size > MAX_REPORT_BYTES ? 'JSONは 2 MB 以下で指定してください。' : '並列取得テストの有効な結果JSONではありません。')
    } finally {
      if (importGeneration.current === generation) setImporting(false)
    }
  }
  const exportReport = () => {
    if (!result) return
    const sanitized = parseParallelFetchResult(result)
    const url = URL.createObjectURL(new Blob([JSON.stringify(sanitized, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `parallel-fetch-${sanitized.environment}-${sanitized.report.startedAt.slice(0, 10)}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <section className="parallel-fetch-page" aria-label="並列取得テスト">
    <div className="parallel-fetch-top">
      <StatisticsPanel title="テスト条件" headerContent={<span className="monthly-statistics-panel-summary">同じページで比較</span>}>
        <fieldset className="parallel-fetch-choice parallel-fetch-environment"><legend>実行先</legend>
          {(['local', 'github-actions'] as const).map(value => <label key={value} className={environment === value ? 'is-selected' : ''}>
            <input type="radio" name="parallel-fetch-environment" value={value} checked={environment === value} disabled={service.pending || cloud.pending} onChange={() => setEnvironment(value)} />
            <span>{environmentLabels[value]}</span>
          </label>)}
        </fieldset>
        {environment === 'local' ? <form onSubmit={event => { void run(event) }}>
          <fieldset className="parallel-fetch-fields" disabled={busy} aria-label="取得条件">
            <label><span>対象</span><select aria-label="対象" value={config.target} onChange={event => setConfig({ ...config, target: event.target.value as ParallelFetchConfig['target'] })}><option value="lp">LPランキング</option><option value="mr">MRランキング</option></select></label>
            <label><span>開始ページ</span><input aria-label="開始ページ" type="number" inputMode="numeric" min={1} max={1000000} step={1} value={startPage} aria-invalid={!Number.isInteger(Number(startPage)) || Number(startPage) < 1 || Number(startPage) > 1000000} onChange={event => setStartPage(event.target.value)} /></label>
            <label><span>測定ページ数</span><select aria-label="測定ページ数" value={config.pageCount} onChange={event => setConfig({ ...config, pageCount: Number(event.target.value) as 20 | 50 })}><option value={20}>20 ページ</option><option value={50}>50 ページ</option></select></label>
            <ConcurrencyInput value={concurrencyText} onChange={setConcurrencyText} error={concurrency.error} errorId="parallel-fetch-config-error" />
            <label><span>繰り返し</span><select aria-label="繰り返し" value={config.repetitions} onChange={event => setConfig({ ...config, repetitions: Number(event.target.value) as 1 | 3 })}><option value={1}>各 1 回</option><option value={3}>各 3 回</option></select></label>
            <IntervalInput value={intervalText} onChange={setIntervalText} error={interval.error} errorId="parallel-fetch-config-error" />
            <IntervalScopeInput value={parallelFetchIntervalScope(config)} onChange={intervalScope => setConfig({ ...config, intervalScope })} name="parallel-fetch-local-scope" />
          </fieldset>
          {!configError && <ExecutionPlan config={draft} />}
          <div className="parallel-fetch-actions"><span>準備＋測定 {planned ?? '—'} / {PARALLEL_FETCH_MAX_ATTEMPTS} 回</span><button type="submit" disabled={!validConfig || busy || importing || !connected || !service.status?.sessionAvailable}>テスト開始</button></div>
          {configError && <p id="parallel-fetch-config-error" className="parallel-fetch-message" role="alert">{configError}</p>}
        </form> : <form onSubmit={event => { void runCloud(event) }} className="parallel-fetch-cloud-conditions">
          <label className="parallel-fetch-mode"><span>テスト内容</span><select aria-label="Actionsのテスト内容" value={cloudMode} disabled={busy} onChange={event => setCloudMode(event.target.value as CloudMode)}>
            <option value="interval-compare">取得間隔 × 並列数</option><option value="serial">直列を3回</option><option value="compare">並列1・2を比較</option>
          </select></label>
          {cloudMode === 'interval-compare' && <fieldset className="parallel-fetch-fields" disabled={busy} aria-label="Actionsの比較条件">
            <IntervalInput value={cloudIntervalText} onChange={setCloudIntervalText} error={cloudInterval.error} errorId="parallel-fetch-cloud-config-error" />
            <ConcurrencyInput value={cloudConcurrencyText} onChange={setCloudConcurrencyText} error={cloudConcurrency.error} errorId="parallel-fetch-cloud-config-error" />
            <label><span>繰り返し</span><select aria-label="Actionsの繰り返し" value={cloudOptions.repetitions} onChange={event => setCloudOptions({ ...cloudOptions, repetitions: Number(event.target.value) as 1 | 3 })}><option value={1}>各 1 回</option><option value={3}>各 3 回</option></select></label>
            <IntervalScopeInput value={cloudOptions.intervalScope ?? 'global'} onChange={intervalScope => setCloudOptions({ ...cloudOptions, intervalScope })} name="parallel-fetch-cloud-scope" />
          </fieldset>}
          {!cloudConfigError && <Conditions config={cloudPreset} />}
          {cloudMode === 'interval-compare' && !cloudConfigError && <ExecutionPlan config={cloudPreset} />}
          <dl className="parallel-fetch-details"><div><dt>取得認証</dt><dd>Actionsでの実行時に確認</dd></div></dl>
          <div className="parallel-fetch-actions"><span>準備＋測定 {cloudConfigError ? '—' : plannedParallelFetchAttempts(cloudPreset)} / {PARALLEL_FETCH_MAX_ATTEMPTS} 回</span>
            {import.meta.env.DEV ? <button type="submit" disabled={busy || importing || cloudConfigError !== null || cloudStateInvalid || cloud.connection !== 'connected' || cloud.status?.readiness !== 'ready'}>Actionsで開始</button>
              : <a href={CLOUD_WORKFLOW_URL} target="_blank" rel="noreferrer">GitHub Actionsで開く</a>}
          </div>
          {cloudConfigError && <p id="parallel-fetch-cloud-config-error" className="parallel-fetch-message" role="alert">{cloudConfigError}</p>}
        </form>}
      </StatisticsPanel>
      <StatisticsPanel title="実行状況" headerContent={<span className="monthly-statistics-panel-summary">{environmentLabels[environment]}</span>}>
        {environment === 'github-actions' ? <CloudStatus cloud={cloud} run={cloudRun} /> : <div className="parallel-fetch-status">
          <p className="parallel-fetch-connection" role="status">{connectionLabel}</p>
          {service.status?.error === 'report-save-failed' && <p className="parallel-fetch-message" role="alert">結果の自動保存に失敗しました。JSONの保存は利用できます。</p>}
          {service.commandError && <p className="parallel-fetch-message" role="alert">{service.commandError}</p>}
          <div className="parallel-fetch-progress-heading"><strong role="status" aria-live="polite">{runState}{liveReport && <> · {parallelFetchIntervalScopeLabel(liveReport.config)}</>}{latestTrial && <> · {(latestTrial.intervalMs ?? liveReport!.config.intervalMs) / 1000} 秒 · 並列 {latestTrial.concurrency} · {latestTrial.repetition} / {liveReport!.config.repetitions} 回目</>}</strong>
            {running && <button type="button" disabled={service.pending || !connected} onClick={() => { void service.command('stop') }}>停止</button>}
          </div>
          {liveReport?.errorCode && <p className="parallel-fetch-message" role="status">{errorLabels[liveReport.errorCode]}</p>}
          {latestTrial ? <>
            <progress aria-label="現在の測定で取得したページ" value={latestTrial.completedPages.length} max={liveReport!.config.pageCount} />
            <p className="parallel-fetch-counts">成功 {latestTrial.completedPages.length} / {liveReport!.config.pageCount} ページ · 失敗 {latestTrial.attempts.filter(attempt => attempt.errorCode !== null).length} 回 · 再読 {retryCount(latestTrial)} 回</p>
            <ul className="parallel-fetch-workers">{latestTrial.workers.map(worker => <li key={worker.id}><span>タブ {worker.id}</span><span>{worker.page === null ? '—' : `P${numberLabel(worker.page)}`}</span><span>{workerStateLabels[worker.state]}</span><span>{worker.completedPages} ページ完了</span></li>)}</ul>
          </> : <p className="parallel-fetch-empty">{liveReport ? '測定準備中' : '測定結果なし'}</p>}
          <p className="parallel-fetch-source">出典：<a href={`https://www.streetfighter.com/6/buckler/ja-jp/ranking/${(liveReport?.config.target ?? config.target) === 'lp' ? 'league' : 'master'}`} target="_blank" rel="noreferrer">Bucklerランキング</a></p>
        </div>}
      </StatisticsPanel>
    </div>
    <StatisticsPanel title="比較結果" headerContent={<div className="parallel-fetch-file-actions">
      <input ref={fileInput} className="parallel-fetch-visually-hidden" tabIndex={-1} type="file" accept=".json,application/json" aria-label="結果JSON" onChange={event => { void importReport(event) }} />
      <button type="button" disabled={busy || importing} onClick={() => fileInput.current?.click()}>{importing ? '読込中…' : 'JSONを読み込む'}</button>
      <button type="button" disabled={!report} onClick={exportReport}>JSONを保存</button>
    </div>}>
      {fileError && <p className="parallel-fetch-message" role="alert">{fileError}</p>}
      {choices.length > 0 && <label className="parallel-fetch-history"><span>表示する結果</span><select aria-label="表示する結果" value={selected?.key ?? ''} onChange={event => setSelectedKey(event.target.value)}>
        {!selected && <option value="">結果を選択</option>}{choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
      </select></label>}
      {report && result ? <div className="parallel-fetch-results">
        <dl className="parallel-fetch-details parallel-fetch-result-source"><div><dt>実行先</dt><dd>{environmentLabels[result.environment]}{selected?.key.startsWith('import:') && ' · JSON読込'}</dd></div>
          <div><dt>取得状態</dt><dd>{trialStateLabels[report.state]}{report.errorCode && <> · {errorLabels[report.errorCode]}</>}</dd></div>
          {result.cloud?.runId && <div><dt>Actions実行</dt><dd><a href={cloudRunUrl(result.cloud.runId)} target="_blank" rel="noreferrer">#{result.cloud.runId}</a> · 試行 {result.cloud.runAttempt}</dd></div>}
          {result.cloud?.headSha && <div><dt>実行コード</dt><dd>{result.cloud.headSha.slice(0, 12)}</dd></div>}
        </dl><Results report={report} />
      </div> : <p className="parallel-fetch-empty">{selected?.cloud ? `${cloudStateLabels[selected.cloud.state]} · 測定結果は未取得` : '未取得'}</p>}
    </StatisticsPanel>
  </section>
}
