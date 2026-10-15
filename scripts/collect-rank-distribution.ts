import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BrowserContextOptions } from 'playwright'
import { parseRankDistributionDataset } from '../src/lib/rankDistribution.ts'
import type { RankDistributionDataset } from '../src/types/rankDistribution.ts'
import { importRankDistributionData } from './import-rank-distribution-data.ts'
import { rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL } from './lib/rank-distribution-boundaries.ts'
import type { RankBoundaryPage } from './lib/rank-distribution-boundaries.ts'
import { collectRankDistributionDataset, RankDistributionCollectionError } from './lib/rank-distribution-collector.ts'
import { collectRankDistributionEstimate } from './lib/rank-distribution-estimate.ts'
import { createRankDistributionCheckpointStore, parseRankDistributionCheckpoint } from './lib/rank-distribution-checkpoint.ts'
import type { RankDistributionCheckpoint } from './lib/rank-distribution-checkpoint.ts'
import { createRankDistributionPageReader, RankDistributionDomError } from './lib/rank-distribution-dom.ts'
import type { RankDistributionDomErrorCode, RankDistributionPageReaderDiagnostics } from './lib/rank-distribution-dom.ts'
import { recordRankDistributionAvailability } from './lib/rank-distribution-status.ts'
import type { RankDistributionAvailabilityReason, RecordRankDistributionAvailabilityOptions } from './lib/rank-distribution-status.ts'
import { BUCKLER_SESSION_CAPTURE_PATH, createBucklerSessionStore, validateBucklerSessionState } from './lib/buckler-session-store.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = resolve(ROOT, '.local')
export const RANK_DISTRIBUTION_CAPTURE_DIRECTORY = resolve(LOCAL, 'rank-distribution')
const PUBLIC_DIRECTORY = resolve(ROOT, 'public/data/rank-distribution')
const TIMEOUT_MS = { estimate: 60 * 60_000, strict: 15 * 60_000 } as const
const SESSION_REFRESH_MS = 20 * 60_000
const HELP = `Bucklerのランク分布をこのPCで1回取得

node scripts/collect-rank-distribution.ts --collect
node scripts/collect-rank-distribution.ts --collect --resume
node scripts/collect-rank-distribution.ts --collect --max-requests 600
node scripts/collect-rank-distribution.ts --collect --strict

--collect          保存済みの認証を使い、全35境界を確認した全36区分の概数を保存・取り込み
--strict           総件数・再確認内容が一致する従来の厳密取得を指定
--resume           保存した探索位置をヒントに概数取得を再開（全境界は新しく確認）
--max-requests N   先頭・末尾の事前確認を含む読取回数の上限（2〜1000、既定600）
--help             この説明を表示

Windowsの同じユーザーで保存した固定DPAPIファイルを使い、新しいEdgeを開きます。
ログイン操作、認証チャレンジの操作、認証情報の再保存、クラウド送信、定期実行は行いません。
概数では取得期間中の総件数変動を記録します。未知ランクや一部境界だけの取得は登録しません。
一時的なタイムアウト・読取失敗・認証表示の未確認は、同じページを1回だけ新しく読み直します。
HTTP 5xxの一時エラーは5秒後に1回再読します。概数取得の通常のページ移動も5秒以上空けます。
概数取得では20分ごとに取得用Edgeを閉じ、同じ保存済み状態を新しいEdgeへ読み込み直します。
新しいEdgeの先頭ページでログイン状態と条件を確認できた場合だけ、同じ集計を続けます。
レポートのreadFailureCodeは最後に失敗した試行のコードで、再読による回復後も保持します。
結果: .local/rank-distribution/。中止: Ctrl+C。時間上限: 概数60分、厳密15分。`

export type RankDistributionCaptureAccuracy = 'estimate' | 'strict'
export interface RankDistributionCaptureOptions { mode: 'collect'; maxRequests: number; accuracy?: RankDistributionCaptureAccuracy; resume?: boolean }
export class RankDistributionCaptureArgumentsError extends Error {
  constructor() { super('--collect [--strict または --resume] [--max-requests 2〜1000] または --help を指定してください。'); this.name = 'RankDistributionCaptureArgumentsError' }
}

