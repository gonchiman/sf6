import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserContextOptions } from 'playwright'
import { parseMrDistributionDataset } from '../src/lib/mrDistribution.ts'
import type { MrDistributionDataset } from '../src/types/mrDistribution.ts'
import { disableRankDistributionDiagnostics } from './collect-rank-distribution.ts'
import { rankDistributionCloudBrowserEnvironment } from './collect-rank-distribution-cloud.ts'
import { importMrDistributionData } from './import-mr-distribution-data.ts'
import { BUCKLER_SESSION_CAPTURE_PATH, createBucklerSessionStore, validateBucklerSessionState } from './lib/buckler-session-store.ts'
import { collectMrDistribution, MrDistributionCollectionError } from './lib/mr-distribution-collector.ts'
import type { MrDistributionPage } from './lib/mr-distribution-collector.ts'
import { createMrDistributionPageReader, MrDistributionDomError } from './lib/mr-distribution-dom.ts'
import type { MrDistributionDomErrorCode, MrDistributionPageReaderDiagnostics } from './lib/mr-distribution-dom.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = resolve(ROOT, '.local')
export const MR_DISTRIBUTION_CAPTURE_DIRECTORY = resolve(LOCAL, 'mr-distribution')
const PUBLIC_DIRECTORY = resolve(ROOT, 'public/data/mr-distribution')
type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>
const HELP = `Bucklerの今Act・最大MR分布を1回取得

node scripts/collect-mr-distribution.ts --collect [--max-requests 2〜600] [--import]

保存済みの認証状態をメモリ内で使い、全25閾値を新しく確認した100MR刻みの概数を
.local/mr-distribution/ に保存します。既定はローカル保存のみ。--importでアプリ用JSONへ取り込みます。
掲載順位が同点でも行位置で数えます。上限600読取・30分、通常のページ移動は5秒以上空けます。
ログイン・認証チャレンジ・認証状態の再保存・クラウド送信・週次設定は行いません。`

export class MrDistributionArgumentsError extends Error {
  constructor() { super('--collect [--max-requests 2〜600] [--import] または --help を指定してください。'); this.name = 'MrDistributionArgumentsError' }
}
export interface MrDistributionCaptureOptions { mode: 'collect'; maxRequests: number; import: boolean }
export function parseMrDistributionCaptureArguments(args: string[]): MrDistributionCaptureOptions | { mode: 'help' } {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' }
  if (args[0] !== '--collect') throw new MrDistributionArgumentsError()
  let maxRequests = 600, imported = false, bounded = false
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--import' && !imported) imported = true
    else if (args[i] === '--max-requests' && !bounded && /^[1-9]\d*$/.test(args[i + 1] ?? '')) {
      maxRequests = Number(args[++i]); bounded = true
      if (!Number.isSafeInteger(maxRequests) || maxRequests < 2 || maxRequests > 600) throw new MrDistributionArgumentsError()
    } else throw new MrDistributionArgumentsError()
  }
  return { mode: 'collect', maxRequests, import: imported }
}

export interface MrDistributionPrivateWriterIo {
  inspect(path: string): Promise<{ directory: boolean; symbolicLink: boolean } | null>
  mkdir(path: string): Promise<void>
  write(path: string, text: string): Promise<void>
}
const writerIo: MrDistributionPrivateWriterIo = {
  async inspect(path) {
    try { const info = await lstat(path); return { directory: info.isDirectory(), symbolicLink: info.isSymbolicLink() } }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error }
  },
  async mkdir(path) { await mkdir(path, { mode: 0o700 }) },
  async write(path, text) {
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
  },
}
/** Fixed directory, aggregate parser and exclusive creation; no credentials or row records can be saved. */
export function createMrDistributionPrivateWriter(io: MrDistributionPrivateWriterIo = writerIo) {
  async function parents(path: string): Promise<void> {
    for (let current = path; ; current = dirname(current)) {
      const value = await io.inspect(current)
      if (!value?.directory || value.symbolicLink) throw new Error()
      if (current === dirname(current)) return
    }
  }
  return async (value: MrDistributionDataset): Promise<string> => {
    try {
      const parsed = parseMrDistributionDataset(value)
      if (!/^max-mr-estimate-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(parsed.id)) throw new Error()
      await parents(ROOT)
      for (const directory of [LOCAL, MR_DISTRIBUTION_CAPTURE_DIRECTORY]) {
        await parents(dirname(directory))
        const info = await io.inspect(directory)
        if (!info) await io.mkdir(directory)
        else if (!info.directory || info.symbolicLink) throw new Error()
      }
      await parents(MR_DISTRIBUTION_CAPTURE_DIRECTORY)
      const path = resolve(MR_DISTRIBUTION_CAPTURE_DIRECTORY, `${parsed.id}.json`)
      if (await io.inspect(path)) throw new Error()
      const text = `${JSON.stringify(parsed, null, 2)}\n`
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error()
      await io.write(path, text)
      return path
    } catch { throw new Error('MR分布の集計を安全に保存できませんでした。') }
  }
}

