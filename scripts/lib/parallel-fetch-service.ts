import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { parseParallelFetchConfig, parseParallelFetchReport } from '../../src/lib/parallelFetch.ts'
import type { ParallelFetchConfig, ParallelFetchReport, ParallelFetchServiceStatus } from '../../src/types/parallelFetch.ts'
import { createBucklerSessionStore } from './buckler-session-store.ts'
import { createParallelFetchBrowserSession } from './parallel-fetch-browser.ts'
import type { ParallelFetchBrowserSession } from './parallel-fetch-browser.ts'
import { runParallelFetch } from './parallel-fetch-runner.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const PARALLEL_FETCH_API_PREFIX = '/sf6/__parallel-fetch'
export const PARALLEL_FETCH_BODY_LIMIT = 4096
const SAFE_MESSAGES = {
  forbidden: 'この操作は同じPCのアプリ画面から実行してください。',
  'invalid-request': '並列取得テストのリクエストを確認してください。',
  'body-too-large': 'リクエストが上限を超えています。',
  'already-running': '並列取得テストはすでに実行中です。',
  'service-closed': '並列取得テストの受付を終了しています。',
  'report-save-failed': 'テスト結果をローカルへ保存できませんでした。',
} as const
type ServiceErrorCode = keyof typeof SAFE_MESSAGES
class ServiceError extends Error {
  readonly status: number
  readonly code: ServiceErrorCode
  constructor(status: number, code: ServiceErrorCode) { super(SAFE_MESSAGES[code]); this.status = status; this.code = code }
}

export interface ParallelFetchServiceDependencies {
  now?(): number
  sessionAvailable?(): Promise<boolean>
  openBrowser?(config: ParallelFetchConfig, signal: AbortSignal): Promise<ParallelFetchBrowserSession>
  run?: typeof runParallelFetch
  saveReport?(report: ParallelFetchReport): Promise<void>
}

/** Exclusive creation in a fixed private subtree; only a reconstructed terminal report can be persisted. */
export function createParallelFetchReportWriter(root = ROOT): (report: ParallelFetchReport) => Promise<void> {
  const project = resolve(root), local = resolve(project, '.local'), directory = resolve(local, 'parallel-fetch')
  async function ancestors(path: string): Promise<void> {
    for (let current = path; ; current = dirname(current)) {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
      if (current === dirname(current)) return
    }
  }
  return async value => {
    try {
      const report = parseParallelFetchReport(value)
      if (report.state === 'running') throw new Error()
      await ancestors(project)
      for (const path of [local, directory]) {
        await ancestors(dirname(path))
        try {
          const info = await lstat(path)
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
          await mkdir(path, { mode: 0o700 })
        }
      }
      await ancestors(directory)
      const text = `${JSON.stringify(report, null, 2)}\n`
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error()
      const path = resolve(directory, `parallel-fetch-${report.runId}.json`)
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
    } catch { throw new ServiceError(500, 'report-save-failed') }
  }
}

function loopback(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}
function requestOrigin(request: IncomingMessage): string {
  if (!loopback(request.socket.remoteAddress)) throw new ServiceError(403, 'forbidden')
  const host = request.headers.host
  if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9]\d{0,4})?$/.test(host)) throw new ServiceError(403, 'forbidden')
  const url = new URL(`http://${host}`)
  const port = url.port ? Number(url.port) : 80
  if (port > 65535 || request.socket.localPort !== port) throw new ServiceError(403, 'forbidden')
  const origin = `http://${host}`
  if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new ServiceError(403, 'forbidden')
  if (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin'
    && request.headers['sec-fetch-site'] !== 'none') throw new ServiceError(403, 'forbidden')
  return origin
}
function requireWrite(request: IncomingMessage, origin: string, token: string): void {
  if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'none') throw new ServiceError(403, 'forbidden')
  const supplied = request.headers['x-parallel-fetch-token']
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new ServiceError(403, 'forbidden')
  if (typeof request.headers['content-type'] !== 'string'
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'])) throw new ServiceError(400, 'invalid-request')
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  const length = request.headers['content-length']
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) throw new ServiceError(400, 'invalid-request')
  if (length !== undefined && Number(length) > PARALLEL_FETCH_BODY_LIMIT) { request.resume(); throw new ServiceError(413, 'body-too-large') }
  const bytes = await new Promise<Buffer>((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0, done = false
    const timer = setTimeout(() => finish(new ServiceError(400, 'invalid-request')), 5000)
    const finish = (error?: Error): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      request.removeListener('data', onData); request.removeListener('end', onEnd)
      request.removeListener('error', onError); request.removeListener('aborted', onError)
      if (error) { request.once('error', () => {}); request.resume(); reject(error) } else resolveBody(Buffer.concat(chunks))
    }
    const onData = (chunk: Uint8Array | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > PARALLEL_FETCH_BODY_LIMIT) finish(new ServiceError(413, 'body-too-large'))
      else chunks.push(buffer)
    }
    const onEnd = (): void => { finish() }
    const onError = (): void => { finish(new ServiceError(400, 'invalid-request')) }
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onError)
  })
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new ServiceError(400, 'invalid-request') }
}
function reply(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  for (const name of ['Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers']) response.removeHeader(name)
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(`${JSON.stringify(value)}\n`)
}