export function parseRankDistributionCaptureArguments(args: string[]): RankDistributionCaptureOptions | { mode: 'help' } {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' }
  if (args[0] !== '--collect') throw new RankDistributionCaptureArgumentsError()
  let accuracy: RankDistributionCaptureAccuracy = 'estimate'
  let maxRequests = 600
  let hasLimit = false
  let hasStrict = false
  let resume = false
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--strict' && !hasStrict) { accuracy = 'strict'; hasStrict = true }
    else if (args[index] === '--resume' && !resume) resume = true
    else if (args[index] === '--max-requests' && !hasLimit) {
      const value = args[++index]
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new RankDistributionCaptureArgumentsError()
      maxRequests = Number(value)
      if (!Number.isSafeInteger(maxRequests) || maxRequests < 2 || maxRequests > 1000) throw new RankDistributionCaptureArgumentsError()
      hasLimit = true
    } else throw new RankDistributionCaptureArgumentsError()
  }
  if (resume && accuracy === 'strict') throw new RankDistributionCaptureArgumentsError()
  return { mode: 'collect', maxRequests, accuracy, ...(resume ? { resume: true } : {}) }
}

type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>
export interface RankDistributionCaptureTransport {
  fetchPage(page: number, url: string): Promise<RankBoundaryPage>
  getDiagnostics(): RankDistributionPageReaderDiagnostics
  close(): Promise<void>
}
type CaptureStage = 'checkpoint-load' | 'checkpoint-save' | 'authentication' | 'browser-launch' | 'preflight' | 'collection' | 'dataset-save' | 'publication' | 'complete'
export interface RankDistributionCaptureReport {
  schemaVersion: 1
  startedAt: string
  endedAt: string
  status: 'succeeded' | 'failed'
  reason: RankDistributionAvailabilityReason | null
  stage: CaptureStage
  accuracy: RankDistributionCaptureAccuracy
  timeLimitMinutes: number
  authenticationStateLoaded: boolean
  manualLoginPerformed: false
  datasetSaved: boolean
  published: boolean
  availabilityUpdated: boolean
  browserClosed: boolean
  reportSaved: boolean
  maxRequests: number
  requestCount: number
  successfulReadCount: number
  totalCount: number | null
  pageSize: number | null
  lastPage: number | null
  rankMappingConfirmed: boolean
  leagueLabelsConfirmed: boolean
  displayedConditionsConfirmed: boolean
  userStatusEvidence: 'fixed-url-only'
  observedRankIds: number[]
  tailRankIds: number[]
  lastObservedTotal: number | null
  lastAttemptedPage: number | null
  lastHttpStatus: number | null
  lastAuthenticationEvidence: 'logout-control' | 'login-control' | 'conflicting-controls' | 'no-control' | null
  lastLoginRequiredHeading: boolean | null
  lastRankingReadable: boolean | null
  totalMin: number | null
  totalMax: number | null
  totalAtEnd: number | null
  confirmedBoundaryCount: number
  /** Last failed DOM attempt; retained when the one permitted fresh read subsequently succeeds. */
  readFailureCode: RankDistributionDomErrorCode | null
  /** Number of actual second attempts, not merely scheduled retries. */
  retryCount: number
  /** Preventive browser replacements whose new first page passed the complete display checks. */
  sessionRefreshCount: number
  resumeRequested: boolean
  checkpointLoaded: boolean
  checkpointSaved: boolean
  checkpointHintCount: number
}
export interface RankDistributionCaptureProgress {
  requestCount: number
  successfulReadCount: number
  page: number
  totalCount: number | null
  confirmedBoundaryCount?: number
  checkpointHintCount?: number
}
export interface RankDistributionCaptureDependencies {
  loadSession(): Promise<StorageState>
  launch(state: StorageState, signal: AbortSignal, accuracy?: RankDistributionCaptureAccuracy): Promise<RankDistributionCaptureTransport>
  saveDataset(dataset: RankDistributionDataset): Promise<string>
  publish(path: string): Promise<unknown>
  recordAvailability(options: Pick<RecordRankDistributionAvailabilityOptions, 'status' | 'reason' | 'checkedAt'>): Promise<unknown>
  writeReport(report: RankDistributionCaptureReport): Promise<void>
  now?: () => Date
  signal?: AbortSignal
  progress?: (value: RankDistributionCaptureProgress) => void
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** Monotonic elapsed milliseconds, separate from capture timestamps and the global deadline. */
  elapsedNow?: () => number
  loadCheckpoint?: () => Promise<RankDistributionCheckpoint | null>
  saveCheckpoint?: (checkpoint: RankDistributionCheckpoint) => Promise<RankDistributionCheckpoint>
}

class CaptureFailure extends Error {
  readonly reason: RankDistributionAvailabilityReason
  constructor(reason: RankDistributionAvailabilityReason) { super(reason); this.reason = reason }
}
function fail(reason: RankDistributionAvailabilityReason): never { throw new CaptureFailure(reason) }
function checkCancelled(signal: AbortSignal): void { if (signal.aborted) fail('cancelled') }
function timestamp(now: () => Date): string {
  try {
    const value = new Date(Date.prototype.getTime.call(now())).toISOString()
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) fail('configuration-invalid')
    return value
  } catch { return fail('configuration-invalid') }
}
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum
const knownRank = (value: unknown): value is number => integer(value, 1) && value <= 36

