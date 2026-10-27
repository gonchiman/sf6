export type SampleSurveyRank = 'ROOKIE' | 'IRON' | 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'DIAMOND' | 'MASTER'
export type SampleSurveyTarget = 'lp' | 'mr'
export interface SampleSurveyConfig {
  ranks: SampleSurveyRank[]
  rankSampleSize: number
  includeMr: boolean
  mrSampleSize: number
  maxDurationMinutes: number
}
export interface SampleSurveyPlan {
  schemaVersion: 1
  id: string
  createdAt: string
  seed: string
  config: SampleSurveyConfig
}
export type SampleSurveyError = 'cancelled' | 'limit-reached' | 'human-verification' | 'http-denied'
  | 'login-required' | 'authentication-unconfirmed' | 'maintenance' | 'server-error' | 'http-error'
  | 'timeout' | 'read-failed' | 'condition-mismatch' | 'page-mismatch' | 'frame-changed'
  | 'session-unavailable' | 'browser-unavailable' | 'storage-error' | 'interrupted' | 'invalid-request'
export interface SampleSurveyStratumResult {
  id: string
  label: string
  target: SampleSurveyTarget
  requested: number
  population: number | null
  selected: number
  processed: number
  succeeded: number
  missing: number
  duplicates: number
  mean: number | null
  min: number | null
  max: number | null
}
/** Public aggregate only. No account IDs, profile links or individual observations. */
export interface SampleSurveyRun {
  schemaVersion: 1
  id: string
  planId: string
  config: SampleSurveyConfig
  state: 'preparing' | 'running' | 'complete' | 'stopped' | 'error'
  phase: 'boundaries' | 'sampling' | 'complete'
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  elapsedMs: number
  attempts: number
  successfulPages: number
  uniqueAccountCount: number
  strata: SampleSurveyStratumResult[]
  frameChanged: boolean
  stopReason: SampleSurveyError | null
  resumeAllowed: boolean
}
export interface SampleSurveyServiceStatus {
  available: boolean
  sessionAvailable: boolean
  token: string
  plans: SampleSurveyPlan[]
  runs: SampleSurveyRun[]
  activeRunId: string | null
  error?: 'storage-error' | 'service-closed'
}
