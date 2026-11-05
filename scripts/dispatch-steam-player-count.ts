import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { appendFile } from 'node:fs/promises'
import { steamCollectionVersion } from './lib/steam-collection-version.ts'

export const STEAM_DISPATCH_INTERVAL_MS = 15 * 60 * 1000
export const STEAM_DISPATCH_DURATION_MS = 330 * 60 * 1000
export const STEAM_DISPATCH_HEARTBEAT_MS = 60 * 1000
export const STEAM_DISPATCH_HANDOFF_MS = 120 * 1000
export const STEAM_DISPATCH_HANDOFF_CHECK_MS = 2 * 60 * 1000
export const STEAM_DISPATCH_HANDOFF_PROOF_STEP = 'Confirm Steam successor reservation'
const OFFSET_MS = 7 * 60 * 1000
const MAX_LATENESS_MS = 60 * 1000
const MAX_DISPATCH_ATTEMPTS = 22
const COLLECTION_RECHECK_MS = 5_000
const API = 'https://api.github.com/repos/gonchiman/sf6/actions/workflows/'
const RUN_API = 'https://api.github.com/repos/gonchiman/sf6/actions/runs/'
const DRIVER = 'steam-player-count-dispatch.yml'
const COLLECTOR = 'steam-player-count.yml'
const HANDOFF_POLL_MS = 10_000
const MAX_HANDOFF_POLLS = 12
const HANDOFF_JSON_LIMIT = 1024 * 1024
type Environment = Record<string, string | undefined>
type ErrorKind = 'http' | 'network' | 'timeout' | 'invalid-json' | 'response-too-large' | 'invalid-response' | 'budget-exhausted'
type LogFields = Record<string, string | number | boolean | null>
type StopReason = 'duration' | 'dispatcher-disabled' | 'collector-disabled' | 'access-denied' | 'rate-limited' | 'cancelled' | 'predecessor-rejected'
export type SteamDispatchResult = { reason: StopReason; dispatched: number; skipped: number; failed: number;
  handoff: 'not-attempted' | 'confirmed' | 'failed'; successorRunId?: string }

class DispatchRequestError extends Error {
  readonly status: number | null
  readonly kind: ErrorKind
  readonly stage: string | null
  constructor(status: number | null = null, kind: ErrorKind = 'invalid-response', stage: string | null = null) {
    super('Steam取得の起動要求を確認できませんでした。')
    this.status = status
    this.kind = kind
    this.stage = stage
  }
}

export function isAllowedSteamDispatcher(env: Environment): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'Linux' && env.GITHUB_REPOSITORY === 'gonchiman/sf6'
    && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_WORKFLOW_REF === `gonchiman/sf6/.github/workflows/${DRIVER}@refs/heads/main`
    && ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')
    && typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0
}

export function resolveSteamDispatchDuration(env: Environment): number {
  const mode = env.STEAM_DISPATCH_MODE || 'standard'
  if (mode === 'standard') return STEAM_DISPATCH_DURATION_MS
  if (mode === 'handoff-check' && env.GITHUB_EVENT_NAME === 'workflow_dispatch') return STEAM_DISPATCH_HANDOFF_CHECK_MS
  throw new Error('Steam起動役の実行モードが不正です。')
}

function positiveId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || !/^[1-9]\d{0,24}$/.test(id)) throw new DispatchRequestError()
  return id
}

function positiveAttempt(value: unknown): number {
  if (typeof value === 'string' && /^[1-9]\d{0,5}$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new DispatchRequestError()
  return value as number
}

/** :07/:22/:37/:52 UTC, matching the original collection schedule. */
export function nextSteamDispatchBoundary(timestamp: number): number {
  return Math.ceil((timestamp - OFFSET_MS) / STEAM_DISPATCH_INTERVAL_MS) * STEAM_DISPATCH_INTERVAL_MS + OFFSET_MS
}

const slotAt = (timestamp: number) => Math.floor((timestamp - OFFSET_MS) / STEAM_DISPATCH_INTERVAL_MS)

async function boundedJson(response: Response, limit = 64 * 1024): Promise<unknown> {
  if (!response.body) throw new DispatchRequestError(response.status, 'invalid-json')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > limit) throw new DispatchRequestError(response.status, 'response-too-large')
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new DispatchRequestError(response.status, 'invalid-json') }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error instanceof DispatchRequestError ? error : new DispatchRequestError(response.status, 'network')
  } finally { reader.releaseLock() }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function workflowActive(value: unknown): boolean {
  if (!record(value) || typeof value.state !== 'string'
    || !['active', 'disabled_manually', 'disabled_inactivity', 'disabled_fork', 'deleted'].includes(value.state)) throw new DispatchRequestError()
  return value.state === 'active'
}