type CaptureDiagnostics = RankDistributionPageReaderDiagnostics & {
  lastObservedTotal: number | null; lastAttemptedPage: number | null; lastHttpStatus: number | null
  lastAuthenticationEvidence: 'logout-control' | 'login-control' | 'conflicting-controls' | 'no-control' | null
  lastLoginRequiredHeading: boolean | null; lastRankingReadable: boolean | null
}
function emptyDiagnostics(): CaptureDiagnostics {
  return { requestCount: 0, successfulReadCount: 0, totalCount: null, pageSize: null, lastPage: null,
    rankMappingConfirmed: false, leagueLabelsConfirmed: false, displayedConditionsConfirmed: false,
    userStatusEvidence: 'fixed-url-only', observedRankIds: [], tailRankIds: [], lastObservedTotal: null,
    lastAttemptedPage: null, lastHttpStatus: null, lastAuthenticationEvidence: null,
    lastLoginRequiredHeading: null, lastRankingReadable: null }
}
/** Copy a fixed scalar allowlist, never arbitrary transport objects or private row fields. */
function safeDiagnostics(transport?: RankDistributionCaptureTransport): CaptureDiagnostics {
  const result = emptyDiagnostics()
  try {
    const input = transport?.getDiagnostics()
    if (!input) return result
    for (const key of ['requestCount', 'successfulReadCount'] as const) if (integer(input[key])) result[key] = input[key]
    for (const key of ['totalCount', 'pageSize', 'lastPage'] as const) if (integer(input[key], 1)) result[key] = input[key]
    for (const key of ['lastObservedTotal', 'lastAttemptedPage'] as const) {
      if (key in input) {
        const value = (input as unknown as Record<string, unknown>)[key]
        if (integer(value, 1)) result[key] = value
      }
    }
    if ('lastHttpStatus' in input) {
      const status = (input as unknown as Record<string, unknown>).lastHttpStatus
      if (integer(status, 100) && status <= 599) result.lastHttpStatus = status
    }
    if (['logout-control', 'login-control', 'conflicting-controls', 'no-control'].includes(input.lastAuthenticationEvidence as string)) {
      result.lastAuthenticationEvidence = input.lastAuthenticationEvidence!
    }
    for (const key of ['lastLoginRequiredHeading', 'lastRankingReadable'] as const) {
      if (typeof input[key] === 'boolean') result[key] = input[key]
    }
    for (const key of ['rankMappingConfirmed', 'leagueLabelsConfirmed', 'displayedConditionsConfirmed'] as const) result[key] = input[key] === true
    for (const key of ['observedRankIds', 'tailRankIds'] as const) {
      if (Array.isArray(input[key])) result[key] = [...new Set(input[key].filter(knownRank))].sort((a, b) => a - b)
    }
  } catch { /* A failed diagnostic is not evidence, and raw transport errors are never reported. */ }
  return result
}

function domReason(code: RankDistributionDomErrorCode, loginRequiredHeading?: boolean | null): RankDistributionAvailabilityReason {
  switch (code) {
    case 'login-required': return loginRequiredHeading === false ? 'authentication-unconfirmed' : 'authentication-required'
    case 'authentication-unconfirmed': return 'authentication-unconfirmed'
    case 'http-denied': return 'access-denied'
    case 'maintenance': return 'maintenance'
    case 'unsupported-rank-icon': return 'unknown-rank'
    case 'condition-mismatch': case 'page-mismatch': case 'unsupported-dom': return 'source-changed'
    case 'total-count-changed': return 'observation-changed'
    case 'cancelled': return 'cancelled'
    case 'invalid-request': case 'concurrent-read': case 'first-page-required': return 'configuration-invalid'
    default: return 'read-failed'
  }
}
function failureReason(error: unknown, stage: CaptureStage, lastReadReason: RankDistributionAvailabilityReason | null): RankDistributionAvailabilityReason {
  if (error instanceof CaptureFailure) return error.reason
  if (stage === 'checkpoint-load' || stage === 'checkpoint-save') return 'checkpoint-unavailable'
  if (error instanceof RankDistributionDomError) return lastReadReason ?? domReason(error.code)
  if (error instanceof RankDistributionCollectionError) {
    if (error.code === 'page-read-failed' && lastReadReason) return lastReadReason
    switch (error.code) {
      case 'evidence-unconfirmed': case 'invalid-evidence': case 'evidence-source-mismatch': return 'evidence-unconfirmed'
      case 'invalid-options': case 'invalid-time': case 'invalid-rank-mapping': return 'configuration-invalid'
      case 'conditions-changed': case 'invalid-page': return 'source-changed'
      case 'unknown-rank': return 'unknown-rank'
      case 'total-changed': case 'observation-changed': return 'observation-changed'
      case 'request-limit': return 'request-limit'
      case 'cancelled': return 'cancelled'
      default: return 'read-failed'
    }
  }
  if (stage === 'authentication') return 'authentication-required'
  if (stage === 'dataset-save' || stage === 'publication') return 'publication-failed'
  return 'read-failed'
}

