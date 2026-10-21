import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { isCloudRunActive, parseCloudRun, parseCloudServiceStatus } from '../../src/lib/parallelFetchCloud.ts'
import type { CloudError, CloudMode, CloudRun, CloudServiceStatus } from '../../src/types/parallelFetchCloud.ts'
import { requestOrigin, requireWrite, readBody, reply, ServiceError } from './parallel-fetch-service.ts'
import { createCloudGitHub, ParallelFetchCloudServiceError } from './parallel-fetch-github.ts'
import type { CloudGitHub, CloudRemoteRun } from './parallel-fetch-github.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const PARALLEL_FETCH_CLOUD_API_PREFIX = '/sf6/__parallel-fetch-cloud'
export const CLOUD_POLL_INTERVAL_MS = 15000
const STATE_LIMIT = 8 * 1024 * 1024
export interface CloudStateStore { load(): Promise<CloudRun[]>; save(runs: CloudRun[]): Promise<void> }
function safeError(error: unknown, fallback: CloudError = 'github-unavailable'): CloudError {
  return error instanceof ParallelFetchCloudServiceError && error.code !== 'gh-unavailable' ? error.code : fallback
}
function fail(code: CloudError): never { throw new ParallelFetchCloudServiceError(code) }
function parseRuns(value: unknown): CloudRun[] {
  if (!Array.isArray(value) || value.length > 100) return fail('state-invalid')
  const runs = value.map(parseCloudRun)
  if (new Set(runs.map(run => run.requestId)).size !== runs.length || runs.filter(isCloudRunActive).length > 1) return fail('state-invalid')
  return runs
}

/** Only sanitized records enter a fixed private file; replacement is atomic. */
export function createCloudStateStore(root = ROOT): CloudStateStore {
  const project = resolve(root), local = resolve(project, '.local'), directory = resolve(local, 'parallel-fetch-cloud')
  const path = resolve(directory, 'state.json')
  async function ancestors(current: string): Promise<void> {
    for (;;) {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
      if (current === dirname(current)) break
      current = dirname(current)
    }
  }
  async function checkFile(): Promise<boolean> {
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > STATE_LIMIT) throw new Error(); return true }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error }
  }
  return {
    async load() {
      try {
        await ancestors(project)
        for (const parent of [local, directory]) {
          try { await ancestors(parent) } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
            throw error
          }
        }
        if (!await checkFile()) return []
        const bytes = await readFile(path)
        if (bytes.length > STATE_LIMIT) throw new Error()
        const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))
        if (value.schemaVersion !== 1) throw new Error()
        return parseRuns(value.runs)
      } catch { return fail('state-invalid') }
    },
    async save(input) {
      let temporary: string | undefined
      try {
        const runs = parseRuns(input)
        const text = JSON.stringify({ schemaVersion: 1, runs })
        if (Buffer.byteLength(text) > STATE_LIMIT) throw new Error()
        await ancestors(project)
        for (const parent of [local, directory]) {
          try { await mkdir(parent, { mode: 0o700 }) } catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
          }
          await ancestors(parent)
        }
        await checkFile()
        temporary = resolve(directory, `.state-${randomUUID()}.tmp`)
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
        await ancestors(directory); await checkFile()
        await rename(temporary, path)
        temporary = undefined
      } catch { return fail('state-save-failed') }
      finally { if (temporary) await unlink(temporary).catch(() => {}) }
    },
  }
}

export interface ParallelFetchCloudServiceDependencies {
  github?: CloudGitHub
  store?: CloudStateStore
  now?: () => number
  uuid?: () => string
  schedule?: (callback: () => void, milliseconds: number) => () => void
}