function collectionRun(latest: unknown) {
  if (!record(latest) || latest.head_branch !== 'main' || typeof latest.created_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(latest.created_at)
    || typeof latest.updated_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(latest.updated_at)
    || latest.event !== 'workflow_dispatch'
    || ![`.github/workflows/${COLLECTOR}`, `.github/workflows/${COLLECTOR}@refs/heads/main`].includes(String(latest.path))
    || !record(latest.repository) || latest.repository.full_name !== 'gonchiman/sf6'
    || !record(latest.head_repository) || latest.head_repository.full_name !== 'gonchiman/sf6'
    || typeof latest.status !== 'string'
    || !['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed'].includes(latest.status)) throw new DispatchRequestError()
  if (!Number.isFinite(Date.parse(latest.created_at)) || !Number.isFinite(Date.parse(latest.updated_at))) throw new DispatchRequestError()
  return { id: positiveId(latest.id), attempt: positiveAttempt(latest.run_attempt), status: latest.status,
    createdAt: latest.created_at, updatedAt: latest.updated_at }
}
type CollectionRun = ReturnType<typeof collectionRun>

function latestCollection(value: unknown): CollectionRun | null {
  if (!record(value) || !Array.isArray(value.workflow_runs) || value.workflow_runs.length > 1) throw new DispatchRequestError()
  return value.workflow_runs.length === 0 ? null : collectionRun(value.workflow_runs[0])
}

function collectionBlock(run: CollectionRun | null, boundary: number): 'current-slot' | 'future-slot' | 'active-run' | null {
  if (!run) return null
  // Compare aligned slots, not elapsed milliseconds: GitHub can create a run a
  // second after its dispatch, which must not suppress the next 15-minute slot.
  const difference = slotAt(Date.parse(run.createdAt)) - slotAt(boundary)
  return difference > 0 ? 'future-slot' : difference === 0 ? 'current-slot' : run.status !== 'completed' ? 'active-run' : null
}

function collectionFields(run: CollectionRun | null): LogFields {
  return { runId: run?.id ?? null, runAttempt: run?.attempt ?? null, runStatus: run?.status ?? null,
    runCreatedAt: run?.createdAt ?? null, runUpdatedAt: run?.updatedAt ?? null }
}

// Only fixed operation names are logged, never URLs, headers or response bodies.
function requestStage(path: string, method: 'GET' | 'POST'): string {
  if (path === DRIVER) return 'dispatcher-status'
  if (path === COLLECTOR) return 'collector-status'
  if (method === 'POST') return path === `${COLLECTOR}/dispatches` ? 'collection-dispatch' : 'successor-dispatch'
  if (path.startsWith(`${COLLECTOR}/runs?`)) return 'collection-list'
  if (path.startsWith(`${DRIVER}/runs?`)) return 'successor-list'
  return path.includes('/jobs?') ? 'predecessor-jobs' : 'dispatcher-run'
}

function dispatcherRun(value: unknown): { id: string; attempt: number; status: string; conclusion: string | null } {
  if (!record(value) || value.head_branch !== 'main' || !['schedule', 'workflow_dispatch'].includes(String(value.event))
    || ![`.github/workflows/${DRIVER}`, `.github/workflows/${DRIVER}@refs/heads/main`].includes(String(value.path))
    || !record(value.repository) || value.repository.full_name !== 'gonchiman/sf6'
    || !record(value.head_repository) || value.head_repository.full_name !== 'gonchiman/sf6'
    || typeof value.status !== 'string' || !['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed'].includes(value.status)
    || value.conclusion !== null && typeof value.conclusion !== 'string') throw new DispatchRequestError()
  return { id: positiveId(value.id), attempt: positiveAttempt(value.run_attempt), status: value.status, conclusion: value.conclusion as string | null }
}

/** Dates are deliberately not used: stable run IDs define a successor even when
 * upstream creation timestamps are delayed, out of order, or in the future.
 */
