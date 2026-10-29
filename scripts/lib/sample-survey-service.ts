import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { parseSampleSurveyConfig, parseSampleSurveyPlan, parseSampleSurveyRun, sampleSurveyRunActive } from '../../src/lib/sampleSurvey.ts'
import type { SampleSurveyPlan, SampleSurveyRun, SampleSurveyServiceStatus } from '../../src/types/sampleSurvey.ts'
import { createBucklerSessionStore } from './buckler-session-store.ts'
import { readBody, reply, requestOrigin, requireWrite, ServiceError } from './parallel-fetch-service.ts'
import { createSampleSurveyReader } from './sample-survey-browser.ts'
import type { SampleSurveyReader } from './sample-survey-reader.ts'
import { SampleSurveyReadError } from './sample-survey-reader.ts'
import { canResumeSampleSurvey, createSampleSurveyCheckpoint, markSampleSurveyInterrupted, runSampleSurvey } from './sample-survey-runner.ts'
import type { SampleSurveyCheckpoint } from './sample-survey-runner.ts'
import { createSampleSurveyStore } from './sample-survey-store.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const SAMPLE_SURVEY_API_PREFIX = '/sf6/__sample-survey'
type SurveyStore = Pick<ReturnType<typeof createSampleSurveyStore>, 'savePlan' | 'listPlans' | 'saveRun' | 'listRuns' | 'loadRun' | 'close'>
export interface SampleSurveyServiceDependencies {
  root?: string
  store?: SurveyStore
  now?(): number
  sessionAvailable?(): Promise<boolean>
  openReader?(signal: AbortSignal): Promise<SampleSurveyReader>
  run?: typeof runSampleSurvey
}
class SurveyServiceError extends Error {
  status: number
  code: string
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code }
}
const serviceMessages: Record<string, string> = {
  'invalid-request': '調査条件・実行番号が不正です。', forbidden: '同じPCのアプリ画面から操作してください。',
  'already-running': '標本調査を取得中です。', 'service-closed': '取得サービスは終了しています。',
  'storage-error': '標本調査の記録を保存・読込できません。', 'session-unavailable': '保存済みログイン情報がありません。',
  'not-found': '保存済みの計画・観測回がありません。', 'not-resumable': 'この観測回は再開できません。',
  'already-started': 'この計画は実行済みです。履歴を確認してください。', 'body-too-large': 'リクエストが上限を超えています。',
}
function commandId(body: unknown, key: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) throw new SurveyServiceError(400, 'invalid-request')
  const value = (body as Record<string, unknown>)[key]
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new SurveyServiceError(400, 'invalid-request')
  return value
}