export function createParallelFetchService(dependencies: ParallelFetchServiceDependencies = {}) {
  const token = randomBytes(32).toString('hex')
  const sessionAvailable = dependencies.sessionAvailable ?? (() => createBucklerSessionStore().exists())
  const openBrowser = dependencies.openBrowser ?? ((config, signal) => createParallelFetchBrowserSession({ intervalMs: config.intervalMs, signal }))
  const saveReport = dependencies.saveReport ?? createParallelFetchReportWriter()
  let report: ParallelFetchReport | null = null, closed = false, persistenceError = false
  let active: { controller: AbortController; promise: Promise<void> } | null = null
  const now = dependencies.now ?? Date.now
  const metadata: { checkedAt: number; value: boolean; pending: Promise<boolean> | null } = { checkedAt: -Infinity, value: false, pending: null }
  async function availableSession(): Promise<boolean> {
    if (Number.isFinite(metadata.checkedAt) && (active || now() - metadata.checkedAt < 30000)) return metadata.value
    metadata.pending ??= (async () => {
      try { metadata.value = await sessionAvailable() } catch { metadata.value = false }
      metadata.checkedAt = now()
      return metadata.value
    })()
    const pending = metadata.pending
    try { return await pending } finally { if (metadata.pending === pending) metadata.pending = null }
  }
  async function status(): Promise<ParallelFetchServiceStatus & { error?: ServiceErrorCode }> {
    const available = await availableSession()
    return { available: !closed, sessionAvailable: available, token, report: report ? parseParallelFetchReport(report) : null,
      ...(persistenceError ? { error: 'report-save-failed' as const } : {}) }
  }
  function start(config: ParallelFetchConfig): void {
    if (closed) throw new ServiceError(503, 'service-closed')
    if (active) throw new ServiceError(409, 'already-running')
    const controller = new AbortController()
    const job = { controller, promise: Promise.resolve() }
    active = job; persistenceError = false
    const sessionState: { promise: Promise<ParallelFetchBrowserSession> | null } = { promise: null }
    const startedAt = new Date().toISOString()
    job.promise = (async () => {
      try {
        const result = await (dependencies.run ?? runParallelFetch)(config, {
          signal: controller.signal,
          createReader: async (workerId, target, signal) => {
            sessionState.promise ??= openBrowser(config, controller.signal)
            return (await sessionState.promise).createReader(workerId, target, signal)
          },
          onUpdate: value => { report = parseParallelFetchReport(value) },
        })
        report = parseParallelFetchReport(result)
      } catch {
        report = parseParallelFetchReport({ schemaVersion: 1, runId: randomBytes(16).toString('hex'), config,
          state: controller.signal.aborted ? 'stopped' : 'error', startedAt, finishedAt: new Date().toISOString(),
          trials: [], errorCode: controller.signal.aborted ? 'cancelled' : 'read-failed' })
      } finally {
        if (sessionState.promise) { try { await (await sessionState.promise).close() } catch { /* Never surface browser/authentication details. */ } }
        if (report) { try { await saveReport(parseParallelFetchReport(report)) } catch { persistenceError = true } }
        if (active === job) active = null
      }
    })()
  }
  return {
    async handle(request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> {
      if (!request.url?.startsWith(PARALLEL_FETCH_API_PREFIX)) { next(); return }
      try {
        const origin = requestOrigin(request)
        if (request.url === `${PARALLEL_FETCH_API_PREFIX}/status` && request.method === 'GET') { reply(response, 200, await status()); return }
        if ((request.url === `${PARALLEL_FETCH_API_PREFIX}/run` || request.url === `${PARALLEL_FETCH_API_PREFIX}/stop`) && request.method === 'POST') {
          requireWrite(request, origin, token)
          const body = await readBody(request)
          if (request.url.endsWith('/run')) {
            let config: ParallelFetchConfig
            try { config = parseParallelFetchConfig(body) } catch { throw new ServiceError(400, 'invalid-request') }
            start(config)
          } else {
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) throw new ServiceError(400, 'invalid-request')
            active?.controller.abort()
          }
          reply(response, 202, await status()); return
        }
        reply(response, 405, { error: 'invalid-request', message: SAFE_MESSAGES['invalid-request'] })
      } catch (error) {
        const safe = error instanceof ServiceError ? error : new ServiceError(400, 'invalid-request')
        reply(response, safe.status, { error: safe.code, message: safe.message })
      }
    },
    async close(): Promise<void> {
      closed = true
      const job = active
      job?.controller.abort()
      await job?.promise
    },
  }
}

/** This middleware is registered only by Vite's localhost development configuration. */
export function parallelFetchPlugin(): Plugin {
  let service: ReturnType<typeof createParallelFetchService> | null = null
  return { name: 'local-parallel-fetch', apply: 'serve',
    configureServer(server) {
      service = createParallelFetchService()
      server.middlewares.use((request, response, next) => { void service!.handle(request, response, next) })
      server.httpServer?.once('close', () => { void service?.close() })
    },
    async closeBundle() { await service?.close() },
  }
}
