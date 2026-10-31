import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BrowserContextOptions } from 'playwright'
import { LEGEND_ANALYSIS_SOURCE, parseLegendAnalysisDataset, parseLegendAnalysisManifest } from '../src/lib/legendAnalysis.ts'
import { createLegendPlayersDescriptor, parseLegendPlayersDataset, parseLegendPlayersManifest } from '../src/lib/legendPlayers.ts'
import type { LegendPlayersDataset, LegendRankedMatchScope } from '../src/types/legendPlayers.ts'
import { collectLegendAnalysisDataset, LEGEND_ANALYSIS_COLLECTION_ERROR_CODES, LEGEND_ANALYSIS_COLLECTION_PHASES,
  LEGEND_ANALYSIS_COLLECTION_VALIDATION_CHECKS, LEGEND_ANALYSIS_RECHECK_CHANGE_KINDS, LegendAnalysisCollectionError } from './lib/legend-analysis-collector.ts'
import type { LegendAnalysisCollectionErrorCode, LegendAnalysisCollectionPhase, LegendAnalysisPage,
  LegendAnalysisRecheckChangeKind, LegendAnalysisValidationCheck, LegendAnalysisVerifiedPlayer, LegendAnalysisAttemptFailure } from './lib/legend-analysis-collector.ts'
import { createLegendAnalysisPageReader, LEGEND_ANALYSIS_CONDITIONS, legendAnalysisPageUrl, LegendAnalysisDomError, sanitizeLegendRosterDiagnostics } from './lib/legend-analysis-dom.ts'
import type { LegendAnalysisDomErrorCode, LegendAnalysisReaderStep, LegendClickFailure, LegendClickHit, LegendClickObservation, LegendRosterDiagnostics } from './lib/legend-analysis-dom.ts'
import { checkLegendAnalysisParents, LEGEND_ANALYSIS_JSON_LIMIT, legendAnalysisFileInfo } from './lib/legend-analysis-files.ts'
import { BUCKLER_SESSION_CAPTURE_PATH, createBucklerSessionStore, validateBucklerSessionState } from './lib/buckler-session-store.ts'
import { disableRankDistributionDiagnostics } from './collect-rank-distribution.ts'
import { rankDistributionCloudBrowserEnvironment } from './collect-rank-distribution-cloud.ts'
import { normalizeDistributionHumanVerification } from './lib/distribution-human-verification.ts'
import type { DistributionHumanVerificationDiagnostics } from './lib/distribution-human-verification.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LEGEND_ANALYSIS_LOCAL_OUTPUT = resolve(ROOT, '.local/legend-analysis-daily/captures')
export type LegendAnalysisStorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>
export interface LegendAnalysisTransport {
  initialize(): Promise<{ act: { id: string; label: string }; characterIds: string[]; characterNames: Record<string, string> }>
  fetchPage(page: number, url: string): Promise<LegendAnalysisPage>
  confirmAct(): Promise<void>
  fetchPlayerRankedMatches?(playerId: string, characterIds: readonly string[]): Promise<Record<string, number>>
  getDiagnostics(): { requestCount: number; lastStep?: LegendAnalysisReaderStep; lastErrorCode?: LegendAnalysisDomErrorCode | null;
    characterFilter?: '1' | '2' | '3' | '4' | null; visibleRosterButtonCount?: number | null;
    clickFailure?: LegendClickFailure | null; clickHitKind?: LegendClickHit | null; clickHitTag?: LegendClickObservation['hitTag'];
    parentParagraph?: boolean; pointerEventsNone?: boolean; rosterDiagnostics?: LegendRosterDiagnostics | null;
    lastLoginRequired?: boolean | null; lastSignedIn?: boolean | null; lastRankingReadable?: boolean | null; readableWithoutSignInReadCount?: number; lastHttpStatus?: number | null;
    humanVerification?: DistributionHumanVerificationDiagnostics; profileRetryCount?: number;
    lastAttemptedPage: number | null; successfulReadCount: number }
  close(): Promise<void>
}
export type LegendAnalysisFailureReason = 'authentication-unavailable' | 'source-unconfirmed' | 'source-changed'
  | 'access-unavailable' | 'cancelled' | 'request-limit' | 'collection-failed' | 'output-unavailable'
