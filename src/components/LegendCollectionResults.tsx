import { useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import type { LegendCollectionRun } from '../lib/legendCollectionHistory'
import { cloudRunUrl } from '../lib/parallelFetchCloud'
import { CollectionHistoryDialog } from './CollectionHistoryDialog'

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const outcomeLabels: Record<LegendCollectionRun['outcome'], string> = {
  succeeded: '取得完了',
  partial: '順位・MRのみ保存',
  stopped: '取得停止',
  'save-failed': '保存失敗',
}
const phaseLabels: Record<LegendCollectionRun['phase'], string> = {
  unknown: '不明',
  preparation: '準備',
  listing: '順位・MR',
  profiles: '対戦数',
  saving: '保存',
  complete: '完了',
}
const reasonLabels: Record<NonNullable<LegendCollectionRun['reason']>, string> = {
  captcha: 'CAPTCHA',
  'human-verification': '人間確認',
  'authentication-unavailable': 'ログイン状態を確認できず',
  'source-unconfirmed': '取得元の内容を確認できず',
  'source-changed': '取得中に掲載内容が変動',
  'access-unavailable': '取得元にアクセスできず',
  cancelled: 'キャンセル',
  'request-limit': '通信回数の上限',
  'collection-failed': '取得処理のエラー',
  'output-unavailable': '保存するデータを確認できず',
}

type ResultsProps = {
  status: 'loading' | 'ready' | 'error'
  runs: readonly LegendCollectionRun[]
  retry: () => void
}

function outcomeLabel(run: LegendCollectionRun): string {
  if (run.outcome === 'stopped' && (run.reason === 'captcha' || run.reason === 'human-verification')) {
    return `${reasonLabels[run.reason]}で停止`
  }
  return outcomeLabels[run.outcome]
}

function LegendRunTimes({ startedAt, endedAt }: Pick<LegendCollectionRun, 'startedAt' | 'endedAt'>) {
  const end = timestampLabel(endedAt)
  if (!startedAt) return <>終了 <time dateTime={endedAt}>{end}</time></>
  const start = timestampLabel(startedAt).replace(/ JST$/, '')
  const datePrefix = `${start.split(' ')[0]} `
  const endTime = end.startsWith(datePrefix) ? end.slice(datePrefix.length) : end
  return <><time dateTime={startedAt}>{start}</time><span>〜</span><time dateTime={endedAt}>{endTime}</time></>
}

function LegendRunEntry({ run }: { run: LegendCollectionRun }) {
  const rankCount = run.datasetId !== null && run.rankingCount !== null ? integerFormat.format(run.rankingCount) : null
  const matchCount = rankCount !== null && run.rankedMatchCount !== null ? integerFormat.format(run.rankedMatchCount) : null
  const stoppedPage = run.phase === 'listing' ? run.lastAttemptedPage : null
  const matchesNotStarted = run.phase === 'listing' || run.phase === 'preparation'
  const actionsUrl = cloudRunUrl(run.runId)

  return <li className="legend-collection-run">
    <div className="legend-collection-run-heading">
      <div className="legend-collection-run-time">
        <LegendRunTimes startedAt={run.startedAt} endedAt={run.endedAt} />
        <span>· {run.trigger === 'schedule' ? '定期' : '手動'}</span>
        {run.runAttempt > 1 && <span>· 試行 {run.runAttempt}</span>}
      </div>
      <strong>{outcomeLabel(run)}</strong>
    </div>
    <dl className="legend-collection-run-details">
      <div><dt>順位・MR</dt><dd>{rankCount !== null ? `${rankCount}件保存`
        : stoppedPage !== null ? `${integerFormat.format(stoppedPage)}ページ目で停止`
          : run.phase === 'preparation' ? '未実施' : '未保存'}</dd></div>
      <div><dt>対戦数</dt><dd>{run.outcome === 'partial' ? '未取得'
        : matchCount !== null ? `${matchCount}/${rankCount}件に記録`
          : matchesNotStarted ? '未実施' : '未保存'}</dd></div>
      {run.outcome !== 'succeeded' && <>
        {stoppedPage === null && <div><dt>停止工程</dt><dd>{phaseLabels[run.phase]}</dd></div>}
        {run.reason && <div><dt>理由</dt><dd>{reasonLabels[run.reason]}</dd></div>}
        {run.datasetId === null && <div><dt>新規保存</dt><dd>なし</dd></div>}
      </>}
    </dl>
    <a href={`${actionsUrl}/attempts/${run.runAttempt}`} target="_blank" rel="noreferrer">
      Actionsで開く<span className="win-rates-visually-hidden">（{timestampLabel(run.endedAt)}、新しいタブ）</span>
    </a>
  </li>
}

export function LegendCollectionResultsDialog({ status, runs, retry, onClose }: ResultsProps & { onClose: () => void }) {
  return <CollectionHistoryDialog title="取得結果" className="legend-collection-dialog" onClose={onClose}>
    <div className="legend-collection-dialog-content">
      {status === 'loading' && <p role="status">取得結果を読み込み中…</p>}
      {status === 'error' && <div className="legend-players-status" role="alert">
        <span>取得結果の読込失敗</span>
        <button type="button" className="win-rates-button" onClick={retry}>再読み込み</button>
      </div>}
      {status === 'ready' && runs.length === 0 && <p role="status">履歴未記録</p>}
      {runs.length > 0 && <ol className="legend-collection-runs" role="list" aria-label="直近の実行">
        {runs.map(run => <LegendRunEntry key={`${run.runId}-${run.runAttempt}`} run={run} />)}
      </ol>}
    </div>
  </CollectionHistoryDialog>
}

export function LegendCollectionResults({ status, runs, retry }: ResultsProps) {
  const [open, setOpen] = useState(false)
  const latest = runs[0]
  return <div className="legend-collection-summary">
    <button type="button" className="win-rates-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>取得結果</button>
    <span role="status">{latest ? <>{status === 'ready' ? '直近：' : '最終記録：'}<strong>{outcomeLabel(latest)}</strong></>
      : status === 'error' ? '取得結果の読込失敗' : status === 'ready' ? '履歴未記録' : '読込中…'}</span>
    {open && <LegendCollectionResultsDialog status={status} runs={runs} retry={retry} onClose={() => setOpen(false)} />}
  </div>
}