function checkPage(value: RankBoundaryPage, requestedPage: number): void {
  if (!value || value.page !== requestedPage || !integer(value.pageSize, 1) || value.pageSize > 20
    || !integer(value.totalCount, 1) || !integer(value.totalPages, 1)
    || value.totalPages !== Math.ceil(value.totalCount / value.pageSize) || requestedPage > value.totalPages
    || !Array.isArray(value.entries)
    || value.entries.length !== Math.min(value.pageSize, value.totalCount - (requestedPage - 1) * value.pageSize)) fail('source-changed')
  try {
    const url = new URL(value.sourceUrl)
    if (url.searchParams.getAll('page').length !== 1 || url.searchParams.get('page') !== String(requestedPage)
      || rankBoundaryPageUrl(value.sourceUrl, requestedPage) !== rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, requestedPage)) fail('source-changed')
  } catch { fail('source-changed') }
  if (value.entries.some(entry => !entry || !knownRank(entry.rankId))) fail('unknown-rank')
  if (value.entries.some(entry => !integer(entry.leaguePoint) || typeof entry.accountKey !== 'string'
    || !/^[a-f0-9]{64}$/.test(entry.accountKey))) fail('evidence-unconfirmed')
  for (let index = 1; index < value.entries.length; index++) {
    if (value.entries[index - 1].leaguePoint < value.entries[index].leaguePoint
      || value.entries[index - 1].rankId < value.entries[index].rankId) fail('observation-changed')
  }
}