export interface MrDistributionCaptureTransport {
  fetchPage(page: number, url: string): Promise<MrDistributionPage>
  getDiagnostics(): MrDistributionPageReaderDiagnostics
  close(): Promise<void>
}
export interface MrDistributionCaptureReport {
  schemaVersion: 1; status: 'succeeded' | 'failed'; startedAt: string; endedAt: string
  stage: 'authentication' | 'browser-launch' | 'collection' | 'dataset-save' | 'import' | 'complete'
  reason: null | 'authentication-unavailable' | 'browser-unavailable' | 'collection-failed' | 'dataset-save-failed' | 'import-failed' | 'cancelled' | 'time-limit' | 'request-limit'
  readFailureCode: MrDistributionDomErrorCode | null
  requestCount: number; successfulReadCount: number; retryCount: number; confirmedBoundaryCount: number
  datasetSaved: boolean; imported: boolean; browserClosed: boolean; initialSignInConfirmed: boolean
  readableWithoutSignInReadCount: number
}
export interface MrDistributionCaptureDependencies {
  loadSession: () => Promise<StorageState>
  launch: (state: StorageState, signal: AbortSignal) => Promise<MrDistributionCaptureTransport>
  saveDataset: (dataset: MrDistributionDataset) => Promise<string>
  importDataset?: (path: string) => Promise<unknown>
  now?: () => Date
  signal?: AbortSignal
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  progress?: (confirmedCount: number) => void
}

/** Orchestration returns a safe report; only a complete parsed aggregate reaches the writer. */
export async function runMrDistributionCollection(options: MrDistributionCaptureOptions, deps: MrDistributionCaptureDependencies): Promise<MrDistributionCaptureReport> {
  const now = deps.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const report: MrDistributionCaptureReport = { schemaVersion: 1, status: 'failed', startedAt, endedAt: startedAt, stage: 'authentication', reason: null,
    readFailureCode: null, requestCount: 0, successfulReadCount: 0, retryCount: 0, confirmedBoundaryCount: 0,
    datasetSaved: false, imported: false, browserClosed: false, initialSignInConfirmed: false, readableWithoutSignInReadCount: 0 }
  let transport: MrDistributionCaptureTransport | undefined, state: StorageState | undefined, timedOut = false, requestLimitReached = false
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (deps.signal?.aborted) abort()
  deps.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 30 * 60_000)
  timer.unref()
  const signal = controller.signal
  const wait = deps.wait ?? (async (milliseconds: number, current: AbortSignal) => { await delay(milliseconds, undefined, { signal: current }) })
  try {
    if (options.mode !== 'collect' || !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 2 || options.maxRequests > 600
      || typeof options.import !== 'boolean') throw new Error()
    signal.throwIfAborted()
    state = JSON.parse(validateBucklerSessionState(JSON.stringify(await deps.loadSession()))) as StorageState
    signal.throwIfAborted()
    report.stage = 'browser-launch'
    transport = await deps.launch(state, signal)
    state = undefined
    signal.throwIfAborted()
    report.stage = 'collection'
    const dataset = await collectMrDistribution({ maxRequests: options.maxRequests, now, signal,
      onBoundary: count => { report.confirmedBoundaryCount = count; deps.progress?.(count) },
      fetchPage: async (page, url) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted()
          if (report.requestCount >= options.maxRequests) { requestLimitReached = true; throw new MrDistributionCollectionError('request-limit') }
          report.requestCount++
          try { const value = await transport!.fetchPage(page, url); report.successfulReadCount++; return value }
          catch (error) {
            if (error instanceof MrDistributionDomError) report.readFailureCode = error.code
            const retryable = error instanceof MrDistributionDomError && ['timeout', 'read-failed', 'authentication-unconfirmed', 'server-error'].includes(error.code)
            if (attempt === 0 && retryable && report.requestCount < options.maxRequests && !signal.aborted) {
              report.retryCount++
              await wait(error.code === 'server-error' ? 5000 : 500, signal)
            } else throw error
          }
        }
        throw new Error()
      },
    })
    signal.throwIfAborted()
    const evidence = transport.getDiagnostics()
    if (!evidence.initialSignInConfirmed || !evidence.displayedConditionsConfirmed || !evidence.currentActConfirmed
      || evidence.successfulReadCount < 1) throw new MrDistributionCollectionError('collection-rejected')
    report.stage = 'dataset-save'
    const path = await deps.saveDataset(parseMrDistributionDataset(dataset))
    report.datasetSaved = true
    signal.throwIfAborted()
    if (options.import) {
      report.stage = 'import'
      if (!deps.importDataset) throw new Error()
      await deps.importDataset(path)
      report.imported = true
    }
    report.stage = 'complete'
    report.status = 'succeeded'
  } catch (error) {
    report.reason = timedOut ? 'time-limit' : signal.aborted ? 'cancelled'
      : requestLimitReached || error instanceof MrDistributionCollectionError && error.code === 'request-limit' ? 'request-limit'
        : error instanceof MrDistributionCollectionError && error.code === 'time-limit' ? 'time-limit'
          : report.stage === 'authentication' ? 'authentication-unavailable' : report.stage === 'browser-launch' ? 'browser-unavailable'
            : report.stage === 'dataset-save' ? 'dataset-save-failed' : report.stage === 'import' ? 'import-failed' : 'collection-failed'
  } finally {
    state = undefined
    if (transport) {
      try { const diagnostics = transport.getDiagnostics(); report.initialSignInConfirmed = diagnostics.initialSignInConfirmed === true
        const count = diagnostics.readableWithoutSignInReadCount
        report.readableWithoutSignInReadCount = Number.isSafeInteger(count) && count >= 0 ? count : 0 } catch { /* Safe report retains defaults. */ }
      try { await transport.close(); report.browserClosed = true } catch { /* No raw browser error is displayed. */ }
    }
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', abort)
  }
  try { report.endedAt = now().toISOString() } catch { report.endedAt = startedAt }
  return report
}