export interface LegendAnalysisCaptureReport {
  status: 'succeeded' | 'failed'
  reason: LegendAnalysisFailureReason | null
  startedAt: string
  endedAt: string
  requestCount: number
  retryCount: number
  lastAttemptedPage: number | null
  /** Accepted ranking pages, including preparation and rechecks, excluding PLAY Act pages. */
  successfulReadCount: number
  profileTotalCount?: number
  profileReadCount?: number
  profileRetryCount?: number
  /** One-based whole-capture attempt; null until normal collection starts. */
  captureAttempt: number | null
  collectionPhase: LegendAnalysisCollectionPhase
  datasetId: string | null
  browserClosed: boolean
  lastStep?: LegendAnalysisReaderStep | null
  domErrorCode?: LegendAnalysisDomErrorCode | null
  characterFilter?: '1' | '2' | '3' | '4' | null
  visibleRosterButtonCount?: number | null
  clickFailure?: LegendClickFailure | null
  clickHitKind?: LegendClickHit | null
  clickHitTag?: LegendClickObservation['hitTag']
  parentParagraph?: boolean
  pointerEventsNone?: boolean
  rosterDiagnostics?: LegendRosterDiagnostics | null
  lastLoginRequired?: boolean | null
  lastSignedIn?: boolean | null
  lastRankingReadable?: boolean | null
  readableWithoutSignInReadCount?: number
  lastHttpStatus?: number | null
  collectionErrorCode?: LegendAnalysisCollectionErrorCode | null
  validationCheck?: LegendAnalysisValidationCheck | null
  recheckChangeKinds?: LegendAnalysisRecheckChangeKind[] | null
  attemptFailures?: LegendAnalysisAttemptFailure[]
  humanVerification?: DistributionHumanVerificationDiagnostics
}
export interface LegendAnalysisSafeCaptureReport {
  status: 'succeeded' | 'failed'
  reason: LegendAnalysisFailureReason | null
  startedAt: string | null
  endedAt: string | null
  requestCount: number
  successfulReadCount: number
  profileTotalCount: number
  profileReadCount: number
  profileRetryCount: number
  retryCount: number
  captureAttempt: number | null
  collectionPhase: LegendAnalysisCollectionPhase
  lastAttemptedPage: number | null
  datasetId: string | null
  browserClosed: boolean
  lastStep: LegendAnalysisReaderStep | null
  domErrorCode: LegendAnalysisDomErrorCode | null
  lastHttpStatus: number | null
  lastLoginRequired: boolean | null
  lastSignedIn: boolean | null
  lastRankingReadable: boolean | null
  readableWithoutSignInReadCount: number
  collectionErrorCode: LegendAnalysisCollectionErrorCode | null
  validationCheck: LegendAnalysisValidationCheck | null
  recheckChangeKinds: LegendAnalysisRecheckChangeKind[] | null
  attemptFailures: LegendAnalysisAttemptFailure[]
  humanVerification: DistributionHumanVerificationDiagnostics
}
/** Bounded enum/scalar-only history; no error text, player values or URLs can cross this boundary. */
function safeAttemptFailures(value: unknown): LegendAnalysisAttemptFailure[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 3).flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const item = candidate as Record<string, unknown>
    if (!Number.isSafeInteger(item.attempt) || Number(item.attempt) < 1 || Number(item.attempt) > 3
      || !LEGEND_ANALYSIS_COLLECTION_PHASES.includes(item.phase as LegendAnalysisCollectionPhase)
      || !LEGEND_ANALYSIS_COLLECTION_ERROR_CODES.includes(item.code as LegendAnalysisCollectionErrorCode)) return []
    return [{ attempt: item.attempt as number, phase: item.phase as LegendAnalysisCollectionPhase,
      page: Number.isSafeInteger(item.page) && Number(item.page) >= 1 && Number(item.page) <= 1000000 ? item.page as number : null,
      code: item.code as LegendAnalysisCollectionErrorCode,
      validationCheck: LEGEND_ANALYSIS_COLLECTION_VALIDATION_CHECKS.includes(item.validationCheck as LegendAnalysisValidationCheck) ? item.validationCheck as LegendAnalysisValidationCheck : 'unclassified',
      recheckChangeKinds: Array.isArray(item.recheckChangeKinds) && item.recheckChangeKinds.length >= 1 && item.recheckChangeKinds.length <= 3
        && new Set(item.recheckChangeKinds).size === item.recheckChangeKinds.length
        && item.recheckChangeKinds.every(kind => LEGEND_ANALYSIS_RECHECK_CHANGE_KINDS.includes(kind as LegendAnalysisRecheckChangeKind))
        ? [...item.recheckChangeKinds] as LegendAnalysisRecheckChangeKind[] : null }]
  })
}
/** A second bounded enum/scalar-only boundary for stdout; never log an arbitrary collector result. */
export function summarizeLegendAnalysisCaptureReport(value: unknown): LegendAnalysisSafeCaptureReport {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const bounded = (candidate: unknown, min: number, max: number): candidate is number => Number.isSafeInteger(candidate) && (candidate as number) >= min && (candidate as number) <= max
  const time = (candidate: unknown): string | null => {
    if (typeof candidate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)) return null
    try { return new Date(candidate).toISOString() === candidate ? candidate : null } catch { return null }
  }
  const requestCount = bounded(input.requestCount, 0, 2000) ? input.requestCount : 0
  const successfulReadCount = bounded(input.successfulReadCount, 0, requestCount) ? input.successfulReadCount : 0
  const recheckChangeKinds = Array.isArray(input.recheckChangeKinds) && input.recheckChangeKinds.length >= 1 && input.recheckChangeKinds.length <= 3
    && new Set(input.recheckChangeKinds).size === input.recheckChangeKinds.length
    && input.recheckChangeKinds.every(kind => LEGEND_ANALYSIS_RECHECK_CHANGE_KINDS.includes(kind as LegendAnalysisRecheckChangeKind))
    ? input.recheckChangeKinds as LegendAnalysisRecheckChangeKind[] : null
  return {
    status: input.status === 'succeeded' ? 'succeeded' : 'failed',
    reason: ['authentication-unavailable', 'source-unconfirmed', 'source-changed', 'access-unavailable', 'cancelled', 'request-limit', 'collection-failed', 'output-unavailable'].includes(input.reason as string) ? input.reason as LegendAnalysisFailureReason : null,
    startedAt: time(input.startedAt), endedAt: time(input.endedAt), requestCount, successfulReadCount,
    profileTotalCount: bounded(input.profileTotalCount, 0, 1000) ? input.profileTotalCount : 0,
    profileReadCount: bounded(input.profileReadCount, 0, Number(input.profileTotalCount) || 0) && input.profileReadCount <= 1000 ? input.profileReadCount : 0,
    profileRetryCount: bounded(input.profileRetryCount, 0, 1000) ? input.profileRetryCount : 0,
    retryCount: bounded(input.retryCount, 0, 2) ? input.retryCount : 0,
    captureAttempt: bounded(input.captureAttempt, 1, 3) ? input.captureAttempt : null,
    collectionPhase: LEGEND_ANALYSIS_COLLECTION_PHASES.includes(input.collectionPhase as LegendAnalysisCollectionPhase) ? input.collectionPhase as LegendAnalysisCollectionPhase : 'preparation',
    lastAttemptedPage: bounded(input.lastAttemptedPage, 1, 1000000) ? input.lastAttemptedPage : null,
    datasetId: typeof input.datasetId === 'string' && /^legend-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(input.datasetId) ? input.datasetId : null,
    browserClosed: input.browserClosed === true,
    lastStep: ['idle', 'ranking-navigation', 'ranking-observation', 'act-navigation', 'act-observation', 'roster-condition', 'roster-open', 'roster-observation', 'profile-navigation', 'profile-filter', 'profile-observation', 'complete'].includes(input.lastStep as string) ? input.lastStep as LegendAnalysisReaderStep : null,
    domErrorCode: ['invalid-request', 'request-limit', 'cancelled', 'concurrent-read', 'http-denied', 'http-error', 'server-error', 'maintenance', 'authentication-required', 'unsupported-dom', 'condition-mismatch', 'act-unconfirmed', 'act-changed', 'read-failed'].includes(input.domErrorCode as string) ? input.domErrorCode as LegendAnalysisDomErrorCode : null,
    lastHttpStatus: bounded(input.lastHttpStatus, 100, 599) ? input.lastHttpStatus : null,
    lastLoginRequired: typeof input.lastLoginRequired === 'boolean' ? input.lastLoginRequired : null,
    lastSignedIn: typeof input.lastSignedIn === 'boolean' ? input.lastSignedIn : null,
    lastRankingReadable: typeof input.lastRankingReadable === 'boolean' ? input.lastRankingReadable : null,
    readableWithoutSignInReadCount: bounded(input.readableWithoutSignInReadCount, 0, successfulReadCount) ? input.readableWithoutSignInReadCount : 0,
    collectionErrorCode: LEGEND_ANALYSIS_COLLECTION_ERROR_CODES.includes(input.collectionErrorCode as LegendAnalysisCollectionErrorCode) ? input.collectionErrorCode as LegendAnalysisCollectionErrorCode : null,
    validationCheck: LEGEND_ANALYSIS_COLLECTION_VALIDATION_CHECKS.includes(input.validationCheck as LegendAnalysisValidationCheck) ? input.validationCheck as LegendAnalysisValidationCheck : null,
    recheckChangeKinds,
    attemptFailures: safeAttemptFailures(input.attemptFailures),
    humanVerification: normalizeDistributionHumanVerification(input.humanVerification),
  }
}
export interface LegendAnalysisRunOptions {
  storageState: LegendAnalysisStorageState
  /** Fresh staging root. Player list sidecars are written only when includePlayers is explicitly true. */
  outputDirectory: string
  includePlayers?: boolean
  browserEnvironment?: Record<string, string>
  signal?: AbortSignal
}
export interface LegendAnalysisRunDependencies {
  launch?: (state: LegendAnalysisStorageState, signal: AbortSignal, env: Record<string, string>, includePlayers?: boolean) => Promise<LegendAnalysisTransport>
  now?: () => Date
}
async function launch(state: LegendAnalysisStorageState, signal: AbortSignal, env: Record<string, string>, includePlayers = false): Promise<LegendAnalysisTransport> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ channel: 'msedge', headless: false, timeout: 30000, env })
  try {
    signal.throwIfAborted()
    const context = await browser.newContext({ locale: 'ja-JP', acceptDownloads: false, storageState: state })
    const reader = createLegendAnalysisPageReader(await context.newPage(), { signal, minIntervalMs: 5000, includePlayers, maxRequests: includePlayers ? 2000 : 150 })
    return { ...reader, close: () => browser.close() }
  } catch { await browser.close().catch(() => {}); throw new Error('browser-unavailable') }
}
function reason(error: unknown, signal: AbortSignal): LegendAnalysisFailureReason {
  if (signal.aborted) return 'cancelled'
  if (error instanceof LegendAnalysisCollectionError) {
    if (error.code === 'request-limit') return 'request-limit'
    if (['source-changed', 'duplicate-entry'].includes(error.code)) return 'source-changed'
    if (error.code === 'evidence-unconfirmed') return 'source-unconfirmed'
  }
  if (error instanceof LegendAnalysisDomError) {
    if (error.code === 'request-limit') return 'request-limit'
    if (error.code === 'authentication-required') return 'authentication-unavailable'
    if (['act-unconfirmed', 'unsupported-dom', 'condition-mismatch'].includes(error.code)) return 'source-unconfirmed'
    if (error.code === 'act-changed') return 'source-changed'
    if (['http-denied', 'http-error', 'server-error', 'maintenance'].includes(error.code)) return 'access-unavailable'
  }
  return 'collection-failed'
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await checkLegendAnalysisParents(dirname(path))
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > LEGEND_ANALYSIS_JSON_LIMIT) throw new Error('output-unavailable')
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
}

