import { PARALLEL_FETCH_ERRORS } from '../types/parallelFetch.ts'
import type { ParallelFetchAttempt, ParallelFetchConcurrency, ParallelFetchConfig, ParallelFetchErrorCode, ParallelFetchReadDiagnostics,
  ParallelFetchReport, ParallelFetchTrial, ParallelFetchWorker } from '../types/parallelFetch.ts'

export const PARALLEL_FETCH_MAX_ATTEMPTS = 200
export const DEFAULT_PARALLEL_FETCH_CONFIG: ParallelFetchConfig = {
  target: 'lp', startPage: 1, pageCount: 20, concurrencies: [1, 2], repetitions: 1, intervalMs: 5000,
}
const invalid = (): never => { throw new Error('並列取得テストの形式または条件が不正です。') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return invalid()
  return value as number
}
function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 7 * 86400000) return invalid()
  return value
}
function oneOf<T extends string | number>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) return invalid()
  return value as T
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid()
  return value
}
function errorCode(value: unknown): ParallelFetchErrorCode | null {
  return value === null ? null : oneOf(value, PARALLEL_FETCH_ERRORS)
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid()
  return value
}
export function parseParallelFetchReadDiagnostics(value: unknown): ParallelFetchReadDiagnostics {
  const input = object(value)
  function booleanOrNull(value: unknown): boolean | null {
    return value === null || typeof value === 'boolean' ? value : invalid()
  }
  return {
    authenticationEvidence: input.authenticationEvidence === null ? null : oneOf(input.authenticationEvidence,
      ['logout-control', 'login-control', 'conflicting-controls', 'no-control'] as const),
    loginRequiredHeading: booleanOrNull(input.loginRequiredHeading),
    rankingReadable: booleanOrNull(input.rankingReadable),
  }
}
export function plannedParallelFetchAttempts(config: ParallelFetchConfig): number {
  return config.repetitions * config.concurrencies.reduce((sum, concurrency) => sum + config.pageCount + concurrency, 0)
}
export function parseParallelFetchConfig(value: unknown): ParallelFetchConfig {
  const input = object(value)
  const concurrencies = list(input.concurrencies, 3).map(item => oneOf(item, [1, 2, 4] as const))
  if (concurrencies[0] !== 1 || new Set(concurrencies).size !== concurrencies.length
    || concurrencies.some((item, index) => index > 0 && item < concurrencies[index - 1])) return invalid()
  const result: ParallelFetchConfig = {
    target: oneOf(input.target, ['lp', 'mr']), startPage: integer(input.startPage, 1, 1000000),
    pageCount: oneOf(input.pageCount, [20, 50]), concurrencies,
    repetitions: oneOf(input.repetitions, [1, 3]), intervalMs: oneOf(input.intervalMs, [5000, 10000]),
  }
  if (plannedParallelFetchAttempts(result) > PARALLEL_FETCH_MAX_ATTEMPTS) return invalid()
  return result
}