/** All browser, auth and filesystem effects are injected for isolated synthetic tests. */
export async function runRankDistributionCollection(
  options: RankDistributionCaptureOptions, deps: RankDistributionCaptureDependencies,
): Promise<RankDistributionCaptureReport> {
  const now = deps.now ?? (() => new Date())
  const startedAt = timestamp(now)
  const accuracy: RankDistributionCaptureAccuracy = options.accuracy === 'strict' ? 'strict' : 'estimate'
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS[accuracy]), ...(deps.signal ? [deps.signal] : [])])
  let transport: RankDistributionCaptureTransport | undefined
  let closing: Promise<void> | undefined
  let stage: CaptureStage = 'authentication'
  let lastReadReason: RankDistributionAvailabilityReason | null = null
  let requestCount = 0
  let successfulReadCount = 0
  let sessionState: StorageState | undefined
  let browserStartedAt: number | null = null
  let checkpoint: RankDistributionCheckpoint | undefined
  const elapsedNow = deps.elapsedNow ?? (() => performance.now())
  const observedRankIds = new Set<number>()
  let confirmedTailRankIds: number[] = []
  const report: RankDistributionCaptureReport = {
    schemaVersion: 1, startedAt, endedAt: startedAt, status: 'failed', reason: null, stage, accuracy,
    timeLimitMinutes: TIMEOUT_MS[accuracy] / 60_000,
    authenticationStateLoaded: false, manualLoginPerformed: false, datasetSaved: false, published: false,
    availabilityUpdated: false, browserClosed: false, reportSaved: false,
    maxRequests: integer(options.maxRequests, 2) && options.maxRequests <= 1000 ? options.maxRequests : 0,
    totalMin: null, totalMax: null, totalAtEnd: null, confirmedBoundaryCount: 0,
    readFailureCode: null, retryCount: 0, sessionRefreshCount: 0,
    resumeRequested: options.resume === true, checkpointLoaded: false, checkpointSaved: false, checkpointHintCount: 0,
    ...emptyDiagnostics(),
  }
  const close = (): Promise<void> => {
    if (!transport) return Promise.resolve()
    const owned = transport
    closing ??= Promise.resolve().then(() => owned.close()).then(() => { report.browserClosed = true }).catch(() => { report.browserClosed = false })
    return closing
  }
  const abort = (): void => { void close() }
  const wait = deps.wait ?? (async (milliseconds: number, abortSignal: AbortSignal) => { await delay(milliseconds, undefined, { signal: abortSignal }) })
  const observeTotal = (value: unknown): void => {
    if (!integer(value, 1)) return
    report.totalMin = report.totalMin === null ? value : Math.min(report.totalMin, value)
    report.totalMax = report.totalMax === null ? value : Math.max(report.totalMax, value)
    report.totalAtEnd = value
  }
  const elapsed = (): number => {
    try { const value = elapsedNow(); if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('configuration-invalid'); return value }
    catch { return fail('configuration-invalid') }
  }
  const rememberDiagnostics = (): void => {
    const value = safeDiagnostics(transport)
    for (const rankId of value.observedRankIds) observedRankIds.add(rankId)
    if (value.tailRankIds.length) confirmedTailRankIds = value.tailRankIds
    observeTotal(value.lastObservedTotal)
  }
  const launch = async (): Promise<void> => {
    const next = await deps.launch(sessionState!, signal, accuracy)
    transport = next
    closing = undefined
    report.browserClosed = false
    browserStartedAt = accuracy === 'estimate' ? elapsed() : null
    checkCancelled(signal)
  }
  const readPageAttempts = async (page: number, url: string): Promise<RankBoundaryPage> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        checkCancelled(signal)
        if (requestCount >= options.maxRequests) fail('request-limit')
        if (attempt === 1) report.retryCount++
        requestCount++
        try {
          const result = await transport!.fetchPage(page, url)
          checkCancelled(signal)
          successfulReadCount++
          observeTotal(result?.totalCount)
          if (successfulReadCount % 10 === 0) {
            try { deps.progress?.({ requestCount, successfulReadCount, page, totalCount: integer(result?.totalCount, 1) ? result.totalCount : null,
              confirmedBoundaryCount: report.confirmedBoundaryCount, checkpointHintCount: report.checkpointHintCount }) } catch {}
          }
          return result
        } catch (error) {
          if (error instanceof RankDistributionDomError) report.readFailureCode = error.code
          checkCancelled(signal)
          if (attempt === 0 && error instanceof RankDistributionDomError
            && ['timeout', 'read-failed', 'authentication-unconfirmed', 'server-error'].includes(error.code)) {
            if (requestCount >= options.maxRequests) fail('request-limit')
            await wait(error.code === 'server-error' ? 5000 : 500, signal)
            checkCancelled(signal)
            continue
          }
          throw error
        }
      }
      return fail('read-failed')
  }
  const refreshIfDue = async (): Promise<void> => {
    if (accuracy !== 'estimate' || browserStartedAt === null) return
    const current = elapsed()
    if (current < browserStartedAt) fail('configuration-invalid')
    if (current - browserStartedAt < SESSION_REFRESH_MS) return
    checkCancelled(signal)
    if (requestCount >= options.maxRequests) fail('request-limit')
    const expectedPageSize = safeDiagnostics(transport).pageSize
    rememberDiagnostics()
    await close()
    // A failed close must not leave an old owned browser running beside a new one.
    if (!report.browserClosed) fail('read-failed')
    transport = undefined
    closing = undefined
    checkCancelled(signal)
    await launch()
    const fresh = await readPageAttempts(1, rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, 1))
    checkPage(fresh, 1)
    const diagnostics = transport!.getDiagnostics()
    if (expectedPageSize === null || fresh.pageSize !== expectedPageSize) fail('source-changed')
    if (diagnostics.rankMappingConfirmed !== true || diagnostics.leagueLabelsConfirmed !== true
      || diagnostics.displayedConditionsConfirmed !== true || diagnostics.userStatusEvidence !== 'fixed-url-only'
      || diagnostics.pageSize !== fresh.pageSize || diagnostics.totalCount !== fresh.totalCount || diagnostics.lastPage !== 1
      || diagnostics.lastObservedTotal !== undefined && diagnostics.lastObservedTotal !== fresh.totalCount) fail('evidence-unconfirmed')
    checkCancelled(signal)
    report.sessionRefreshCount++
    rememberDiagnostics()
  }
  const fetchPage = async (page: number, url: string): Promise<RankBoundaryPage> => {
    lastReadReason = null
    try {
      await refreshIfDue()
      // The refresh verification is extra; only this requested page is returned to the collector.
      return await readPageAttempts(page, url)
    } catch (error) {
      lastReadReason = error instanceof CaptureFailure ? error.reason
        : error instanceof RankDistributionDomError ? domReason(error.code, safeDiagnostics(transport).lastLoginRequiredHeading) : 'read-failed'
      throw error
    }
  }
  try {
    if (options.mode !== 'collect' || !integer(options.maxRequests, 2) || options.maxRequests > 1000
      || options.accuracy !== undefined && !['estimate', 'strict'].includes(options.accuracy)
      || options.resume !== undefined && typeof options.resume !== 'boolean'
      || options.resume && accuracy === 'strict') fail('configuration-invalid')
    checkCancelled(signal)
    if (options.resume) {
      stage = 'checkpoint-load'
      if (!deps.loadCheckpoint) fail('configuration-invalid')
      const loaded = await deps.loadCheckpoint()
      if (!loaded) fail('checkpoint-unavailable')
      checkpoint = parseRankDistributionCheckpoint(loaded)
      if (Date.parse(checkpoint.savedAt) > Date.parse(startedAt)) fail('checkpoint-unavailable')
      report.checkpointLoaded = true
      report.checkpointHintCount = checkpoint.hints.length
      checkCancelled(signal)
    }
    stage = 'authentication'
    sessionState = await deps.loadSession()
    checkCancelled(signal)
    report.authenticationStateLoaded = true
    stage = 'browser-launch'
    await launch()
    signal.addEventListener('abort', abort, { once: true })
    checkCancelled(signal)
    stage = 'preflight'
    const first = await fetchPage(1, rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, 1))
    checkPage(first, 1)
    if (checkpoint && checkpoint.pageSize !== first.pageSize) fail('checkpoint-unavailable')
    let requestedTail = first.totalPages
    let last: RankBoundaryPage | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await fetchPage(requestedTail, rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, requestedTail))
      if (last.pageSize !== first.pageSize || accuracy === 'strict'
        && (last.totalCount !== first.totalCount || last.totalPages !== first.totalPages)) fail('observation-changed')
      checkPage(last, requestedTail)
      if (last.page === last.totalPages) break
      if (accuracy === 'strict') fail('observation-changed')
      requestedTail = last.totalPages
    }
    if (!last || last.page !== last.totalPages) fail('observation-changed')
    const diagnostics = transport!.getDiagnostics()
    const tailIds = [...new Set(last.entries.map(entry => entry.rankId))].sort((a, b) => a - b)
    if (diagnostics.rankMappingConfirmed !== true || diagnostics.leagueLabelsConfirmed !== true || diagnostics.displayedConditionsConfirmed !== true
      || diagnostics.userStatusEvidence !== 'fixed-url-only' || diagnostics.pageSize !== first.pageSize
      || !integer(diagnostics.totalCount, 1) || diagnostics.lastPage !== last.page
      || (accuracy === 'strict' && diagnostics.totalCount !== first.totalCount)
      || (diagnostics.lastObservedTotal !== undefined && diagnostics.lastObservedTotal !== last.totalCount)
      || !Array.isArray(diagnostics.tailRankIds) || !diagnostics.tailRankIds.length
      || diagnostics.tailRankIds.some(rankId => !knownRank(rankId))
      || JSON.stringify([...diagnostics.tailRankIds].sort((a, b) => a - b)) !== JSON.stringify(tailIds)) fail('evidence-unconfirmed')
    if (first.totalPages > 1 && (first.entries.at(-1)!.leaguePoint < last.entries[0].leaguePoint
      || first.entries.at(-1)!.rankId < last.entries[0].rankId)) fail('observation-changed')
    if (requestCount >= options.maxRequests) fail('request-limit')
    stage = 'collection'
    let initialClock = true
    const collectionOptions = {
      fetchPage, maxRequests: options.maxRequests - requestCount, signal,
      onBoundary: (count: number) => { if (integer(count) && count <= 35) report.confirmedBoundaryCount = Math.max(report.confirmedBoundaryCount, count) },
      now: () => { if (initialClock) { initialClock = false; return new Date(startedAt) }; return new Date(timestamp(now)) },
      currentMappingEvidence: { status: 'confirmed' as const, sourceUrl: RANK_BOUNDARY_SOURCE_URL,
        note: '現行のリーグ選択肢の1〜36の表示名と、各掲載行で読み込まれた公式ランク画像のIDを独立に確認した。LPからランクIDや閾値を逆算していない。' },
      maxLpAccountUnitEvidence: { status: 'confirmed' as const, sourceUrl: RANK_BOUNDARY_SOURCE_URL,
        note: '公式の総合・最大LP条件で、プロフィールへのリンクを持つ掲載行を確認した。既存出典の定義に従い最大LPのファイターアカウントを単位とする。未観測の全件の個別一意性や実人数を証明しない。user_status=1は固定URLの一致を確認する。独立した画面の選択表示との対応は未確認なので、全ユーザーを意味するとは断定しない。' },
      unrankedTailEvidence: { status: 'confirmed' as const, sourceUrl: rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, last.page),
        note: '表示範囲と総件数が整合する最終ページの全行について、読み込まれた公式ランク画像が既知のID1〜36であることを確認した。未ランク・不明画像をROOKIEまたは0件に補完していない。' },
    }
    const dataset = accuracy === 'estimate'
      ? await collectRankDistributionEstimate({ ...collectionOptions, checkpoint,
        onCheckpoint: deps.saveCheckpoint ? async value => {
          checkCancelled(signal)
          stage = 'checkpoint-save'
          const saved = parseRankDistributionCheckpoint(await deps.saveCheckpoint!(value))
          if (saved.pageSize !== value.pageSize || saved.hints.length < value.hints.length) fail('checkpoint-unavailable')
          report.checkpointSaved = true
          report.checkpointHintCount = saved.hints.length
          checkCancelled(signal)
          stage = 'collection'
        } : undefined,
      })
      : await collectRankDistributionDataset({ ...collectionOptions, mode: 'rank-id' })
    checkCancelled(signal)
    const validated = parseRankDistributionDataset(dataset)
    if (validated.method === 'boundary-search-estimate') {
      const observation = validated.observation!
      observation.totalAtStart = first.totalCount
      observation.minTotal = Math.min(observation.minTotal, report.totalMin ?? first.totalCount, first.totalCount)
      observation.maxTotal = Math.max(observation.maxTotal, report.totalMax ?? first.totalCount, first.totalCount)
      validated.validation.notes.push('captureStartedAtとobservationの開始総件数・総件数範囲は、先頭・末尾の事前確認を含む取得期間全体の観測を表す。各境界の件数・総件数・日時は、境界探索時の新しい読取の記録である。終了総件数は境界探索の最終確認値を使う。')
      report.totalAtEnd = observation.totalAtEnd
      report.confirmedBoundaryCount = observation.boundaries.length
    } else report.confirmedBoundaryCount = 35
    stage = 'dataset-save'
    const path = await deps.saveDataset(parseRankDistributionDataset(validated))
    report.datasetSaved = true
    checkCancelled(signal)
    stage = 'publication'
    await deps.publish(path)
    report.published = true
    stage = 'complete'
    report.status = 'succeeded'
  } catch (error) {
    report.reason = signal.aborted ? 'cancelled' : failureReason(error, stage, lastReadReason)
  } finally {
    signal.removeEventListener('abort', abort)
    await close()
    sessionState = undefined
  }
  const diagnostics = safeDiagnostics(transport)
  rememberDiagnostics()
  diagnostics.observedRankIds = [...observedRankIds].sort((a, b) => a - b)
  if (!diagnostics.tailRankIds.length) diagnostics.tailRankIds = confirmedTailRankIds
  observeTotal(diagnostics.lastObservedTotal)
  report.stage = stage
  report.requestCount = requestCount
  report.successfulReadCount = successfulReadCount
  for (const key of ['pageSize', 'totalCount', 'lastPage', 'rankMappingConfirmed', 'leagueLabelsConfirmed', 'displayedConditionsConfirmed', 'observedRankIds', 'tailRankIds', 'lastObservedTotal', 'lastAttemptedPage', 'lastHttpStatus', 'lastAuthenticationEvidence', 'lastLoginRequiredHeading', 'lastRankingReadable'] as const) {
    Object.assign(report, { [key]: diagnostics[key] })
  }
  try { report.endedAt = timestamp(now) } catch { report.endedAt = startedAt }
  if (Date.parse(report.endedAt) < Date.parse(startedAt)) report.endedAt = startedAt
  if (report.status === 'failed') {
    report.reason ??= 'read-failed'
    try {
      await deps.recordAvailability({ status: report.reason === 'evidence-unconfirmed' ? 'verification-pending' : 'collection-failed',
        reason: report.reason, checkedAt: report.endedAt })
      report.availabilityUpdated = true
    } catch { /* Retain verified history even if its status cannot be updated. */ }
  }
  try { await deps.writeReport({ ...report, reportSaved: true }); report.reportSaved = true } catch {}
  return report
}