function pendingSuccessor(value: unknown, currentId: string): string | null {
  if (!record(value) || !Array.isArray(value.workflow_runs) || value.workflow_runs.length > 20) throw new DispatchRequestError()
  const candidates: string[] = []
  for (const item of value.workflow_runs) {
    const run = dispatcherRun(item)
    if (BigInt(run.id) > BigInt(currentId) && ['queued', 'waiting', 'requested', 'pending'].includes(run.status) && run.conclusion === null) {
      candidates.push(run.id)
    }
  }
  return candidates.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)[0] ?? null
}

function hasHandoffProof(value: unknown, predecessorId: string): boolean {
  if (!record(value) || !Array.isArray(value.jobs) || value.jobs.length > 100 || !Number.isSafeInteger(value.total_count)
    || value.total_count !== value.jobs.length) throw new DispatchRequestError()
  const jobs = value.jobs.filter(job => record(job) && job.name === 'dispatch')
  if (jobs.length !== 1) return false
  const job = jobs[0]
  if (!record(job) || positiveId(job.run_id) !== predecessorId || job.status !== 'completed'
    || !['success', 'failure'].includes(String(job.conclusion)) || !Array.isArray(job.steps)) return false
  const steps = job.steps.filter(step => record(step) && step.name === STEAM_DISPATCH_HANDOFF_PROOF_STEP)
  return steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success'
}