async function loadFixedSession(): Promise<StorageState> {
  const store = createBucklerSessionStore()
  const { parseCaptureRecord } = await import('./probe-buckler-session.ts')
  await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
  const info = await lstat(BUCKLER_SESSION_CAPTURE_PATH)
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 1024) throw new Error()
  const bytes = await readFile(BUCKLER_SESSION_CAPTURE_PATH)
  if (bytes.length !== info.size || bytes.length > 1024) throw new Error()
  const capture = parseCaptureRecord(JSON.parse(bytes.toString('utf8')))
  if (await store.identity() !== capture.stateIdentity) throw new Error()
  const state = validateBucklerSessionState(await store.load())
  if (await store.identity() !== capture.stateIdentity) throw new Error()
  await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
  return JSON.parse(state) as StorageState
}

async function launchFixedEdge(state: StorageState, signal: AbortSignal): Promise<MrDistributionCaptureTransport> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ channel: 'msedge', headless: false, timeout: 30_000, env: rankDistributionCloudBrowserEnvironment(process.env) })
  try {
    signal.throwIfAborted()
    const context = await browser.newContext({ locale: 'ja-JP', acceptDownloads: false, storageState: state })
    const reader = createMrDistributionPageReader(await context.newPage(), { signal, minIntervalMs: 5000, allowReadablePagesAfterSignIn: true })
    return { ...reader, close: () => browser.close() }
  } catch (error) { await browser.close().catch(() => {}); throw error }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  disableRankDistributionDiagnostics(process.env)
  const options = parseMrDistributionCaptureArguments(args)
  if (options.mode === 'help') { console.log(HELP); return }
  const controller = new AbortController()
  const interrupt = (): void => { controller.abort() }
  process.once('SIGINT', interrupt)
  try {
    const report = await runMrDistributionCollection(options, { loadSession: loadFixedSession, launch: launchFixedEdge,
      saveDataset: createMrDistributionPrivateWriter(), importDataset: path => importMrDistributionData(path, PUBLIC_DIRECTORY), signal: controller.signal,
      progress: confirmedBoundaryCount => { console.log(JSON.stringify({ confirmedBoundaryCount, requiredBoundaryCount: 25 })) } })
    console.log(JSON.stringify(report))
    if (report.status !== 'succeeded') process.exitCode = 2
  } finally { process.removeListener('SIGINT', interrupt) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof MrDistributionArgumentsError ? error.message : 'MR分布の取得を完了できませんでした。'); process.exitCode = 1 })
}