export function createParallelFetchCloudService(dependencies: ParallelFetchCloudServiceDependencies = {}) {
  const github = dependencies.github ?? createCloudGitHub(), store = dependencies.store ?? createCloudStateStore()
  const now = dependencies.now ?? Date.now, uuid = dependencies.uuid ?? randomUUID
  const token = randomBytes(32).toString('hex')
  let runs: CloudRun[] = [], closed = false, initialized = false, init: Promise<void> | null = null
  let readiness: CloudServiceStatus['readiness'] = 'checking', serviceError: CloudError | null = null
  let lastPoll = -Infinity, lastReadiness = -Infinity, polling: Promise<void> | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const dispatches = new Set<Promise<void>>()
  const timestamp = (): string => new Date(now()).toISOString()
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(action)
    queue = result.catch(() => {})
    return result
  }
  async function persist(): Promise<void> {
    try { await store.save(runs.map(parseCloudRun)); if (serviceError === 'state-save-failed') serviceError = null }
    catch { serviceError = 'state-save-failed'; fail('state-save-failed') }
  }
  async function initialize(): Promise<void> {
    init ??= (async () => {
      try {
        runs = parseRuns(await store.load())
        let changed = false
        for (const run of runs) if (run.dispatchState === 'pending') {
          run.dispatchState = 'uncertain'; run.state = 'dispatch-unknown'; run.error = 'dispatch-uncertain'; changed = true
        }
        if (changed) await persist()
      } catch (error) { serviceError = safeError(error, 'state-invalid') }
      finally { initialized = true }
    })()
    await init
  }
  function snapshot(): CloudServiceStatus {
    return parseCloudServiceStatus({ available: !closed && serviceError !== 'state-invalid', token, readiness,
      activeRequestId: runs.find(isCloudRunActive)?.requestId ?? null, runs, error: serviceError })
  }
  async function checkReadiness(force = false): Promise<void> {
    if (!force && now() - lastReadiness < 60000) return
    try { readiness = await github.readiness() } catch { readiness = 'github-unavailable' }
    lastReadiness = now()
  }
  function assertRemote(run: CloudRun, remote: CloudRemoteRun): void {
    if (remote.requestId !== run.requestId || run.runId !== null && (run.runId !== remote.runId || run.runAttempt !== remote.runAttempt)) fail('run-ambiguous')
  }
  async function reconcile(run: CloudRun): Promise<void> {
    try {
      const remote = run.runId ? await github.getRun(run.runId, run.runAttempt!) : await github.findRun(run.requestId)
      if (!remote) {
        run.state = 'dispatch-unknown'; run.error = 'dispatch-uncertain'
        return
      }
      assertRemote(run, remote)
      run.runId = remote.runId; run.runAttempt = remote.runAttempt; run.dispatchState = 'sent'
      run.startedAt = remote.startedAt; run.finishedAt = remote.finishedAt; run.headSha = remote.headSha; run.conclusion = remote.conclusion
      run.error = null
      if (remote.state !== 'completed') {
        if (run.state !== 'cancel-requested') run.state = remote.state
        return
      }
      run.state = 'loading-result'
      try {
        const report = await github.readReport(remote, run.mode)
        const validated = parseCloudRun({ ...run, report })
        run.report = validated.report
        run.state = remote.conclusion === 'cancelled' ? 'cancelled' : report.state === 'complete' && remote.conclusion === 'success' ? 'complete' : 'failed'
        run.error = remote.conclusion !== 'success' && report.state === 'complete' ? 'workflow-failed' : null
      } catch (error) {
        run.error = safeError(error, 'invalid-report')
        run.state = remote.conclusion === 'cancelled' ? 'cancelled' : 'failed'
      }
    } catch (error) {
      run.error = safeError(error)
      if (run.error === 'run-ambiguous') run.state = 'dispatch-unknown'
    } finally { run.updatedAt = timestamp() }
  }
  async function poll(force = false): Promise<void> {
    await initialize()
    if (closed || serviceError === 'state-invalid') return
    if (polling) return polling
    if (!force && now() - lastPoll < CLOUD_POLL_INTERVAL_MS) return
    polling = exclusive(async () => {
      await checkReadiness()
      const active = runs.filter(run => isCloudRunActive(run) && run.state !== 'dispatching')
      for (const run of active) {
        if (run.state === 'dispatching') continue
        await reconcile(run)
      }
      if (active.length) await persist()
      lastPoll = now()
    }).catch(error => { serviceError = safeError(error) }).finally(() => { polling = null })
    return polling
  }
  async function status(): Promise<CloudServiceStatus> {
    await initialize()
    void poll()
    return snapshot()
  }
  async function start(mode: CloudMode): Promise<CloudServiceStatus> {
    await initialize()
    await exclusive(async () => {
      if (closed) fail('service-closed')
      if (serviceError === 'state-invalid' || serviceError === 'state-save-failed') fail(serviceError)
      if (runs.some(isCloudRunActive)) fail('already-running')
      if (readiness !== 'ready') fail(readiness === 'workflow-unavailable' ? 'workflow-unavailable' : 'github-unavailable')
      const run = parseCloudRun({ requestId: uuid(), mode, createdAt: timestamp(), updatedAt: timestamp(), dispatchState: 'pending',
        runId: null, runAttempt: null, state: 'dispatching', startedAt: null, finishedAt: null, headSha: null, conclusion: null, report: null, error: null })
      const previous = runs
      runs = [run, ...runs].slice(0, 20)
      try { await persist() } catch (error) { runs = previous; throw error }
      // A persisted pending request is never submitted a second time after a crash or ambiguous response.
      const dispatch = (async () => {
        let sent = false
        try {
          await github.dispatch(mode, run.requestId)
          sent = true
        } catch { /* An ambiguous response never authorizes another dispatch. */ }
        await exclusive(async () => {
          run.dispatchState = sent ? 'sent' : 'uncertain'; run.state = sent ? 'queued' : 'dispatch-unknown'; run.error = sent ? null : 'dispatch-uncertain'
          run.updatedAt = timestamp(); await persist(); lastPoll = -Infinity
        }).catch(() => {})
      })()
      dispatches.add(dispatch)
      void dispatch.finally(() => dispatches.delete(dispatch))
    })
    return snapshot()
  }
  async function request(requestId: string, kind: 'stop' | 'retry'): Promise<CloudServiceStatus> {
    await initialize()
    await exclusive(async () => {
      if (closed) fail('service-closed')
      if (serviceError === 'state-invalid') fail('state-invalid')
      const run = runs.find(item => item.requestId === requestId)
      if (!run) fail('invalid-request')
      if (kind === 'retry') {
        // Reconcile and download only. Never call dispatch from a retry action.
        if (run.state === 'dispatching') fail('already-running')
        const job = exclusive(async () => { await reconcile(run); await persist(); lastPoll = now() }).catch(() => {})
        dispatches.add(job); void job.finally(() => dispatches.delete(job)); return
      }
      if (!run.runId || run.runAttempt === null || !isCloudRunActive(run) || run.state === 'cancel-requested') fail('invalid-request')
      const previousState = run.state
      run.state = 'cancel-requested'; run.error = null; run.updatedAt = timestamp()
      await persist()
      const job = exclusive(async () => {
        try {
          // Cancellation targets the current attempt, so re-check it rather than the pinned historical endpoint.
          const remote = await github.getRun(run.runId!)
          assertRemote(run, remote)
          if (remote.state === 'completed') await reconcile(run)
          else await github.cancel(run.runId!)
        } catch (error) {
          run.error = safeError(error, 'cancel-failed') === 'run-ambiguous' ? 'run-ambiguous' : 'cancel-failed'
          run.state = previousState
        }
        await persist(); lastPoll = now()
      }).catch(() => {})
      dispatches.add(job); void job.finally(() => dispatches.delete(job))
    })
    return snapshot()
  }
  const unschedule = (dependencies.schedule ?? ((callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds); timer.unref(); return () => clearInterval(timer)
  }))(() => { if (initialized && !closed && runs.some(isCloudRunActive)) void poll() }, CLOUD_POLL_INTERVAL_MS)
  return {
    status, start, retry: (id: string) => request(id, 'retry'), stop: (id: string) => request(id, 'stop'),
    async waitForIdle(): Promise<void> { await Promise.allSettled([...dispatches]); await polling; await queue.catch(() => {}) },
    async handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
      if (!req.url?.startsWith(`${PARALLEL_FETCH_CLOUD_API_PREFIX}/`)) { next(); return }
      try {
        const origin = requestOrigin(req)
        if (req.method === 'GET' && req.url === `${PARALLEL_FETCH_CLOUD_API_PREFIX}/status`) { reply(res, 200, await status()); return }
        if (req.method === 'POST' && ['run', 'stop', 'retry'].some(path => req.url === `${PARALLEL_FETCH_CLOUD_API_PREFIX}/${path}`)) {
          requireWrite(req, origin, token)
          const body = await readBody(req)
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) fail('invalid-request')
          const input = body as Record<string, unknown>
          if (req.url.endsWith('/run')) {
            if (input.mode !== 'serial' && input.mode !== 'compare') fail('invalid-request')
            reply(res, 202, await start(input.mode))
          } else {
            if (typeof input.requestId !== 'string') fail('invalid-request')
            reply(res, 202, await request(input.requestId, req.url.endsWith('/stop') ? 'stop' : 'retry'))
          }
          return
        }
        reply(res, 405, { error: 'invalid-request' })
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : safeError(error, 'invalid-request')
        reply(res, error instanceof ServiceError ? error.status : code === 'already-running' ? 409 : code === 'service-closed' ? 503 : 400, { error: code })
      }
    },
    async close(): Promise<void> {
      closed = true; unschedule()
      await Promise.allSettled([...dispatches])
      await queue.catch(() => {})
      // Closing the local server must never cancel a remote workflow.
    },
  }
}

export function parallelFetchCloudPlugin(): Plugin {
  let service: ReturnType<typeof createParallelFetchCloudService> | null = null
  return { name: 'local-parallel-fetch-cloud', apply: 'serve', configureServer(server) {
    service = createParallelFetchCloudService()
    server.middlewares.use((request, response, next) => { void service!.handle(request, response, next) })
    server.httpServer?.once('close', () => { void service?.close() })
  }, async closeBundle() { await service?.close() } }
}
