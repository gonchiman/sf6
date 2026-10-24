import { PARALLEL_FETCH_ERRORS } from '../types/parallelFetch.ts'
import type { ParallelFetchAttempt, ParallelFetchAuthenticationEvidence, ParallelFetchConcurrency, ParallelFetchConfig,
  ParallelFetchErrorCode, ParallelFetchInterval, ParallelFetchIntervalScope, ParallelFetchNetworkEvent, ParallelFetchReadDiagnostics, ParallelFetchReadTrace,
  ParallelFetchReport, ParallelFetchTrial, ParallelFetchWorker } from '../types/parallelFetch.ts'

export const PARALLEL_FETCH_MAX_ATTEMPTS = 200
export const PARALLEL_FETCH_MAX_CONCURRENCY = 8
export const PARALLEL_FETCH_MAX_INTERVAL_MS = 60000
export const PARALLEL_FETCH_INTERVAL_STEP_MS = 100
export const PARALLEL_FETCH_MAX_INTERVALS = 3
export const PARALLEL_FETCH_MAX_DURATION_MS = 10 * 60 * 1000
export const PARALLEL_FETCH_MAX_TRACE_OBSERVATIONS = 80
export const PARALLEL_FETCH_MAX_TRACE_NETWORK_EVENTS = 80
export const PARALLEL_FETCH_MAX_POST_STOP_MS = 35000
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
function duration(value: unknown, max = 7 * 86400000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return invalid()
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
function booleanOrNull(value: unknown): boolean | null {
  return value === null || typeof value === 'boolean' ? value : invalid()
}
function authenticationEvidence(value: unknown): ParallelFetchAuthenticationEvidence {
  return value === null ? null : oneOf(value, ['logout-control', 'login-control', 'conflicting-controls', 'no-control'] as const)
}
function parseReadTrace(value: unknown): ParallelFetchReadTrace {
  const input = object(value)
  const result: ParallelFetchReadTrace = {
    observations: list(input.observations, PARALLEL_FETCH_MAX_TRACE_OBSERVATIONS).map(value => {
      const item = object(value)
      return { elapsedMs: duration(item.elapsedMs), phase: oneOf(item.phase, ['read', 'after-stop']),
        authenticationEvidence: authenticationEvidence(item.authenticationEvidence),
        loginRequiredHeading: booleanOrNull(item.loginRequiredHeading), rankingReadable: booleanOrNull(item.rankingReadable),
        humanVerification: booleanOrNull(item.humanVerification) }
    }),
    network: list(input.network, PARALLEL_FETCH_MAX_TRACE_NETWORK_EVENTS).map(value => {
      const item = object(value)
      const event: ParallelFetchNetworkEvent = {
        elapsedMs: duration(item.elapsedMs), phase: oneOf(item.phase, ['read', 'after-stop']),
        kind: oneOf(item.kind, ['http-error', 'request-failed']),
        resource: oneOf(item.resource, ['document', 'xhr', 'fetch', 'script', 'stylesheet', 'image', 'other']),
        site: oneOf(item.site, ['buckler', 'capcom-auth', 'other']),
        status: item.status === null ? null : integer(item.status, 400, 599),
      }
      if ((event.kind === 'request-failed') !== (event.status === null)) return invalid()
      return event
    }),
    droppedObservations: integer(input.droppedObservations), droppedNetworkEvents: integer(input.droppedNetworkEvents),
  }
  if (input.postStop !== undefined) {
    const postStop = object(input.postStop)
    result.postStop = { durationMs: duration(postStop.durationMs, PARALLEL_FETCH_MAX_POST_STOP_MS),
      outcome: oneOf(postStop.outcome, ['observed', 'cancelled', 'page-unavailable', 'human-verification', 'not-run']) }
  }
  return result
}
export function parseParallelFetchReadDiagnostics(value: unknown): ParallelFetchReadDiagnostics {
  const input = object(value)
  const result: ParallelFetchReadDiagnostics = {
    authenticationEvidence: authenticationEvidence(input.authenticationEvidence),
    loginRequiredHeading: booleanOrNull(input.loginRequiredHeading),
    rankingReadable: booleanOrNull(input.rankingReadable),
  }
  if (input.trace !== undefined) result.trace = parseReadTrace(input.trace)
  return result
}
export function parallelFetchIntervals(config: ParallelFetchConfig): ParallelFetchInterval[] {
  return config.intervalMsList ? [...config.intervalMsList] : [config.intervalMs]
}
export function parallelFetchIntervalScope(config: Pick<ParallelFetchConfig, 'intervalScope'>): ParallelFetchIntervalScope {
  return config.intervalScope ?? 'global'
}
export function isParallelFetchInterval(value: unknown): value is ParallelFetchInterval {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    && value <= PARALLEL_FETCH_MAX_INTERVAL_MS && value % PARALLEL_FETCH_INTERVAL_STEP_MS === 0
}
function interval(value: unknown): ParallelFetchInterval {
  return isParallelFetchInterval(value) ? value : invalid()
}
export function parseParallelFetchIntervalInput(text: string): ParallelFetchInterval[] {
  if (text.length > 128) throw new Error('取得開始間隔は128文字以内で入力してください。')
  const tokens = text.split(',', PARALLEL_FETCH_MAX_INTERVALS + 1).map(token => token.trim())
  if (tokens.length > PARALLEL_FETCH_MAX_INTERVALS) throw new Error(`取得開始間隔は${PARALLEL_FETCH_MAX_INTERVALS}個以内で入力してください。`)
  const intervals = tokens.map(token => {
    const milliseconds = Math.round(Number(token) * 1000)
    if (!/^(?:0|[1-9]\d*)(?:\.\d)?$/.test(token) || !isParallelFetchInterval(milliseconds)) {
      throw new Error('取得開始間隔は0〜60秒・小数1桁までの数値をカンマで区切って入力してください。')
    }
    return milliseconds
  })
  if (new Set(intervals).size !== intervals.length) throw new Error('取得開始間隔の重複を除いてください。')
  return intervals.sort((a, b) => b - a)
}
export function plannedParallelFetchAttempts(config: ParallelFetchConfig): number {
  return parallelFetchIntervals(config).length * config.repetitions
    * config.concurrencies.reduce((sum, concurrency) => sum + config.pageCount + concurrency, 0)
}
/** Zero-duration reads give a lower bound, not a completion-time prediction. */
export function minimumPlannedWaitMs(config: ParallelFetchConfig): number {
  if (parallelFetchIntervalScope(config) === 'per-tab') {
    // Each new tab prepares once, then keeps its start clock for its share of pages.
    return parallelFetchIntervals(config).reduce((sum, intervalMs) => sum + intervalMs * config.repetitions
      * config.concurrencies.reduce((count, concurrency) => count + Math.ceil(config.pageCount / concurrency), 0), 0)
  }
  const attemptsPerInterval = config.repetitions
    * config.concurrencies.reduce((sum, concurrency) => sum + config.pageCount + concurrency, 0)
  return parallelFetchIntervals(config).reduce((sum, intervalMs, index) =>
    sum + intervalMs * (attemptsPerInterval - (index === 0 ? 1 : 0)), 0)
}
export function parseParallelFetchConcurrencyInput(text: string): ParallelFetchConcurrency[] {
  if (text.length > 128) throw new Error('並列数は128文字以内で入力してください。')
  const tokens = text.split(',', PARALLEL_FETCH_MAX_CONCURRENCY + 1).map(token => token.trim())
  if (tokens.length > PARALLEL_FETCH_MAX_CONCURRENCY) {
    throw new Error(`並列数は${PARALLEL_FETCH_MAX_CONCURRENCY}個以内で指定してください。`)
  }
  const concurrencies = tokens.map(token => {
    const value = Number(token)
    if (!/^[1-9]\d*$/.test(token) || !Number.isSafeInteger(value) || value > PARALLEL_FETCH_MAX_CONCURRENCY) {
      throw new Error(`並列数は1〜${PARALLEL_FETCH_MAX_CONCURRENCY}の整数をカンマで区切って入力してください。`)
    }
    return value
  })
  if (new Set(concurrencies).size !== concurrencies.length) throw new Error('並列数の重複を除いてください。')
  return concurrencies.sort((a, b) => a - b)
}
/** Reads saved conditions without applying today's execution-time budget to old records. */
export function parseHistoricalParallelFetchConfig(value: unknown): ParallelFetchConfig {
  const input = object(value)
  const concurrencies = Array.from(list(input.concurrencies, PARALLEL_FETCH_MAX_CONCURRENCY), item => integer(item, 1, PARALLEL_FETCH_MAX_CONCURRENCY))
  if (concurrencies.length === 0 || new Set(concurrencies).size !== concurrencies.length
    || concurrencies.some((item, index) => index > 0 && item < concurrencies[index - 1])) return invalid()
  const result: ParallelFetchConfig = {
    target: oneOf(input.target, ['lp', 'mr']), startPage: integer(input.startPage, 1, 1000000),
    pageCount: oneOf(input.pageCount, [20, 50]), concurrencies,
    repetitions: oneOf(input.repetitions, [1, 3]), intervalMs: interval(input.intervalMs),
  }
  if (input.intervalScope !== undefined) result.intervalScope = oneOf(input.intervalScope, ['global', 'per-tab'] as const)
  if (input.intervalMsList !== undefined) {
    const intervals = Array.from(list(input.intervalMsList, PARALLEL_FETCH_MAX_INTERVALS), interval)
    if (!intervals.length || intervals[0] !== result.intervalMs || new Set(intervals).size !== intervals.length
      || intervals.some((item, index) => index > 0 && item > intervals[index - 1])) return invalid()
    result.intervalMsList = intervals
  }
  if (plannedParallelFetchAttempts(result) > PARALLEL_FETCH_MAX_ATTEMPTS) return invalid()
  return result
}
export function parseParallelFetchConfig(value: unknown): ParallelFetchConfig {
  const result = parseHistoricalParallelFetchConfig(value)
  if (minimumPlannedWaitMs(result) >= PARALLEL_FETCH_MAX_DURATION_MS) return invalid()
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
function parseTrial(value: unknown, config: ParallelFetchConfig, schemaVersion: ParallelFetchReport['schemaVersion']): ParallelFetchTrial {
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
  if (schemaVersion >= 2) result.intervalMs = oneOf(input.intervalMs, parallelFetchIntervals(config))
  else if (input.intervalMs !== undefined) return invalid()
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
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== 3
    || typeof input.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.runId)) return invalid()
  const config = input.schemaVersion === 3 ? parseParallelFetchConfig(input.config) : parseHistoricalParallelFetchConfig(input.config)
  if (input.schemaVersion === 3) {
    if (config.intervalScope === undefined) return invalid()
  } else {
    if (config.intervalScope !== undefined || (input.schemaVersion === 2) !== (config.intervalMsList !== undefined)) return invalid()
    if (parallelFetchIntervals(config).some(value => !(input.schemaVersion === 1 ? [5000, 10000] : [3000, 5000, 10000]).includes(value))) return invalid()
  }
  const expectedTrials = parallelFetchIntervals(config).flatMap(intervalMs => config.concurrencies.flatMap(concurrency =>
    Array.from({ length: config.repetitions }, (_, index) => `${intervalMs}:${concurrency}:${index + 1}`)))
  const result: ParallelFetchReport = {
    schemaVersion: input.schemaVersion, runId: input.runId, config, state: oneOf(input.state, ['running', 'complete', 'stopped', 'error']),
    startedAt: date(input.startedAt), finishedAt: input.finishedAt === null ? null : date(input.finishedAt),
    trials: list(input.trials, expectedTrials.length).map(item => parseTrial(item, config, input.schemaVersion as ParallelFetchReport['schemaVersion'])),
    errorCode: errorCode(input.errorCode),
  }
  if (new Set(result.trials.map(trial => `${trial.intervalMs ?? config.intervalMs}:${trial.concurrency}:${trial.repetition}`)).size !== result.trials.length
    || result.trials.reduce((sum, trial) => sum + trial.attempts.length, 0) > PARALLEL_FETCH_MAX_ATTEMPTS) return invalid()
  if (result.schemaVersion >= 2 && result.trials.some((trial, index) =>
    `${trial.intervalMs}:${trial.concurrency}:${trial.repetition}` !== expectedTrials[index]
    || index < result.trials.length - 1 && trial.state !== 'complete')) return invalid()
  if ((result.state !== 'running') !== (result.finishedAt !== null)
    || result.finishedAt && result.finishedAt < result.startedAt) return invalid()
  const active = result.trials.filter(trial => trial.state === 'running' || trial.state === 'preparing')
  if (active.length > 1 || result.state !== 'running' && active.length > 0) return invalid()
  if (result.state === 'complete' && (result.trials.length !== expectedTrials.length
    || result.trials.some(trial => trial.state !== 'complete') || result.errorCode !== null)) return invalid()
  return result
}

