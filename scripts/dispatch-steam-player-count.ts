import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export const STEAM_DISPATCH_INTERVAL_MS = 15 * 60 * 1000
export const STEAM_DISPATCH_DURATION_MS = 330 * 60 * 1000
export const STEAM_DISPATCH_HEARTBEAT_MS = 60 * 1000
const OFFSET_MS = 7 * 60 * 1000
const MAX_LATENESS_MS = 60 * 1000
const MAX_DISPATCH_ATTEMPTS = 22
const API = 'https://api.github.com/repos/gonchiman/sf6/actions/workflows/'
const DRIVER = 'steam-player-count-dispatch.yml'
const COLLECTOR = 'steam-player-count.yml'
type Environment = Record<string, string | undefined>
type StopReason = 'duration' | 'dispatcher-disabled' | 'collector-disabled' | 'access-denied' | 'rate-limited'
export type SteamDispatchResult = { reason: StopReason; dispatched: number; skipped: number; failed: number }

class DispatchRequestError extends Error {
  readonly status: number | null
  constructor(status: number | null = null) {
    super('Steam取得の起動要求を確認できませんでした。')
    this.status = status
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

/** :07/:22/:37/:52 UTC, matching the original collection schedule. */
export function nextSteamDispatchBoundary(timestamp: number): number {
  return Math.ceil((timestamp - OFFSET_MS) / STEAM_DISPATCH_INTERVAL_MS) * STEAM_DISPATCH_INTERVAL_MS + OFFSET_MS
}

const slotAt = (timestamp: number) => Math.floor((timestamp - OFFSET_MS) / STEAM_DISPATCH_INTERVAL_MS)

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new DispatchRequestError()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > 64 * 1024) throw new DispatchRequestError()
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    void reader.cancel().catch(() => {})
    throw new DispatchRequestError()
  } finally { reader.releaseLock() }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function workflowActive(value: unknown): boolean {
  if (!record(value) || typeof value.state !== 'string'
    || !['active', 'disabled_manually', 'disabled_inactivity', 'disabled_fork', 'deleted'].includes(value.state)) throw new DispatchRequestError()
  return value.state === 'active'
}