export interface RankDistributionPrivateFileInfo { directory: boolean; file: boolean; symbolicLink: boolean }
export interface RankDistributionPrivateWriterIo {
  inspect(path: string): Promise<RankDistributionPrivateFileInfo | null>
  mkdir(path: string): Promise<void>
  write(path: string, text: string, options: { flag: 'wx'; mode: number }): Promise<void>
}
const privateWriterIo: RankDistributionPrivateWriterIo = {
  async inspect(path) {
    try { const value = await lstat(path); return { directory: value.isDirectory(), file: value.isFile(), symbolicLink: value.isSymbolicLink() } }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error }
  },
  async mkdir(path) { await mkdir(path, { mode: 0o700 }) },
  async write(path, text, options) {
    const handle = await open(path, options.flag, options.mode)
    try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
  },
}

/** Fixed local directory and exclusive creation; tests inject virtual IO, never alternate output paths. */
export function createRankDistributionPrivateWriter(io: RankDistributionPrivateWriterIo = privateWriterIo) {
  async function parents(path: string): Promise<void> {
    for (let current = path; ; current = dirname(current)) {
      const value = await io.inspect(current)
      if (!value || value.symbolicLink || !value.directory) fail('publication-failed')
      if (current === dirname(current)) return
    }
  }
  return async (name: string, value: unknown): Promise<string> => {
    try {
      if (!/^(?:max-lp(?:-estimate)?|capture)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/.test(name)) fail('publication-failed')
      await parents(ROOT)
      for (const directory of [LOCAL, RANK_DISTRIBUTION_CAPTURE_DIRECTORY]) {
        await parents(dirname(directory))
        const info = await io.inspect(directory)
        if (!info) await io.mkdir(directory)
        else if (info.symbolicLink || !info.directory) fail('publication-failed')
      }
      await parents(RANK_DISTRIBUTION_CAPTURE_DIRECTORY)
      const path = resolve(RANK_DISTRIBUTION_CAPTURE_DIRECTORY, name)
      if (await io.inspect(path)) fail('publication-failed')
      const text = `${JSON.stringify(value, null, 2)}\n`
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) fail('publication-failed')
      await io.write(path, text, { flag: 'wx', mode: 0o600 })
      return path
    } catch { return fail('publication-failed') }
  }
}

