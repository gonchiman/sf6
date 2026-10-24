import { minimumPlannedWaitMs, parallelFetchIntervals, parallelFetchIntervalScope, PARALLEL_FETCH_MAX_ATTEMPTS, PARALLEL_FETCH_MAX_DURATION_MS, parseParallelFetchConcurrencyInput, parseParallelFetchConfig, parseParallelFetchIntervalInput, plannedParallelFetchAttempts } from './parallelFetch.ts'
import type { ParallelFetchConfig, ParallelFetchIntervalScope, ParallelFetchReport, ParallelFetchTrial } from '../types/parallelFetch.ts'

export const parallelFetchIntervalScopeLabels: Record<ParallelFetchIntervalScope, string> = { global: '全タブ共通', 'per-tab': 'タブごと' }

export function parallelFetchConcurrencyDraft(text: string): { values: number[]; error: string | null } {
  try { return { values: parseParallelFetchConcurrencyInput(text), error: null } }
  catch (error) { return { values: [], error: error instanceof Error ? error.message : '並列数を確認してください。' } }
}

export function parallelFetchIntervalDraft(text: string): { values: number[]; error: string | null } {
  try { return { values: parseParallelFetchIntervalInput(text), error: null } }
  catch (error) { return { values: [], error: error instanceof Error ? error.message : '取得開始間隔を確認してください。' } }
}

export function parallelFetchIntervalScopeLabel(config: ParallelFetchConfig): string {
  return parallelFetchIntervalScopeLabels[parallelFetchIntervalScope(config)]
}

export function parallelFetchConfigError(config: ParallelFetchConfig): string | null {
  if (!parallelFetchIntervals(config).length) return '取得開始間隔を1つ以上入力してください。'
  if (plannedParallelFetchAttempts(config) > PARALLEL_FETCH_MAX_ATTEMPTS) return `予定取得数が上限 ${PARALLEL_FETCH_MAX_ATTEMPTS} 回を超えています。`
  if (minimumPlannedWaitMs(config) >= PARALLEL_FETCH_MAX_DURATION_MS) return '開始間隔の待ち時間だけで10分に達します。条件数か繰り返しを減らしてください。'
  if (!Number.isInteger(config.startPage) || config.startPage < 1 || config.startPage > 1_000_000) return '開始ページは 1〜1,000,000 の整数で指定してください。'
  try { parseParallelFetchConfig(config); return null } catch { return '取得条件を確認してください。' }
}

export function parallelFetchPlanRows(config: ParallelFetchConfig) {
  return parallelFetchIntervals(config).flatMap(intervalMs => config.concurrencies.flatMap(concurrency =>
    Array.from({ length: config.repetitions }, (_, index) => ({ intervalMs, concurrency, repetition: index + 1 }))))
}

export function parallelFetchConditionStatus(report: ParallelFetchReport, intervalMs: number, concurrency: number) {
  const trials = report.trials.filter(trial => (trial.intervalMs ?? report.config.intervalMs) === intervalMs && trial.concurrency === concurrency)
  const last = trials.at(-1)
  const state: ParallelFetchTrial['state'] | 'not-run' | 'pending' = !last ? 'not-run'
    : last.state !== 'complete' ? last.state : trials.length === report.config.repetitions ? 'complete' : 'pending'
  return { state, errorCode: last?.errorCode ?? null, started: trials.length > 0, attempted: trials.some(trial => trial.attempts.length > 0) }
}