/** A bounded clock for the existing collector. It never fetches Steam or writes data. */
export async function runSteamPlayerCountDispatcher(options: {
  env?: Environment
  now?: () => number
  monotonicNow?: () => number
  wait?: (milliseconds: number) => Promise<unknown>
  fetch?: typeof fetch
  durationMs?: number
  requestTimeoutMs?: number
  /** Tests may isolate the clock; the production default always reserves a successor. */
  handoff?: boolean
  write?: (message: string) => void
} = {}): Promise<SteamDispatchResult> {
  const env = options.env ?? process.env
  if (!isAllowedSteamDispatcher(env)) throw new Error('固定mainのSteam起動workflowと認証が必要です。')
  const durationMs = options.durationMs ?? resolveSteamDispatchDuration(env)
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > STEAM_DISPATCH_DURATION_MS
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error('実行時間の指定が不正です。')
  const now = options.now ?? Date.now, monotonicNow = options.monotonicNow ?? (() => performance.now())
  const wait = options.wait ?? delay, fetchData = options.fetch ?? fetch, write = options.write ?? console.log
  let deadline = monotonicNow() + durationMs
  let dispatchAttempts = 0
  const result: SteamDispatchResult = { reason: 'duration', dispatched: 0, skipped: 0, failed: 0, handoff: 'not-attempted' }
  const identity = steamCollectionVersion('dispatcher', env)
  const emit = (event: string, extra: LogFields = {}) => write(JSON.stringify({ event, at: new Date(now()).toISOString(), ...extra, ...identity }))
  let stage = 'startup'
  const errorFields = (error: unknown): LogFields => ({
    stage: error instanceof DispatchRequestError ? error.stage ?? stage : stage,
    errorKind: error instanceof DispatchRequestError ? error.kind : 'network',
    httpStatus: error instanceof DispatchRequestError ? error.status : null,
  })
  const remaining = () => Math.max(0, deadline - monotonicNow())
  const stopReason = (error: unknown): StopReason | null => error instanceof DispatchRequestError
    ? [401, 403, 404].includes(error.status ?? 0) ? 'access-denied' : error.status === 429 ? 'rate-limited' : null : null

  const request = async (path: string, method: 'GET' | 'POST' = 'GET', settings: {
    deadline?: number; runEndpoint?: boolean; body?: unknown; limit?: number; stage?: string
  } = {}): Promise<unknown> => {
    const operation = settings.stage ?? requestStage(path, method), started = monotonicNow()
    stage = operation
    const requestRemaining = () => Math.max(0, (settings.deadline ?? deadline) - monotonicNow())
    if (requestRemaining() <= 0) throw new DispatchRequestError(null, 'budget-exhausted', operation)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new DispatchRequestError(null, 'timeout')) }, Math.min(timeoutMs, requestRemaining()))
    })
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetchData((settings.runEndpoint ? RUN_API : API) + path, {
          method, redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`,
            'X-GitHub-Api-Version': '2026-03-10', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify(settings.body ?? { ref: 'main' }) } : {}),
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          throw new DispatchRequestError(response.status, 'http')
        }
        if (method === 'POST') {
          // API versions can return either 204 or 200. Acknowledgement is enough;
          // do not follow or log response URLs and do not retry an ambiguous POST.
          void response.body?.cancel().catch(() => {})
          if (response.status !== 200 && response.status !== 204) throw new DispatchRequestError(response.status)
          return null
        }
        return boundedJson(response, settings.limit)
      })()])
    } catch (error) {
      const failure = error instanceof DispatchRequestError
        ? new DispatchRequestError(error.status, error.kind, operation) : new DispatchRequestError(null, 'network', operation)
      emit('request-failed', { ...errorFields(failure), elapsedMs: Math.max(0, Math.round(monotonicNow() - started)) })
      throw failure
    } finally { if (timer) clearTimeout(timer); controller.abort() }
  }

  const handoffEnabled = options.handoff !== false
  const predecessorIdText = env.STEAM_DISPATCH_PREDECESSOR_RUN_ID || '', predecessorAttemptText = env.STEAM_DISPATCH_PREDECESSOR_RUN_ATTEMPT || ''
  const currentId = handoffEnabled || predecessorIdText || predecessorAttemptText ? positiveId(env.GITHUB_RUN_ID) : null
  const currentAttempt = currentId ? positiveAttempt(env.GITHUB_RUN_ATTEMPT) : null
  if (!!predecessorIdText !== !!predecessorAttemptText) throw new Error('引継ぎ元の実行IDと回数が必要です。')

  const gate = async (phaseDeadline: number): Promise<boolean> => {
    if (!workflowActive(await request(DRIVER, 'GET', { deadline: phaseDeadline }))) { result.reason = 'dispatcher-disabled'; return false }
    if (!workflowActive(await request(COLLECTOR, 'GET', { deadline: phaseDeadline }))) { result.reason = 'collector-disabled'; return false }
    const run = dispatcherRun(await request(currentId!, 'GET', { deadline: phaseDeadline, runEndpoint: true, limit: HANDOFF_JSON_LIMIT }))
    if (run.id !== currentId || run.attempt !== currentAttempt) throw new DispatchRequestError()
    if (run.status === 'completed' || run.conclusion !== null) { result.reason = 'cancelled'; return false }
    return true
  }

  const slotWindowReason = (boundary: number): string | null => remaining() <= 0 ? 'budget-exhausted'
    : now() - boundary >= MAX_LATENESS_MS ? 'late' : null
  const slotFields = (boundary: number): LogFields => ({ scheduledAt: new Date(boundary).toISOString(),
    delayMs: Math.max(0, now() - boundary), dispatchAttempts })
  const logCollection = (run: CollectionRun | null, boundary: number) => emit('collection-state', {
    ...slotFields(boundary), stage, ...collectionFields(run), reason: collectionBlock(run, boundary) ?? 'clear',
  })

  const recheckCollection = async (initial: CollectionRun, boundary: number, slotDeadline: number): Promise<{
    run: CollectionRun | null; reason: string | null
  }> => {
    emit('collection-recheck', { ...slotFields(boundary), ...collectionFields(initial), reason: 'active-run', waitMs: COLLECTION_RECHECK_MS })
    const pause = Math.min(COLLECTION_RECHECK_MS, Math.max(0, slotDeadline - monotonicNow()), remaining())
    if (pause > 0) await wait(pause)
    const expired = slotWindowReason(boundary)
    if (expired) return { run: initial, reason: expired }
    // A workflow disabled while waiting must not be restarted by the recheck.
    if (!workflowActive(await request(DRIVER, 'GET', { deadline: slotDeadline }))) {
      result.reason = 'dispatcher-disabled'; return { run: initial, reason: result.reason }
    }
    if (!workflowActive(await request(COLLECTOR, 'GET', { deadline: slotDeadline }))) {
      result.reason = 'collector-disabled'; return { run: initial, reason: result.reason }
    }
    const detail = collectionRun(await request(initial.id, 'GET', {
      deadline: slotDeadline, runEndpoint: true, stage: 'collection-run-recheck',
    }))
    if (detail.id !== initial.id) throw new DispatchRequestError()
    logCollection(detail, boundary)
    const latest = latestCollection(await request(`${COLLECTOR}/runs?branch=main&per_page=1`, 'GET', {
      deadline: slotDeadline, stage: 'collection-list-recheck',
    }))
    logCollection(latest, boundary)
    // A new run/attempt must not be cleared by completion of the earlier one.
    if (!latest || detail.attempt !== initial.attempt || detail.createdAt !== initial.createdAt
      || latest.id !== detail.id || latest.attempt !== detail.attempt || latest.createdAt !== detail.createdAt
      || Date.parse(latest.updatedAt) > Date.parse(detail.updatedAt)) return { run: latest, reason: 'run-changed' }
    const reason = collectionBlock(detail, boundary)
    if (!reason) emit('collection-recheck-cleared', { ...slotFields(boundary), ...collectionFields(detail) })
    return { run: detail, reason }
  }

  if (predecessorIdText) {
    const predecessorId = positiveId(predecessorIdText), predecessorAttempt = positiveAttempt(predecessorAttemptText)
    const phaseDeadline = monotonicNow() + STEAM_DISPATCH_HANDOFF_MS
    let approved = false
    if (BigInt(predecessorId) < BigInt(currentId!)) {
      for (let poll = 0; poll < MAX_HANDOFF_POLLS && monotonicNow() < phaseDeadline; poll++) {
        try {
          // A queued successor must not resurrect a disabled/cancelled dispatcher.
          if (!(await gate(phaseDeadline))) break
          const predecessor = dispatcherRun(await request(predecessorId, 'GET', { deadline: phaseDeadline, runEndpoint: true, limit: HANDOFF_JSON_LIMIT }))
          if (predecessor.id !== predecessorId || predecessor.attempt !== predecessorAttempt) break
          if (predecessor.status === 'completed') {
            if (!['success', 'failure'].includes(predecessor.conclusion ?? '')) break
            const proof = await request(`${predecessorId}/attempts/${predecessorAttempt}/jobs?per_page=100`, 'GET', {
              deadline: phaseDeadline, runEndpoint: true, limit: HANDOFF_JSON_LIMIT,
            })
            if (hasHandoffProof(proof, predecessorId)) { approved = true; break }
          }
        } catch (error) {
          emit('predecessor-check-failed', errorFields(error))
          if (stopReason(error)) break
        }
        const pause = Math.min(HANDOFF_POLL_MS, Math.max(0, phaseDeadline - monotonicNow()))
        if (pause > 0) await wait(pause)
      }
    }
    if (!approved) {
      result.reason = 'predecessor-rejected'; result.failed++
      emit('predecessor-rejected', { predecessorRunId: predecessorId })
      emit('finished', { ...result })
      return result
    }
    emit('predecessor-confirmed', { predecessorRunId: predecessorId })
  }

  // Startup proof has its own bounded budget; it does not consume cadence slots.
  deadline = monotonicNow() + durationMs
  let nextBoundary = nextSteamDispatchBoundary(now())

  emit('started', { intervalSeconds: STEAM_DISPATCH_INTERVAL_MS / 1000, durationMinutes: durationMs / 60_000 })
  while (remaining() > 0) {
    const heartbeatStarted = monotonicNow()
    let enabled: boolean | null = null
    let heartbeatFailure: LogFields = {}
    try { enabled = workflowActive(await request(DRIVER)) }
    catch (error) {
      heartbeatFailure = errorFields(error)
      emit('heartbeat-unavailable', heartbeatFailure)
      const reason = stopReason(error)
      if (reason) { result.reason = reason; break }
    }
    if (remaining() <= 0) break
    if (enabled === false) { result.reason = 'dispatcher-disabled'; break }

    if (now() >= nextBoundary) {
      const boundary = nextBoundary
      nextBoundary = nextSteamDispatchBoundary(now() + 1)
      if (enabled === null) {
        result.failed++
        emit('slot-failed', { ...slotFields(boundary), ...heartbeatFailure, reason: 'heartbeat-unavailable' })
      } else if (slotWindowReason(boundary) || dispatchAttempts >= MAX_DISPATCH_ATTEMPTS) {
        result.skipped++
        emit('slot-skipped', { ...slotFields(boundary), stage: 'slot-window', reason: slotWindowReason(boundary) ?? 'attempt-limit' })
      } else {
        let observed: CollectionRun | null = null
        try {
          const slotDeadline = Math.min(deadline, monotonicNow() + Math.max(0, MAX_LATENESS_MS - (now() - boundary)))
          if (!workflowActive(await request(COLLECTOR, 'GET', { deadline: slotDeadline }))) { result.reason = 'collector-disabled'; break }
          observed = latestCollection(await request(`${COLLECTOR}/runs?branch=main&per_page=1`, 'GET', { deadline: slotDeadline }))
          logCollection(observed, boundary)
          let blocked = slotWindowReason(boundary) ?? collectionBlock(observed, boundary)
          if (blocked === 'active-run' && observed) {
            const checked = await recheckCollection(observed, boundary, slotDeadline)
            observed = checked.run; blocked = checked.reason
            if (result.reason !== 'duration') break
          }
          blocked = slotWindowReason(boundary) ?? blocked
          if (blocked) {
            result.skipped++
            emit('slot-skipped', { ...slotFields(boundary), stage, ...collectionFields(observed), reason: blocked })
          } else {
            dispatchAttempts++
            await request(`${COLLECTOR}/dispatches`, 'POST', { deadline: slotDeadline })
            result.dispatched++
            emit('dispatched', { ...slotFields(boundary), stage: 'collection-dispatch' })
          }
        } catch (error) {
          result.failed++
          emit('slot-failed', { ...slotFields(boundary), ...collectionFields(observed), ...errorFields(error), reason: 'request-or-response-failed' })
          const reason = stopReason(error)
          if (reason) { result.reason = reason; break }
        }
      }
    }
    const pause = Math.min(remaining(), Math.max(0, nextBoundary - now()),
      Math.max(0, STEAM_DISPATCH_HEARTBEAT_MS - (monotonicNow() - heartbeatStarted)))
    if (pause > 0) await wait(pause)
  }
  if (handoffEnabled && result.reason === 'duration') {
    const phaseDeadline = monotonicNow() + STEAM_DISPATCH_HANDOFF_MS
    const listSuccessor = async () => pendingSuccessor(await request(`${DRIVER}/runs?branch=main&per_page=20`, 'GET', {
      deadline: phaseDeadline, limit: HANDOFF_JSON_LIMIT,
    }), currentId!)
    let successor: string | null = null, postAttempted = false
    for (let poll = 0; poll < MAX_HANDOFF_POLLS && monotonicNow() < phaseDeadline; poll++) {
      try {
        if (!(await gate(phaseDeadline))) break
        const candidate = await listSuccessor()
        if (candidate) {
          if (await gate(phaseDeadline)) successor = candidate
          break
        }
        if (!postAttempted) {
          // Recheck immediately before the sole POST, closing the listing gap.
          if (!(await gate(phaseDeadline))) break
          postAttempted = true
          emit('handoff-requested', { predecessorRunId: currentId! })
          try {
            await request(`${DRIVER}/dispatches`, 'POST', { deadline: phaseDeadline,
              body: { ref: 'main', inputs: { mode: 'standard', predecessor_run_id: currentId!, predecessor_run_attempt: String(currentAttempt) } } })
          } catch (error) {
            if (stopReason(error)) throw error
            // The run may exist despite a lost response. Only GET is retried.
          }
          continue
        }
      } catch (error) {
        emit('handoff-check-failed', errorFields(error))
        const reason = stopReason(error)
        if (reason) { result.reason = reason; break }
      }
      const pause = Math.min(HANDOFF_POLL_MS, Math.max(0, phaseDeadline - monotonicNow()))
      if (pause > 0) await wait(pause)
    }
    if (successor && result.reason === 'duration') {
      result.handoff = 'confirmed'; result.successorRunId = successor
      emit('handoff-confirmed', { successorRunId: successor })
    } else if (result.reason === 'duration' || ['access-denied', 'rate-limited'].includes(result.reason)) {
      result.handoff = 'failed'; result.failed++
      emit('handoff-failed', { predecessorRunId: currentId! })
    }
  }
  emit('finished', { ...result })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).length) { console.error('引数は指定できません。'); process.exitCode = 1 }
  else runSteamPlayerCountDispatcher().then(async result => {
    if (result.handoff === 'confirmed' && result.successorRunId && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `handoff=confirmed\nsuccessor_run_id=${positiveId(result.successorRunId)}\n`)
    }
    if (result.reason === 'access-denied' || result.reason === 'rate-limited' || result.reason === 'predecessor-rejected'
      || result.failed > 0 || result.handoff === 'failed') process.exitCode = 1
  }).catch(() => { console.error('Steam同時接続数の起動処理を開始できませんでした。'); process.exitCode = 1 })
}
