import { parseParallelFetchReport } from './parallelFetch.ts'
import type { ParallelFetchConfig } from '../types/parallelFetch.ts'
import { CLOUD_ERRORS, CLOUD_READINESS, CLOUD_STATES } from '../types/parallelFetchCloud.ts'
import type { CloudMode, CloudRun, CloudServiceStatus, ParallelFetchResult } from '../types/parallelFetchCloud.ts'

export const CLOUD_REPOSITORY = 'gonchiman/sf6'
export const CLOUD_WORKFLOW = 'parallel-fetch-test.yml'
export const CLOUD_REF = 'main'
export const CLOUD_WORKFLOW_URL = `https://github.com/${CLOUD_REPOSITORY}/actions/workflows/${CLOUD_WORKFLOW}`
export const CLOUD_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RUN_ID = /^[1-9]\d{0,24}$/
const CONCLUSIONS = ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']
function invalid(): never { throw new Error('Actionsテストの記録形式を確認してください。') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid()
  return value as T
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return invalid()
  return new Date(value).toISOString()
}
function nullableTime(value: unknown): string | null { return value === null ? null : timestamp(value) }

export function cloudConfig(mode: CloudMode): ParallelFetchConfig {
  if (mode !== 'serial' && mode !== 'compare') return invalid()
  return { target: 'lp', startPage: 1, pageCount: 20, concurrencies: mode === 'serial' ? [1] : [1, 2],
    repetitions: mode === 'serial' ? 3 : 1, intervalMs: 5000 }
}
export function cloudRunUrl(runId: string): string {
  if (!RUN_ID.test(runId) || runId !== runId.trim()) return invalid()
  return `https://github.com/${CLOUD_REPOSITORY}/actions/runs/${runId}`
}
export function isCloudRunActive(run: CloudRun): boolean {
  return !['complete', 'failed', 'cancelled'].includes(run.state)
}
/** Reconstruct safe metadata; never forward arbitrary GH output, URLs or artifact contents. */
export function parseCloudRun(value: unknown): CloudRun {
  const row = object(value)
  if (typeof row.requestId !== 'string' || row.requestId.length !== 36 || !CLOUD_REQUEST_ID.test(row.requestId)) return invalid()
  const mode = member(row.mode, ['serial', 'compare'] as const)
  const runId = row.runId === null ? null : typeof row.runId === 'string' && RUN_ID.test(row.runId) && row.runId === row.runId.trim() ? row.runId : invalid()
  const runAttempt = row.runAttempt === null ? null : typeof row.runAttempt === 'number' && Number.isSafeInteger(row.runAttempt)
    && row.runAttempt > 0 && row.runAttempt <= 999999 ? row.runAttempt : invalid()
  if ((runId === null) !== (runAttempt === null)) return invalid()
  const state = member(row.state, CLOUD_STATES)
  const report = row.report === null ? null : parseParallelFetchReport(row.report)
  if (report && (runId === null || report.state === 'running' || report.runId !== `cloud-${runId}-${runAttempt}-${mode}`
    || JSON.stringify(report.config) !== JSON.stringify(cloudConfig(mode)))) return invalid()
  if (state === 'complete' && (!report || report.state !== 'complete')) return invalid()
  const headSha = row.headSha === null ? null : typeof row.headSha === 'string' && row.headSha.length === 40 && /^[a-f0-9]{40}$/.test(row.headSha) ? row.headSha : invalid()
  return { requestId: row.requestId, mode, createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt),
    dispatchState: member(row.dispatchState, ['pending', 'sent', 'uncertain'] as const), runId, runAttempt, state,
    startedAt: nullableTime(row.startedAt), finishedAt: nullableTime(row.finishedAt), headSha,
    conclusion: row.conclusion === null ? null : member(row.conclusion, CONCLUSIONS), report,
    error: row.error === null ? null : member(row.error, CLOUD_ERRORS) }
}
export function parseCloudServiceStatus(value: unknown): CloudServiceStatus {
  const row = object(value)
  if (typeof row.available !== 'boolean' || typeof row.token !== 'string' || row.token.length !== 64 || !/^[a-f0-9]{64}$/.test(row.token)
    || !Array.isArray(row.runs) || row.runs.length > 100) return invalid()
  const runs = row.runs.map(parseCloudRun)
  if (new Set(runs.map(run => run.requestId)).size !== runs.length) return invalid()
  const activeRequestId = row.activeRequestId === null ? null : typeof row.activeRequestId === 'string'
    && runs.some(run => run.requestId === row.activeRequestId && isCloudRunActive(run)) ? row.activeRequestId : invalid()
  return { available: row.available, token: row.token, readiness: member(row.readiness, CLOUD_READINESS), activeRequestId, runs,
    error: row.error === null ? null : member(row.error, CLOUD_ERRORS) }
}
/** Legacy JSON has no trustworthy environment metadata; keep it explicitly unknown. */
export function parseParallelFetchResult(value: unknown): ParallelFetchResult {
  const row = object(value)
  if (row.kind !== 'parallel-fetch-result') return { schemaVersion: 1, kind: 'parallel-fetch-result',
    environment: 'unknown', cloud: null, report: parseParallelFetchReport(value) }
  if (row.schemaVersion !== 1) return invalid()
  const environment = member(row.environment, ['local', 'github-actions', 'unknown'] as const)
  const report = parseParallelFetchReport(row.report)
  const cloud = row.cloud === null ? null : parseCloudRun(row.cloud)
  if (environment === 'github-actions') {
    if (!cloud?.report || JSON.stringify(cloud.report) !== JSON.stringify(report)) return invalid()
  } else if (cloud !== null) return invalid()
  return { schemaVersion: 1, kind: 'parallel-fetch-result', environment, cloud, report }
}
