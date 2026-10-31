import { timestampLabel } from '../lib/dateTime'
import { parallelFetchIntervals } from '../lib/parallelFetch'
import { CLOUD_WORKFLOW_URL, cloudConfig, cloudRunUrl, isCloudRunActive } from '../lib/parallelFetchCloud'
import { cloudErrorLabels, cloudModeLabels, cloudStateLabels, errorLabels, readinessLabels } from '../lib/parallelFetchLabels'
import { parallelFetchIntervalScopeLabel } from '../lib/parallelFetchPresentation'
import type { useParallelFetchCloud } from '../lib/useParallelFetchCloud'
import type { CloudRun } from '../types/parallelFetchCloud'

type Props = { cloud: ReturnType<typeof useParallelFetchCloud>; run: CloudRun | null; compact?: boolean }

function RecordedTime({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{timestampLabel(value)}</time> : <>—</>
}

export function ParallelFetchCloudStatus({ cloud, run, compact = false }: Props) {
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
    {run && !compact && <dl className="parallel-fetch-details">
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
