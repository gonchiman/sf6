import {
  parallelFetchIntervals, parallelFetchIntervalScope, parseHistoricalParallelFetchConfig,
} from './parallelFetch.ts'
import { cloudConfig, sameParallelFetchConfig } from './parallelFetchCloud.ts'
import { parallelFetchConfigError, parallelFetchIntervalDraft } from './parallelFetchPresentation.ts'
import type { ParallelFetchAttempt, ParallelFetchConfig, ParallelFetchErrorCode, ParallelFetchReport, ParallelFetchTrial } from '../types/parallelFetch.ts'
import type { CloudIntervalOptions, CloudRun } from '../types/parallelFetchCloud.ts'

export const DEFAULT_FETCH_INTERVAL_INPUT = '10, 5'

export function fetchIntervalDraft(text: string): {
  config: ParallelFetchConfig | null
  options: CloudIntervalOptions | null
  error: string | null
} {
  const parsed = parallelFetchIntervalDraft(text)
  if (parsed.error) return { config: null, options: null, error: parsed.error }
  const options: CloudIntervalOptions = {
    intervalMsList: parsed.values, concurrencies: [1], repetitions: 1, intervalScope: 'global',
  }
  const candidate = cloudConfig('interval-compare', options, { historical: true })
  const error = parallelFetchConfigError(candidate)
  if (error) return { config: null, options: null, error }
  return { config: cloudConfig('interval-compare', options), options, error: null }
}

/** Retain historical records without applying today's execution-time budget. */
export function isFetchIntervalConfig(config: ParallelFetchConfig): boolean {
  try {
    const parsed = parseHistoricalParallelFetchConfig(config)
    return parsed.target === 'lp' && parsed.startPage === 1 && parsed.pageCount === 20
      && parsed.concurrencies.length === 1 && parsed.concurrencies[0] === 1 && parsed.repetitions === 1
      && parallelFetchIntervalScope(parsed) === 'global'
  } catch { return false }
}

export function isFetchIntervalRun(run: CloudRun): boolean {
  try {
    const config = cloudConfig(run.mode, run.options, { historical: true })
    return isFetchIntervalConfig(run.report?.config ?? config)
      && (!run.report || sameParallelFetchConfig(run.report.config, config))
  } catch { return false }
}

export type FetchIntervalMissingState = 'queued' | 'awaiting-result' | 'not-run' | 'unavailable'
export type FetchIntervalState = ParallelFetchTrial['state'] | FetchIntervalMissingState | 'incomplete'
export const fetchIntervalStateLabels: Record<FetchIntervalState, string> = {
  queued: '待機中', 'awaiting-result': '結果待ち', 'not-run': '未実行', unavailable: '記録未取得',
  preparing: '準備中', running: '測定中', complete: '完了', stopped: '停止', error: '失敗', incomplete: '未完了',
}

export interface FetchIntervalRow {
  intervalMs: number
  state: FetchIntervalState
  trial: ParallelFetchTrial | null
  completedPages: number | null
  measurementMs: number | null
  medianReadMs: number | null
  errorCode: ParallelFetchErrorCode | null
  lastAttempt: ParallelFetchAttempt | null
  locationLabel: string
  diagnosticLabels: string[]
}

function successfulMeasurementMedian(trial: ParallelFetchTrial): number | null {
  const durations = trial.attempts.filter(attempt => attempt.phase === 'measure' && attempt.errorCode === null
    && Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0).map(attempt => attempt.durationMs).sort((a, b) => a - b)
  if (!durations.length) return null
  const middle = Math.floor(durations.length / 2)
  return durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2
}

function completedMeasurement(config: ParallelFetchConfig, trial: ParallelFetchTrial): boolean {
  if (trial.state !== 'complete' || trial.errorCode !== null || trial.measurementMs === null
    || !Number.isFinite(trial.measurementMs) || trial.measurementMs <= 0
    || trial.completedPages.length !== config.pageCount) return false
  const measured = new Set(trial.attempts.filter(attempt => attempt.phase === 'measure' && attempt.errorCode === null).map(attempt => attempt.page))
  return new Set(trial.completedPages).size === config.pageCount
    && Array.from({ length: config.pageCount }, (_, index) => config.startPage + index)
      .every(page => measured.has(page) && trial.completedPages.includes(page))
}

function attemptDiagnostics(attempt: ParallelFetchAttempt | null): string[] {
  if (!attempt) return []
  const labels: string[] = []
  if (attempt.httpStatus !== null) labels.push(`HTTP ${attempt.httpStatus}`)
  const diagnostics = attempt.diagnostics
  if (!diagnostics) return labels
  const evidence = diagnostics.authenticationEvidence
  if (evidence === 'logout-control') labels.push('ログアウト表示あり')
  if (evidence === 'login-control') labels.push('ログイン表示あり')
  if (evidence === 'conflicting-controls') labels.push('ログイン・ログアウト表示が混在')
  if (evidence === 'no-control') labels.push('認証用の表示なし')
  if (diagnostics.loginRequiredHeading !== null) labels.push(diagnostics.loginRequiredHeading ? 'ログイン要求見出しあり' : 'ログイン要求見出しなし')
  if (diagnostics.rankingReadable !== null) labels.push(diagnostics.rankingReadable ? 'ランキング読取可' : 'ランキング読取不可')
  return labels
}

function locationLabel(trial: ParallelFetchTrial, completed: boolean, lastAttempt: ParallelFetchAttempt | null): string {
  if (completed) return `${trial.completedPages.length}ページ完了`
  const reading = trial.workers.find(worker => worker.state === 'reading')
  if (trial.state === 'preparing') return '準備中'
  if (trial.state === 'running' && reading?.page !== null && reading?.page !== undefined) return `測定 · ${reading.page}ページ目を取得中`
  if (!lastAttempt) return '記録なし'
  return `${lastAttempt.phase === 'prepare' ? '準備' : '測定'} · ${lastAttempt.page}ページ目${lastAttempt.errorCode === null ? 'まで完了' : 'で停止'}`
}

/** Build rows from recorded conditions, never from the editable draft of a later run. */
export function fetchIntervalRows(
  config: ParallelFetchConfig,
  report: ParallelFetchReport | null,
  missingState?: FetchIntervalMissingState,
): FetchIntervalRow[] {
  if (!isFetchIntervalConfig(config) || report && !sameParallelFetchConfig(config, report.config)) return []
  const absentState = missingState ?? (report?.state === 'running' ? 'queued' : 'not-run')
  return parallelFetchIntervals(config).map(intervalMs => {
    const trial = report?.trials.find(item => (item.intervalMs ?? report.config.intervalMs) === intervalMs && item.concurrency === 1 && item.repetition === 1) ?? null
    const lastAttempt = trial?.attempts.at(-1) ?? null
    const complete = trial !== null && completedMeasurement(config, trial)
    return {
      intervalMs,
      state: trial ? trial.state === 'complete' && !complete ? 'incomplete' : trial.state : absentState,
      trial,
      completedPages: trial?.completedPages.length ?? null,
      measurementMs: complete ? trial!.measurementMs : null,
      medianReadMs: trial ? successfulMeasurementMedian(trial) : null,
      errorCode: trial?.errorCode ?? null,
      lastAttempt,
      locationLabel: trial ? locationLabel(trial, complete, lastAttempt) : fetchIntervalStateLabels[absentState],
      diagnosticLabels: attemptDiagnostics(lastAttempt),
    }
  })
}