/** Remove diagnostics before loading Playwright or starting child processes. */
export function disableRankDistributionDiagnostics(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (/^(?:DEBUG(?:_|$)|PWDEBUG$|NODE_DEBUG(?:_|$)|NODE_OPTIONS$|PW_(?:LOG|TRACE|VIDEO|SCREENSHOT)|PLAYWRIGHT_(?:DEBUG|TRACE|LOG))/i.test(key)) delete env[key]
  }
}

async function loadFixedSession(): Promise<StorageState> {
  disableRankDistributionDiagnostics(process.env)
  const store = createBucklerSessionStore()
  const { parseCaptureRecord } = await import('./probe-buckler-session.ts')
  await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
  const info = await lstat(BUCKLER_SESSION_CAPTURE_PATH)
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 1024) fail('authentication-required')
  const bytes = await readFile(BUCKLER_SESSION_CAPTURE_PATH)
  if (bytes.length !== info.size || bytes.length > 1024) fail('authentication-required')
  const capture = parseCaptureRecord(JSON.parse(bytes.toString('utf8')))
  if (await store.identity() !== capture.stateIdentity) fail('authentication-required')
  const state = validateBucklerSessionState(await store.load())
  if (await store.identity() !== capture.stateIdentity) fail('authentication-required')
  await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
  return JSON.parse(state) as StorageState
}

