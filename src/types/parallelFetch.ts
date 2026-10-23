export type ParallelFetchTarget = 'lp' | 'mr'
export type ParallelFetchConcurrency = 1 | 2 | 4
export interface ParallelFetchConfig {
  target: ParallelFetchTarget
  startPage: number
  pageCount: 20 | 50
  concurrencies: ParallelFetchConcurrency[]
  repetitions: 1 | 3
  intervalMs: 5000 | 10000
}
export const PARALLEL_FETCH_ERRORS = ['cancelled', 'limit-reached', 'out-of-range', 'http-denied', 'server-error',
  'http-error', 'maintenance', 'login-required', 'authentication-unconfirmed', 'human-verification',
  'condition-mismatch', 'page-mismatch', 'unsupported-dom', 'timeout', 'read-failed', 'session-unavailable',
  'browser-unavailable', 'invalid-request'] as const
export type ParallelFetchErrorCode = typeof PARALLEL_FETCH_ERRORS[number]
export type ParallelFetchRunState = 'running' | 'complete' | 'stopped' | 'error'
export type ParallelFetchTrialState = 'preparing' | ParallelFetchRunState
export type ParallelFetchAuthenticationEvidence = 'logout-control' | 'login-control' | 'conflicting-controls' | 'no-control' | null
export type ParallelFetchDiagnosticPhase = 'read' | 'after-stop'
export interface ParallelFetchReadObservation {
  elapsedMs: number
  phase: ParallelFetchDiagnosticPhase
  authenticationEvidence: ParallelFetchAuthenticationEvidence
  loginRequiredHeading: boolean | null
  rankingReadable: boolean | null
  humanVerification: boolean | null
}
export interface ParallelFetchNetworkEvent {
  elapsedMs: number
  phase: ParallelFetchDiagnosticPhase
  kind: 'http-error' | 'request-failed'
  resource: 'document' | 'xhr' | 'fetch' | 'script' | 'stylesheet' | 'image' | 'other'
  site: 'buckler' | 'capcom-auth' | 'other'
  status: number | null
}
export interface ParallelFetchPostStopDiagnostics {
  durationMs: number
  outcome: 'observed' | 'cancelled' | 'page-unavailable' | 'human-verification' | 'not-run'
}
export interface ParallelFetchReadTrace {
  observations: ParallelFetchReadObservation[]
  network: ParallelFetchNetworkEvent[]
  droppedObservations: number
  droppedNetworkEvents: number
  postStop?: ParallelFetchPostStopDiagnostics
}
export interface ParallelFetchReadDiagnostics {
  authenticationEvidence: ParallelFetchAuthenticationEvidence
  loginRequiredHeading: boolean | null
  rankingReadable: boolean | null
  trace?: ParallelFetchReadTrace
}
export interface ParallelFetchAttempt {
  worker: number
  page: number
  phase: 'prepare' | 'measure'
  startedAt: string
  durationMs: number
  httpStatus: number | null
  errorCode: ParallelFetchErrorCode | null
  totalCount: number | null
  totalPages: number | null
  diagnostics?: ParallelFetchReadDiagnostics
}
export interface ParallelFetchWorker {
  id: number
  page: number | null
  state: 'idle' | 'waiting' | 'reading' | 'complete' | 'stopped'
  completedPages: number
}
export interface ParallelFetchTrial {
  concurrency: ParallelFetchConcurrency
  repetition: number
  state: ParallelFetchTrialState
  startedAt: string
  finishedAt: string | null
  preparationMs: number | null
  measurementMs: number | null
  totalMs: number
  completedPages: number[]
  attempts: ParallelFetchAttempt[]
  workers: ParallelFetchWorker[]
  errorCode: ParallelFetchErrorCode | null
}
export interface ParallelFetchReport {
  schemaVersion: 1
  runId: string
  config: ParallelFetchConfig
  state: ParallelFetchRunState
  startedAt: string
  finishedAt: string | null
  trials: ParallelFetchTrial[]
  errorCode: ParallelFetchErrorCode | null
}
export interface ParallelFetchServiceStatus {
  available: boolean
  sessionAvailable: boolean
  token: string
  report: ParallelFetchReport | null
  error?: 'report-save-failed'
}