/** Session state remains in memory; arbitrary browser errors and raw DOM never enter returned reports. */
export async function runLegendAnalysisCollection(options: LegendAnalysisRunOptions, dependencies: LegendAnalysisRunDependencies = {}): Promise<{ succeeded: boolean; report: LegendAnalysisCaptureReport }> {
  disableRankDistributionDiagnostics(process.env)
  const now = dependencies.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const report: LegendAnalysisCaptureReport = { status: 'failed', reason: null, startedAt, endedAt: startedAt,
    requestCount: 0, retryCount: 0, datasetId: null, browserClosed: false, lastStep: null, domErrorCode: null,
    characterFilter: null, visibleRosterButtonCount: null, lastAttemptedPage: null, successfulReadCount: 0,
    captureAttempt: null, collectionPhase: 'preparation', collectionErrorCode: null, validationCheck: null, recheckChangeKinds: null,
    attemptFailures: [], humanVerification: normalizeDistributionHumanVerification(null) }
  const deadline = AbortSignal.timeout((options.includePlayers ? 120 : 15) * 60 * 1000)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const output = resolve(options.outputDirectory), publicDirectory = resolve(output, 'public')
  await checkLegendAnalysisParents(output)
  if (await legendAnalysisFileInfo(output)) throw new Error('レジェンド分析の出力先が既に存在します。新しい出力先が必要です。')
  await mkdir(output, { recursive: true, mode: 0o700 })
  await mkdir(publicDirectory, { mode: 0o700 })
  let transport: LegendAnalysisTransport | undefined
  let dataset: ReturnType<typeof parseLegendAnalysisDataset> | null = null
  const playerCapture: { rows: readonly LegendAnalysisVerifiedPlayer[] | null } = { rows: null }
  let enrichedPlayers: (LegendAnalysisVerifiedPlayer & { rankedMatchCount: number })[] | null = null
  let rankedMatchScope: LegendRankedMatchScope | null = null
  try {
    signal.throwIfAborted()
    let state: LegendAnalysisStorageState
    try { state = JSON.parse(validateBucklerSessionState(JSON.stringify(options.storageState))) as LegendAnalysisStorageState }
    catch { report.reason = 'authentication-unavailable'; throw new Error() }
    transport = await (dependencies.launch ?? launch)(state, signal,
      rankDistributionCloudBrowserEnvironment(options.browserEnvironment ?? process.env), options.includePlayers === true)
    const initial = await transport.initialize()
    const collected = await collectLegendAnalysisDataset({ sourceUrl: LEGEND_ANALYSIS_SOURCE.url, pageUrl: legendAnalysisPageUrl,
      fetchPage: (page, url) => transport!.fetchPage(page, url), confirmAct: () => transport!.confirmAct(), act: initial.act,
      conditions: LEGEND_ANALYSIS_CONDITIONS, characterIds: initial.characterIds, characterNames: initial.characterNames,
      membershipRule: 'official-legend-badge', membershipConfirmed: true, signal, now, maxRequests: 120, maxAttempts: 2,
      ...(options.includePlayers ? { onVerifiedPlayers: (players: readonly LegendAnalysisVerifiedPlayer[]) => { playerCapture.rows = players } } : {}),
      onRetry: count => { if (Number.isSafeInteger(count) && count >= 1 && count <= 2) report.retryCount = count },
      onAttemptFailure: failure => { report.attemptFailures = safeAttemptFailures([...(report.attemptFailures ?? []), failure]) },
      onProgress: value => {
        if (LEGEND_ANALYSIS_COLLECTION_PHASES.includes(value.phase)) report.collectionPhase = value.phase
        if (Number.isSafeInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 3) report.captureAttempt = value.attempt
      } })
    dataset = collected.dataset; report.retryCount = collected.retryCount
    signal.throwIfAborted()
    if (options.includePlayers) {
      if (!playerCapture.rows || !transport.fetchPlayerRankedMatches) throw new LegendAnalysisCollectionError('evidence-unconfirmed', 'entry-values')
      const profiles = new Map<string, Set<string>>()
      for (const row of playerCapture.rows) {
        if (!profiles.has(row.playerId)) profiles.set(row.playerId, new Set())
        profiles.get(row.playerId)!.add(row.characterId)
      }
      if (profiles.size > 1000) throw new LegendAnalysisCollectionError('request-limit', 'request-budget')
      report.profileTotalCount = profiles.size; report.profileReadCount = 0
      const collectionStartedAt = now().toISOString(), counts = new Map<string, Record<string, number>>()
      for (const [playerId, characters] of profiles) {
        signal.throwIfAborted()
        const value = await transport.fetchPlayerRankedMatches(playerId, [...characters])
        const verifiedCounts: Record<string, number> = Object.create(null)
        for (const characterId of characters) {
          const count = value?.[characterId]
          if (!Object.hasOwn(value ?? {}, characterId) || !Number.isSafeInteger(count) || count < 0) {
            throw new LegendAnalysisCollectionError('evidence-unconfirmed', 'entry-values')
          }
          verifiedCounts[characterId] = count
        }
        counts.set(playerId, verifiedCounts); report.profileReadCount++
      }
      rankedMatchScope = { actId: initial.act.id, mode: 'ranked', collectionStartedAt, collectionEndedAt: now().toISOString() }
      enrichedPlayers = playerCapture.rows.map(row => ({ ...row, rankedMatchCount: counts.get(row.playerId)![row.characterId] }))
      // Profile collection can span an Act boundary even after ranking validation completed.
      await transport.confirmAct()
      signal.throwIfAborted()
    }
  } catch (error) {
    report.reason ??= reason(error, signal); dataset = null
    if (error instanceof LegendAnalysisCollectionError) {
      report.collectionErrorCode = error.code; report.validationCheck = error.validationCheck
      report.recheckChangeKinds = error.recheckChangeKinds ? [...error.recheckChangeKinds] : null
    }
  }
  finally {
    if (transport) {
      try {
        const diagnostics = transport.getDiagnostics(), count = diagnostics.requestCount
        if (Number.isSafeInteger(count) && count >= 0 && count <= 2000) report.requestCount = count
        if (Number.isSafeInteger(diagnostics.lastAttemptedPage) && diagnostics.lastAttemptedPage! >= 1 && diagnostics.lastAttemptedPage! <= 1000000) report.lastAttemptedPage = diagnostics.lastAttemptedPage
        if (Number.isSafeInteger(diagnostics.successfulReadCount) && diagnostics.successfulReadCount >= 0 && diagnostics.successfulReadCount <= report.requestCount) report.successfulReadCount = diagnostics.successfulReadCount
        if (['idle', 'ranking-navigation', 'ranking-observation', 'act-navigation', 'act-observation', 'roster-condition', 'roster-open', 'roster-observation', 'profile-navigation', 'profile-filter', 'profile-observation', 'complete'].includes(diagnostics.lastStep ?? '')) report.lastStep = diagnostics.lastStep!
        if (['invalid-request', 'request-limit', 'cancelled', 'concurrent-read', 'http-denied', 'http-error', 'server-error', 'maintenance', 'authentication-required', 'unsupported-dom', 'condition-mismatch', 'act-unconfirmed', 'act-changed', 'read-failed'].includes(diagnostics.lastErrorCode ?? '')) report.domErrorCode = diagnostics.lastErrorCode!
        if (['1', '2', '3', '4'].includes(diagnostics.characterFilter ?? '')) report.characterFilter = diagnostics.characterFilter!
        if (Number.isSafeInteger(diagnostics.visibleRosterButtonCount) && diagnostics.visibleRosterButtonCount! >= 0 && diagnostics.visibleRosterButtonCount! <= 20) report.visibleRosterButtonCount = diagnostics.visibleRosterButtonCount!
        if (['intercepts-pointer-events', 'not-visible', 'not-stable', 'outside-viewport', 'strict-mode', 'other'].includes(diagnostics.clickFailure ?? '')) report.clickFailure = diagnostics.clickFailure!
        if (['cookie-consent', 'ranking-control', 'header', 'other'].includes(diagnostics.clickHitKind ?? '')) report.clickHitKind = diagnostics.clickHitKind!
        if (['button', 'span', 'div', 'p', 'iframe', 'other'].includes(diagnostics.clickHitTag ?? '')) report.clickHitTag = diagnostics.clickHitTag!
        if (typeof diagnostics.parentParagraph === 'boolean') report.parentParagraph = diagnostics.parentParagraph
        if (typeof diagnostics.pointerEventsNone === 'boolean') report.pointerEventsNone = diagnostics.pointerEventsNone
        report.rosterDiagnostics = sanitizeLegendRosterDiagnostics(diagnostics.rosterDiagnostics)
        report.humanVerification = normalizeDistributionHumanVerification(diagnostics.humanVerification)
        if (Number.isSafeInteger(diagnostics.profileRetryCount) && diagnostics.profileRetryCount! >= 0 && diagnostics.profileRetryCount! <= 1000) report.profileRetryCount = diagnostics.profileRetryCount
        for (const key of ['lastLoginRequired', 'lastSignedIn', 'lastRankingReadable'] as const) if (typeof diagnostics[key] === 'boolean') report[key] = diagnostics[key]
        if (Number.isSafeInteger(diagnostics.readableWithoutSignInReadCount) && diagnostics.readableWithoutSignInReadCount! >= 0 && diagnostics.readableWithoutSignInReadCount! <= 1000) report.readableWithoutSignInReadCount = diagnostics.readableWithoutSignInReadCount!
        if (Number.isSafeInteger(diagnostics.lastHttpStatus) && diagnostics.lastHttpStatus! >= 100 && diagnostics.lastHttpStatus! <= 599) report.lastHttpStatus = diagnostics.lastHttpStatus!
      } catch {}
      try { await transport.close(); report.browserClosed = true }
      catch { dataset = null; report.reason ??= 'collection-failed' }
    }
  }
  report.endedAt = now().toISOString()
  if (report.endedAt < report.startedAt) { report.endedAt = report.startedAt; dataset = null; report.reason = 'collection-failed' }
  const generatedAt = report.endedAt
  try {
    if (dataset) {
      const verified = parseLegendAnalysisDataset(dataset)
      const players: LegendPlayersDataset | null = options.includePlayers ? parseLegendPlayersDataset({
        schemaVersion: 2, id: verified.id, captureStartedAt: verified.captureStartedAt, captureEndedAt: verified.captureEndedAt,
        generatedAt, rankedMatchScope, source: { ...verified.source, metric: '掲載エントリーのプレイヤー情報・キャラクター・順位・MR・今Actランクマッチ対戦数',
          notes: ['公式レジェンド掲載の取得期間内の断面。', '1行はアカウント×キャラクター単位。', '対戦数は掲載キャラのAct全期間のランクマッチ数で、レジェンド到達前も含む。'] },
        act: verified.act, definitionVersion: verified.definitionVersion, membershipRule: verified.membershipRule,
        conditions: verified.conditions, totalCount: verified.totalCount,
        players: (enrichedPlayers ?? []).map((row, index) => ({ id: `entry-${index + 1}`, ...row })),
        validation: { ...verified.validation, notes: ['条件・Act・掲載判定・表示範囲・順位・MR順・重複と両端を確認した。',
          '行IDは取得回内だけで使用する。プレイヤーIDは公開ユーザーコード。', '各プロフィールのユーザーコード・Act・ランクマッチ指定と掲載キャラの対戦数を確認した。'] },
      }) : null
      const manifest = parseLegendAnalysisManifest({ schemaVersion: 1, generatedAt, source: LEGEND_ANALYSIS_SOURCE,
        datasets: [{ id: verified.id, path: `${verified.id}.json`, actId: verified.act.id, definitionVersion: verified.definitionVersion,
          membershipRule: verified.membershipRule, conditions: verified.conditions, captureStartedAt: verified.captureStartedAt,
          captureEndedAt: verified.captureEndedAt, totalCount: verified.totalCount }] })
      if (players) {
        const playerDirectory = resolve(publicDirectory, 'players')
        const playerManifest = parseLegendPlayersManifest({ schemaVersion: 1, generatedAt, source: LEGEND_ANALYSIS_SOURCE,
          datasets: [createLegendPlayersDescriptor(players)] })
        await mkdir(playerDirectory, { mode: 0o700 })
        await writeJson(resolve(playerDirectory, `${players.id}.json`), players)
        await writeJson(resolve(playerDirectory, 'index.json'), playerManifest)
      }
      await writeJson(resolve(publicDirectory, `${verified.id}.json`), verified)
      await writeJson(resolve(publicDirectory, 'index.json'), manifest)
      report.status = 'succeeded'; report.reason = null; report.datasetId = verified.id
    } else {
      await writeJson(resolve(publicDirectory, 'index.json'), parseLegendAnalysisManifest({ schemaVersion: 1, generatedAt,
        source: LEGEND_ANALYSIS_SOURCE, datasets: [], availability: { status: report.reason === 'source-unconfirmed' ? 'verification-pending' : 'collection-failed',
          checkedAt: generatedAt, message: report.reason === 'source-unconfirmed' ? '取得条件の確認が完了していません。'
            : report.reason === 'access-unavailable' ? '取得元が今回のアクセスを受け付けなかったため、集計を完了できませんでした。取得完了データのみを表示します。'
              : '今回の取得を完了できませんでした。取得完了データのみを表示します。' } }))
      if (options.includePlayers) {
        const playerDirectory = resolve(publicDirectory, 'players')
        await mkdir(playerDirectory, { mode: 0o700 })
        await writeJson(resolve(playerDirectory, 'index.json'), parseLegendPlayersManifest({ schemaVersion: 1, generatedAt,
          source: LEGEND_ANALYSIS_SOURCE, datasets: [], availability: { status: report.reason === 'source-unconfirmed' ? 'verification-pending' : 'collection-failed',
            checkedAt: generatedAt, message: 'プレイヤー一覧の取得を完了できませんでした。' } }))
      }
    }
  } catch { report.status = 'failed'; report.reason = 'output-unavailable'; report.datasetId = null }
  return { succeeded: report.status === 'succeeded', report }
}