async function launchFixedEdge(state: StorageState, signal: AbortSignal, accuracy: RankDistributionCaptureAccuracy = 'estimate'): Promise<RankDistributionCaptureTransport> {
  disableRankDistributionDiagnostics(process.env)
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ channel: 'msedge', headless: false, timeout: 30_000, env: { ...process.env } })
  try {
    checkCancelled(signal)
    const context = await browser.newContext({ locale: 'ja-JP', acceptDownloads: false, storageState: state })
    const page = await context.newPage()
    const reader = createRankDistributionPageReader(page, { signal, minIntervalMs: accuracy === 'estimate' ? 5000 : 500,
      totalCountPolicy: accuracy === 'estimate' ? 'record' : 'stable' })
    return { ...reader, close: async () => { await browser.close() } }
  } catch (error) { await browser.close().catch(() => {}); throw error }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseRankDistributionCaptureArguments(args)
  if (options.mode === 'help') { console.log(HELP); return }
  disableRankDistributionDiagnostics(process.env)
  const writer = createRankDistributionPrivateWriter()
  const checkpointStore = createRankDistributionCheckpointStore()
  const interrupted = new AbortController()
  const interrupt = (): void => { interrupted.abort() }
  process.once('SIGINT', interrupt)
  try {
    const report = await runRankDistributionCollection(options, {
      loadSession: loadFixedSession, launch: launchFixedEdge, signal: interrupted.signal,
      loadCheckpoint: () => checkpointStore.load(), saveCheckpoint: value => checkpointStore.save(value),
      saveDataset: async dataset => writer(`${dataset.id}.json`, parseRankDistributionDataset(dataset)),
      publish: async path => importRankDistributionData(path, PUBLIC_DIRECTORY),
      recordAvailability: recordRankDistributionAvailability,
      writeReport: async report => { await writer(`capture-${report.startedAt.replace(/[:.]/g, '-')}.json`, report) },
      progress: value => { console.log(JSON.stringify(value)) },
    })
    console.log(JSON.stringify(report))
    if (report.status !== 'succeeded') process.exitCode = 2
  } finally { process.removeListener('SIGINT', interrupt) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof RankDistributionCaptureArgumentsError ? error.message : 'ランク分布の取得を完了できませんでした。認証情報や生のエラーは表示しません。')
    process.exitCode = 1
  })
}