function parseAttempt(value: unknown, config: ParallelFetchConfig, concurrency: number): ParallelFetchAttempt {
  const input = object(value)
  const phase = oneOf(input.phase, ['prepare', 'measure'])
  const page = integer(input.page, 1, 1000050)
  if (phase === 'prepare' ? page !== 1 : page < config.startPage || page >= config.startPage + config.pageCount) return invalid()
  const result: ParallelFetchAttempt = {
    worker: integer(input.worker, 1, concurrency), page, phase, startedAt: date(input.startedAt),
    durationMs: duration(input.durationMs), httpStatus: input.httpStatus === null ? null : integer(input.httpStatus, 100, 599),
    errorCode: errorCode(input.errorCode), totalCount: input.totalCount === null ? null : integer(input.totalCount, 1),
    totalPages: input.totalPages === null ? null : integer(input.totalPages, 1),
  }
  if (input.diagnostics !== undefined) result.diagnostics = parseParallelFetchReadDiagnostics(input.diagnostics)
  if (result.errorCode === null && (result.totalCount === null || result.totalPages === null
    || result.totalPages < page || result.httpStatus !== null && result.httpStatus >= 400)) return invalid()
  if ((result.totalCount === null) !== (result.totalPages === null)) return invalid()
  return result
}
function parseWorker(value: unknown, concurrency: number): ParallelFetchWorker {
  const input = object(value)
  return { id: integer(input.id, 1, concurrency), page: input.page === null ? null : integer(input.page, 1, 1000050),
    state: oneOf(input.state, ['idle', 'waiting', 'reading', 'complete', 'stopped']), completedPages: integer(input.completedPages, 0, 50) }
}
function parseTrial(value: unknown, config: ParallelFetchConfig): ParallelFetchTrial {
  const input = object(value)
  const concurrency = oneOf(input.concurrency, config.concurrencies)
  const result: ParallelFetchTrial = {
    concurrency, repetition: integer(input.repetition, 1, config.repetitions),
    state: oneOf(input.state, ['preparing', 'running', 'complete', 'stopped', 'error']), startedAt: date(input.startedAt),
    finishedAt: input.finishedAt === null ? null : date(input.finishedAt),
    preparationMs: input.preparationMs === null ? null : duration(input.preparationMs),
    measurementMs: input.measurementMs === null ? null : duration(input.measurementMs), totalMs: duration(input.totalMs),
    completedPages: list(input.completedPages, config.pageCount).map(item => integer(item, config.startPage, config.startPage + config.pageCount - 1)),
    attempts: list(input.attempts, PARALLEL_FETCH_MAX_ATTEMPTS).map(item => parseAttempt(item, config, concurrency)),
    workers: list(input.workers, concurrency).map(item => parseWorker(item, concurrency)), errorCode: errorCode(input.errorCode),
  }
  if (result.workers.length !== concurrency || new Set(result.workers.map(worker => worker.id)).size !== result.workers.length
    || new Set(result.completedPages).size !== result.completedPages.length) return invalid()
  const successes = result.attempts.filter(attempt => attempt.phase === 'measure' && attempt.errorCode === null).map(attempt => attempt.page)
  if (new Set(successes).size !== successes.length || successes.length !== result.completedPages.length
    || successes.some(page => !result.completedPages.includes(page))) return invalid()
  if (result.workers.some(worker => worker.completedPages !== result.attempts.filter(attempt => attempt.worker === worker.id
    && attempt.phase === 'measure' && attempt.errorCode === null).length)) return invalid()
  const terminal = result.state !== 'running' && result.state !== 'preparing'
  if (terminal !== (result.finishedAt !== null) || result.finishedAt && result.finishedAt < result.startedAt) return invalid()
  if (result.state === 'complete' && (result.completedPages.length !== config.pageCount || result.measurementMs === null
    || result.measurementMs <= 0 || result.preparationMs === null || result.errorCode !== null)) return invalid()
  if (result.state === 'complete' && result.workers.some(worker => worker.state !== 'complete'
    || result.attempts.filter(attempt => attempt.worker === worker.id && attempt.phase === 'prepare' && attempt.errorCode === null).length !== 1)) return invalid()
  if (result.totalMs + 1 < (result.preparationMs ?? 0) + (result.measurementMs ?? 0)) return invalid()
  return result
}
/** Reconstructs an allowlisted report. Credentials, raw rows, URLs and arbitrary errors never survive import/export. */
export function parseParallelFetchReport(value: unknown): ParallelFetchReport {
  const input = object(value)
  if (input.schemaVersion !== 1 || typeof input.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.runId)) return invalid()
  const config = parseParallelFetchConfig(input.config)
  const result: ParallelFetchReport = {
    schemaVersion: 1, runId: input.runId, config, state: oneOf(input.state, ['running', 'complete', 'stopped', 'error']),
    startedAt: date(input.startedAt), finishedAt: input.finishedAt === null ? null : date(input.finishedAt),
    trials: list(input.trials, config.concurrencies.length * config.repetitions).map(item => parseTrial(item, config)),
    errorCode: errorCode(input.errorCode),
  }
  if (new Set(result.trials.map(trial => `${trial.concurrency}:${trial.repetition}`)).size !== result.trials.length
    || result.trials.reduce((sum, trial) => sum + trial.attempts.length, 0) > PARALLEL_FETCH_MAX_ATTEMPTS) return invalid()
  if ((result.state !== 'running') !== (result.finishedAt !== null)
    || result.finishedAt && result.finishedAt < result.startedAt) return invalid()
  const active = result.trials.filter(trial => trial.state === 'running' || trial.state === 'preparing')
  if (active.length > 1 || result.state !== 'running' && active.length > 0) return invalid()
  if (result.state === 'complete' && (result.trials.length !== config.concurrencies.length * config.repetitions
    || result.trials.some(trial => trial.state !== 'complete') || result.errorCode !== null)) return invalid()
  return result
}

export interface ParallelFetchSummary {
  concurrency: ParallelFetchConcurrency
  completedTrials: number
  plannedTrials: number
  medianMs: number | null
  pagesPerMinute: number | null
  speedup: number | null
  estimatedFullScanMs: number | null
  successfulPages: number
  failedAttempts: number
  failedAttemptRate: number | null
  retries: number
}
function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
export function summarizeParallelFetch(report: ParallelFetchReport): ParallelFetchSummary[] {
  const summaries = report.config.concurrencies.map(concurrency => {
    const trials = report.trials.filter(trial => trial.concurrency === concurrency)
    const completed = trials.filter(trial => trial.state === 'complete')
    const medianMs = median(completed.map(trial => trial.measurementMs!))
    const pagesPerMinute = medianMs !== null && medianMs > 0 ? report.config.pageCount * 60000 / medianMs : null
    const pageTotals = completed.flatMap(trial => trial.attempts.filter(attempt => attempt.phase === 'measure'
      && attempt.errorCode === null).map(attempt => attempt.totalPages!))
    const fullPages = pageTotals.at(-1)
    const attempts = trials.flatMap(trial => trial.attempts)
    const failedAttempts = attempts.filter(attempt => attempt.errorCode !== null).length
    return {
      concurrency, completedTrials: completed.length, plannedTrials: report.config.repetitions, medianMs, pagesPerMinute,
      speedup: null as number | null,
      estimatedFullScanMs: pagesPerMinute !== null && fullPages !== undefined ? fullPages / pagesPerMinute * 60000 : null,
      successfulPages: trials.reduce((sum, trial) => sum + trial.completedPages.length, 0),
      failedAttempts,
      failedAttemptRate: attempts.length ? failedAttempts / attempts.length : null,
      retries: trials.reduce((sum, trial) => sum + trial.attempts.length
        - new Set(trial.attempts.map(attempt => `${attempt.phase}:${attempt.phase === 'prepare' ? attempt.worker : ''}:${attempt.page}`)).size, 0),
    }
  })
  const baseline = summaries.find(summary => summary.concurrency === 1)
  for (const summary of summaries) {
    if (baseline?.medianMs && baseline.completedTrials === baseline.plannedTrials && summary.medianMs
      && summary.completedTrials === summary.plannedTrials) summary.speedup = baseline.medianMs / summary.medianMs
  }
  return summaries
}