export interface ParallelFetchSummary {
  concurrency: ParallelFetchConcurrency
  intervalMs: ParallelFetchInterval
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
  const summaries = parallelFetchIntervals(report.config).flatMap(intervalMs => report.config.concurrencies.map(concurrency => {
    const trials = report.trials.filter(trial => trial.concurrency === concurrency
      && (trial.intervalMs ?? report.config.intervalMs) === intervalMs)
    const completed = trials.filter(trial => trial.state === 'complete')
    const medianMs = median(completed.map(trial => trial.measurementMs!))
    const pagesPerMinute = medianMs !== null && medianMs > 0 ? report.config.pageCount * 60000 / medianMs : null
    const pageTotals = completed.flatMap(trial => trial.attempts.filter(attempt => attempt.phase === 'measure'
      && attempt.errorCode === null).map(attempt => attempt.totalPages!))
    const fullPages = pageTotals.at(-1)
    const attempts = trials.flatMap(trial => trial.attempts)
    const failedAttempts = attempts.filter(attempt => attempt.errorCode !== null).length
    return {
      concurrency, intervalMs, completedTrials: completed.length, plannedTrials: report.config.repetitions, medianMs, pagesPerMinute,
      speedup: null as number | null,
      estimatedFullScanMs: pagesPerMinute !== null && fullPages !== undefined ? fullPages / pagesPerMinute * 60000 : null,
      successfulPages: trials.reduce((sum, trial) => sum + trial.completedPages.length, 0),
      failedAttempts,
      failedAttemptRate: attempts.length ? failedAttempts / attempts.length : null,
      retries: trials.reduce((sum, trial) => sum + trial.attempts.length
        - new Set(trial.attempts.map(attempt => `${attempt.phase}:${attempt.phase === 'prepare' ? attempt.worker : ''}:${attempt.page}`)).size, 0),
    }
  }))
  for (const summary of summaries) {
    const baseline = summaries.find(candidate => candidate.concurrency === 1 && candidate.intervalMs === summary.intervalMs)
    if (baseline?.medianMs && baseline.completedTrials === baseline.plannedTrials && summary.medianMs
      && summary.completedTrials === summary.plannedTrials) summary.speedup = baseline.medianMs / summary.medianMs
  }
  return summaries
}
