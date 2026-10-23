import type { ParallelFetchConcurrency, ParallelFetchInterval, ParallelFetchReport } from './parallelFetch.ts'

export type CloudMode = 'serial' | 'compare' | 'interval-compare'
export interface CloudIntervalOptions {
  intervalMsList: ParallelFetchInterval[]
  concurrencies: ParallelFetchConcurrency[]
  repetitions: 1 | 3
}
export const CLOUD_STATES = ['dispatching', 'dispatch-unknown', 'queued', 'preparing', 'collecting',
  'loading-result', 'complete', 'failed', 'cancel-requested', 'cancelled'] as const
export type CloudState = typeof CLOUD_STATES[number]
export const CLOUD_ERRORS = ['dispatch-uncertain', 'github-unavailable', 'workflow-unavailable', 'workflow-failed',
  'artifact-missing', 'artifact-expired', 'artifact-download-failed', 'invalid-report', 'state-save-failed',
  'state-invalid', 'run-ambiguous', 'cancel-failed', 'already-running', 'invalid-request', 'forbidden', 'service-closed'] as const
export type CloudError = typeof CLOUD_ERRORS[number]
export interface CloudRun {
  requestId: string
  mode: CloudMode
  options?: CloudIntervalOptions
  createdAt: string
  updatedAt: string
  dispatchState: 'pending' | 'sent' | 'uncertain'
  runId: string | null
  runAttempt: number | null
  state: CloudState
  startedAt: string | null
  finishedAt: string | null
  headSha: string | null
  conclusion: string | null
  report: ParallelFetchReport | null
  error: CloudError | null
}
export const CLOUD_READINESS = ['checking', 'ready', 'gh-unavailable', 'github-unavailable', 'workflow-unavailable'] as const
export interface CloudServiceStatus {
  available: boolean
  token: string
  readiness: typeof CLOUD_READINESS[number]
  activeRequestId: string | null
  runs: CloudRun[]
  error: CloudError | null
}
export interface ParallelFetchResult {
  schemaVersion: 1
  kind: 'parallel-fetch-result'
  environment: 'local' | 'github-actions' | 'unknown'
  cloud: CloudRun | null
  report: ParallelFetchReport
}