export function createSampleSurveyService(dependencies: SampleSurveyServiceDependencies = {}) {
  const token = randomBytes(32).toString('hex'), now = dependencies.now ?? Date.now
  let store: SurveyStore | null = dependencies.store ?? null, storageError = false, closed = false
  let initialized = false, closing = false
  let closePromise: Promise<void> | null = null
  const memoryReports = new Map<string, SampleSurveyRun>()
  let active: { controller: AbortController; checkpoint: SampleSurveyCheckpoint; promise: Promise<void> } | null = null
  let sessionCache = { at: -Infinity, available: false, pending: null as Promise<boolean> | null }
  const getStore = (): SurveyStore => {
    if (closed) throw new SurveyServiceError(503, 'service-closed')
    try {
      store ??= createSampleSurveyStore(dependencies.root ?? ROOT)
      if (!initialized) {
        // A dev-server restart must not leave a non-existent process shown as collecting.
        for (const run of store.listRuns()) if (sampleSurveyRunActive(run)) {
          const checkpoint = store.loadRun(run.id)
          if (checkpoint) {
            store.saveRun(markSampleSurveyInterrupted(checkpoint, now()))
          }
        }
        initialized = true
      }
      return store
    } catch (error) { storageError = true; if (error instanceof SurveyServiceError) throw error; throw new SurveyServiceError(500, 'storage-error') }
  }
  async function hasSession(): Promise<boolean> {
    if (active || now() - sessionCache.at < 30_000) return sessionCache.available
    sessionCache.pending ??= (async () => {
      try { sessionCache.available = await (dependencies.sessionAvailable ?? (() => createBucklerSessionStore().exists()))() }
      catch { sessionCache.available = false }
      sessionCache.at = now()
      return sessionCache.available
    })()
    const pending = sessionCache.pending
    try { return await pending } finally { if (sessionCache.pending === pending) sessionCache.pending = null }
  }
  async function status(): Promise<SampleSurveyServiceStatus> {
    let plans: SampleSurveyPlan[] = [], runs: SampleSurveyRun[] = []
    if (!closed) {
      try { const storage = getStore(); plans = storage.listPlans().slice(0, 100).map(parseSampleSurveyPlan); runs = storage.listRuns().slice(0, 100).map(parseSampleSurveyRun) }
      catch { storageError = true }
    }
    runs = [...memoryReports.values(), ...runs.filter(run => !memoryReports.has(run.id))]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100)
    if (active) {
      const report = parseSampleSurveyRun(active.checkpoint.report)
      runs = [report, ...runs.filter(run => run.id !== report.id)].slice(0, 100)
    }
    return { available: !closed && !closing && !storageError, sessionAvailable: closed ? false : await hasSession(), token, plans, runs,
      activeRunId: active && sampleSurveyRunActive(active.checkpoint.report) ? active.checkpoint.report.id : null,
      ...(closed ? { error: 'service-closed' as const } : storageError ? { error: 'storage-error' as const } : {}) }
  }
  function persist(checkpoint: SampleSurveyCheckpoint): void {
    memoryReports.set(checkpoint.report.id, parseSampleSurveyRun(checkpoint.report))
    if (memoryReports.size > 100) memoryReports.delete(memoryReports.keys().next().value!)
    try { getStore().saveRun(checkpoint) }
    catch { storageError = true; throw new SampleSurveyReadError('storage-error') }
  }
  function start(plan: SampleSurveyPlan, checkpoint?: SampleSurveyCheckpoint): void {
    if (closed || closing) throw new SurveyServiceError(503, 'service-closed')
    if (active) throw new SurveyServiceError(409, 'already-running')
    const current = checkpoint ?? createSampleSurveyCheckpoint(plan, now())
    // The runner validates a stopped checkpoint before changing it to active.
    const runnerInput = structuredClone(current)
    const jobStarted = now(), previousElapsed = current.report.elapsedMs
    const timestamp = new Date(Math.max(now(), Date.parse(current.report.updatedAt))).toISOString()
    current.report = parseSampleSurveyRun({ ...current.report, state: current.frames.length ? 'running' : 'preparing',
      updatedAt: timestamp, finishedAt: null, stopReason: null, resumeAllowed: false })
    persist(current)
    const controller = new AbortController()
    const job = { controller, checkpoint: current, promise: Promise.resolve() }
    active = job
    job.promise = (async () => {
      let reader: SampleSurveyReader | null = null
      const timer = setTimeout(() => controller.abort(new SampleSurveyReadError('limit-reached')), plan.config.maxDurationMinutes * 60_000)
      timer.unref()
      try {
        reader = await (dependencies.openReader ?? (signal => createSampleSurveyReader({ signal,
          onReadFailure: async diagnostic => {
            // Store fixed diagnostic fields only, separately from public aggregates and private IDs.
            const text = JSON.stringify({ runId: job.checkpoint.report.id, ...diagnostic }, null, 2) + '\n'
            if (Buffer.byteLength(text) > 64 * 1024) return
            await writeFile(resolve(dependencies.root ?? ROOT, '.local/sample-survey', `diagnostic-${job.checkpoint.report.id}.json`),
              text, { flag: 'wx', mode: 0o600 })
          },
        })))(controller.signal)
        if (controller.signal.aborted) throw controller.signal.reason ?? new SampleSurveyReadError('cancelled')
        runnerInput.report.elapsedMs = previousElapsed + Math.max(0, now() - jobStarted)
        const result = await (dependencies.run ?? runSampleSurvey)(plan, {
          reader, signal: controller.signal, checkpoint: runnerInput, now,
          onUpdate: async value => { job.checkpoint = value; persist(value) },
        })
        job.checkpoint = result; persist(result)
      } catch (error) {
        const code = controller.signal.aborted ? controller.signal.reason instanceof SampleSurveyReadError ? controller.signal.reason.code : 'cancelled'
          : error instanceof SampleSurveyReadError ? error.code : 'read-failed'
        const timestamp = new Date(Math.max(now(), Date.parse(job.checkpoint.report.updatedAt))).toISOString()
        job.checkpoint.report = parseSampleSurveyRun({ ...job.checkpoint.report,
          state: ['cancelled', 'limit-reached', 'interrupted'].includes(code) ? 'stopped' : 'error', updatedAt: timestamp, finishedAt: timestamp,
          elapsedMs: Math.max(job.checkpoint.report.elapsedMs, previousElapsed + Math.max(0, now() - jobStarted)),
          stopReason: code, resumeAllowed: false })
        job.checkpoint.report.resumeAllowed = canResumeSampleSurvey(job.checkpoint)
        try { persist(job.checkpoint) } catch { /* Fixed storage status is exposed; private errors never are. */ }
      } finally {
        clearTimeout(timer)
        try { await reader?.close() } catch { /* Private browser details remain internal. */ }
        if (active === job) active = null
      }
    })()
  }
  return {
    async handle(request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> {
      if (!request.url?.startsWith(`${SAMPLE_SURVEY_API_PREFIX}/`)) { next(); return }
      try {
        const origin = requestOrigin(request)
        if (request.method === 'GET' && request.url === `${SAMPLE_SURVEY_API_PREFIX}/status`) { reply(response, 200, await status()); return }
        const action = request.url.slice(SAMPLE_SURVEY_API_PREFIX.length + 1)
        if (request.method !== 'POST' || !['plan', 'run', 'resume', 'stop'].includes(action)) throw new SurveyServiceError(405, 'invalid-request')
        requireWrite(request, origin, token)
        const body = await readBody(request)
        if (closed || closing) throw new SurveyServiceError(503, 'service-closed')
        if (action === 'stop') {
          const runId = commandId(body, 'runId')
          if (active?.checkpoint.report.id === runId) active.controller.abort(new SampleSurveyReadError('cancelled'))
          else if (!memoryReports.has(runId) && !getStore().loadRun(runId)) throw new SurveyServiceError(404, 'not-found')
        } else {
          if (active) throw new SurveyServiceError(409, 'already-running')
          const storage = getStore()
          if (action === 'plan') {
            let config
            try { config = parseSampleSurveyConfig(body) } catch { throw new SurveyServiceError(400, 'invalid-request') }
            const plan = parseSampleSurveyPlan({ schemaVersion: 1, id: randomUUID(), createdAt: new Date(now()).toISOString(), seed: randomBytes(16).toString('hex'), config })
            try { storage.savePlan(plan) } catch { throw new SurveyServiceError(500, 'storage-error') }
          } else {
            if (!await hasSession()) throw new SurveyServiceError(409, 'session-unavailable')
            // The readiness check can yield; reserve again before starting a second request.
            if (active) throw new SurveyServiceError(409, 'already-running')
            if (action === 'run') {
              const planId = commandId(body, 'planId')
              const plan = storage.listPlans().find(item => item.id === planId)
              if (!plan) throw new SurveyServiceError(404, 'not-found')
              if (storage.listRuns().some(run => run.planId === planId)) throw new SurveyServiceError(409, 'already-started')
              start(plan)
            } else {
              const runId = commandId(body, 'runId'), checkpoint = storage.loadRun(runId)
              if (!checkpoint) throw new SurveyServiceError(404, 'not-found')
              if (!checkpoint.report.resumeAllowed || !canResumeSampleSurvey(checkpoint)) throw new SurveyServiceError(409, 'not-resumable')
              start(checkpoint.plan, checkpoint)
            }
          }
        }
        reply(response, 202, await status())
      } catch (error) {
        const known = error instanceof SurveyServiceError || error instanceof ServiceError
        const code = known ? error.code : error instanceof SampleSurveyReadError && error.code === 'storage-error' ? 'storage-error' : 'invalid-request'
        if (code === 'storage-error') storageError = true
        reply(response, known ? error.status : code === 'storage-error' ? 500 : 400,
          { error: code, message: serviceMessages[code] ?? serviceMessages['invalid-request'] })
      }
    },
    close(): Promise<void> {
      if (!closePromise) {
        closing = true
        closePromise = (async () => {
          // Keep persistence available while the cancelled job writes its terminal checkpoint.
          const job = active
          job?.controller.abort(new SampleSurveyReadError('interrupted'))
          await job?.promise
          closed = true
          store?.close()
        })()
      }
      return closePromise
    },
  }
}
export function sampleSurveyPlugin(): Plugin {
  let service: ReturnType<typeof createSampleSurveyService> | null = null
  return { name: 'local-sample-survey', apply: 'serve', configureServer(server) {
    service = createSampleSurveyService()
    server.middlewares.use((request, response, next) => { void service!.handle(request, response, next) })
    server.httpServer?.once('close', () => { void service?.close() })
  }, async closeBundle() { await service?.close() } }
}