function hasCurrentOrRunningCollection(value: unknown, boundary: number): boolean {
  if (!record(value) || !Array.isArray(value.workflow_runs) || value.workflow_runs.length > 1) throw new DispatchRequestError()
  if (value.workflow_runs.length === 0) return false
  const latest = value.workflow_runs[0]
  if (!record(latest) || latest.head_branch !== 'main' || typeof latest.created_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(latest.created_at)
    || typeof latest.status !== 'string'
    || !['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed'].includes(latest.status)) throw new DispatchRequestError()
  const createdAt = Date.parse(latest.created_at)
  if (!Number.isFinite(createdAt)) throw new DispatchRequestError()
  // Compare aligned slots, not elapsed milliseconds: GitHub can create a run a
  // second after its dispatch, which must not suppress the next 15-minute slot.
  return latest.status !== 'completed' || slotAt(createdAt) >= slotAt(boundary)
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
  write?: (message: string) => void
} = {}): Promise<SteamDispatchResult> {
  const env = options.env ?? process.env
  if (!isAllowedSteamDispatcher(env)) throw new Error('固定mainのSteam起動workflowと認証が必要です。')
  const durationMs = options.durationMs ?? STEAM_DISPATCH_DURATION_MS
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > STEAM_DISPATCH_DURATION_MS
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error('実行時間の指定が不正です。')
  const now = options.now ?? Date.now, monotonicNow = options.monotonicNow ?? (() => performance.now())
  const wait = options.wait ?? delay, fetchData = options.fetch ?? fetch, write = options.write ?? console.log
  const started = monotonicNow(), deadline = started + durationMs
  let nextBoundary = nextSteamDispatchBoundary(now())
  let dispatchAttempts = 0
  const result: SteamDispatchResult = { reason: 'duration', dispatched: 0, skipped: 0, failed: 0 }
  const emit = (event: string, extra: Record<string, string | number> = {}) => write(JSON.stringify({ event, at: new Date(now()).toISOString(), ...extra }))
  const remaining = () => Math.max(0, deadline - monotonicNow())
  const stopReason = (error: unknown): StopReason | null => error instanceof DispatchRequestError
    ? [401, 403, 404].includes(error.status ?? 0) ? 'access-denied' : error.status === 429 ? 'rate-limited' : null : null

  const request = async (path: string, method: 'GET' | 'POST' = 'GET'): Promise<unknown> => {
    if (remaining() <= 0) throw new DispatchRequestError()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new DispatchRequestError()) }, Math.min(timeoutMs, remaining()))
    })
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetchData(API + path, {
          method, redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`,
            'X-GitHub-Api-Version': '2026-03-10', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify({ ref: 'main' }) } : {}),
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          throw new DispatchRequestError(response.status)
        }
        if (method === 'POST') {
          // API versions can return either 204 or 200. Acknowledgement is enough;
          // do not follow or log response URLs and do not retry an ambiguous POST.
          void response.body?.cancel().catch(() => {})
          if (response.status !== 200 && response.status !== 204) throw new DispatchRequestError()
          return null
        }
        return boundedJson(response)
      })()])
    } catch (error) {
      throw error instanceof DispatchRequestError ? error : new DispatchRequestError()
    } finally { if (timer) clearTimeout(timer) }
  }

  emit('started', { intervalSeconds: STEAM_DISPATCH_INTERVAL_MS / 1000, durationMinutes: durationMs / 60_000 })
  while (remaining() > 0) {
    const heartbeatStarted = monotonicNow()
    let enabled: boolean | null = null
    try { enabled = workflowActive(await request(DRIVER)) }
    catch (error) {
      const reason = stopReason(error)
      if (reason) { result.reason = reason; break }
      emit('heartbeat-unavailable')
    }
    if (remaining() <= 0) break
    if (enabled === false) { result.reason = 'dispatcher-disabled'; break }

    if (now() >= nextBoundary) {
      const boundary = nextBoundary
      nextBoundary = nextSteamDispatchBoundary(now() + 1)
      if (enabled === null) {
        result.failed++
        emit('slot-failed', { scheduledAt: new Date(boundary).toISOString() })
      } else if (now() - boundary > MAX_LATENESS_MS || dispatchAttempts >= MAX_DISPATCH_ATTEMPTS) {
        result.skipped++
        emit('slot-skipped', { scheduledAt: new Date(boundary).toISOString() })
      } else {
        try {
          if (!workflowActive(await request(COLLECTOR))) { result.reason = 'collector-disabled'; break }
          const latest = await request(`${COLLECTOR}/runs?branch=main&per_page=1`)
          if (remaining() <= 0) break
          if (now() - boundary > MAX_LATENESS_MS || hasCurrentOrRunningCollection(latest, boundary)) {
            result.skipped++
            emit('slot-skipped', { scheduledAt: new Date(boundary).toISOString() })
          } else {
            dispatchAttempts++
            await request(`${COLLECTOR}/dispatches`, 'POST')
            result.dispatched++
            emit('dispatched', { scheduledAt: new Date(boundary).toISOString() })
          }
        } catch (error) {
          result.failed++
          emit('slot-failed', { scheduledAt: new Date(boundary).toISOString() })
          const reason = stopReason(error)
          if (reason) { result.reason = reason; break }
        }
      }
    }
    const pause = Math.min(remaining(), Math.max(0, nextBoundary - now()),
      Math.max(0, STEAM_DISPATCH_HEARTBEAT_MS - (monotonicNow() - heartbeatStarted)))
    if (pause > 0) await wait(pause)
  }
  emit('finished', { ...result })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).length) { console.error('引数は指定できません。'); process.exitCode = 1 }
  else runSteamPlayerCountDispatcher().then(result => {
    if (result.reason === 'access-denied' || result.reason === 'rate-limited' || result.failed > 0) process.exitCode = 1
  }).catch(() => { console.error('Steam同時接続数の起動処理を開始できませんでした。'); process.exitCode = 1 })
}