/** Same fixed DPAPI state and capture-identity check used by the existing local collector. */
export async function loadLegendAnalysisLocalSession(): Promise<LegendAnalysisStorageState> {
  disableRankDistributionDiagnostics(process.env)
  const store = createBucklerSessionStore()
  const { parseCaptureRecord } = await import('./probe-buckler-session.ts')
  await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
  const info = await lstat(BUCKLER_SESSION_CAPTURE_PATH)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 1024) throw new Error('session-unavailable')
  const bytes = await readFile(BUCKLER_SESSION_CAPTURE_PATH)
  if (bytes.length !== info.size) throw new Error('session-unavailable')
  const capture = parseCaptureRecord(JSON.parse(bytes.toString('utf8')))
  if (await store.identity() !== capture.stateIdentity) throw new Error('session-unavailable')
  const state = validateBucklerSessionState(await store.load())
  if (await store.identity() !== capture.stateIdentity) throw new Error('session-unavailable')
  await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
  return JSON.parse(state) as LegendAnalysisStorageState
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/collect-legend-analysis.ts --saved-session [--players]\n保存済み認証をメモリ内で再利用し、公式レジェンド掲載の集計JSONを固定ローカル出力へ保存します。--players は検証済みのプレイヤー一覧も別JSONに保存します。')
    return
  }
  if (args[0] !== '--saved-session' || args.length > 2 || args.length === 2 && args[1] !== '--players') throw new Error('arguments')
  const controller = new AbortController(), interrupt = (): void => controller.abort()
  process.once('SIGINT', interrupt)
  try {
    const outputDirectory = resolve(LEGEND_ANALYSIS_LOCAL_OUTPUT, new Date().toISOString().replace(/[:.]/g, '-'))
    const result = await runLegendAnalysisCollection({ storageState: await loadLegendAnalysisLocalSession(), outputDirectory, signal: controller.signal,
      includePlayers: args.includes('--players') })
    console.log(JSON.stringify(summarizeLegendAnalysisCaptureReport(result.report)))
    console.log(`集計保存先: ${resolve(outputDirectory, 'public')}`)
    if (!result.succeeded) process.exitCode = 2
  } finally { process.removeListener('SIGINT', interrupt) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('レジェンド分析の取得を完了できませんでした。認証情報や生のエラーは表示しません。'); process.exitCode = 1 })
}
