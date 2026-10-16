import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BrowserContextOptions } from 'playwright'
import { parseRankDistributionDataset } from '../src/lib/rankDistribution.ts'
import {
  createRankDistributionPrivateWriter, disableRankDistributionDiagnostics,
  parseRankDistributionCaptureArguments, runRankDistributionCollection,
} from './collect-rank-distribution.ts'
import type {
  RankDistributionCaptureDependencies, RankDistributionCaptureOptions,
  RankDistributionCaptureReport, RankDistributionCaptureTransport,
} from './collect-rank-distribution.ts'
import { importRankDistributionData } from './import-rank-distribution-data.ts'
import { createRankDistributionPageReader } from './lib/rank-distribution-dom.ts'
import {
  createRankDistributionCheckpointStore, parseRankDistributionCheckpoint, RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT,
} from './lib/rank-distribution-checkpoint.ts'
import type { RankDistributionCheckpoint, RankDistributionCheckpointStore } from './lib/rank-distribution-checkpoint.ts'
import { validateBucklerSessionState } from './lib/buckler-session-store.ts'
import {
  BUCKLER_CLOUD_SESSION_ENV, BUCKLER_CLOUD_SESSION_SIZE_LIMIT, isHostedGitHubExecution,
} from './probe-buckler-cloud.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY = resolve(ROOT, 'rank-distribution-cloud-output')
export const RANK_DISTRIBUTION_CLOUD_DATA_DIRECTORY = resolve(RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY, 'data')
export const RANK_DISTRIBUTION_CLOUD_REPORT_PATH = resolve(RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY, 'report.json')
export const RANK_DISTRIBUTION_CLOUD_CHECKPOINT_PATH = resolve(RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY, 'checkpoint.json')
export const BUCKLER_CLOUD_RANK_CHECKPOINT_ENV = 'BUCKLER_CLOUD_RANK_CHECKPOINT'
const REPOSITORY = 'gonchiman/sf6'
const BRANCH_PREFIX = 'refs/heads/codex/buckler-cloud-collection'
const WEEKLY_WORKFLOW_REF = 'gonchiman/sf6/.github/workflows/rank-distribution-weekly.yml@refs/heads/main'
const OUTPUT_LIMIT = 1024 * 1024
const HELP = `Bucklerランク分布のクラウド全体取得（単発・概数）

node scripts/collect-rank-distribution-cloud.ts --saved-session [--resume] [--max-requests 2〜1000]

GitHub hosted Windows・手動実行・固定リポジトリの検証ブランチ専用です。
固定環境変数 BUCKLER_CLOUD_PROBE_SESSION を直ちに削除し、検証した認証状態をメモリ内だけで使います。
--resume時は非secret環境変数 BUCKLER_CLOUD_RANK_CHECKPOINT の検証済み探索位置を固定storeへ取り込めます。
この入力も直ちに環境変数から削除し、1MiB上限・形式・未来日時を検査します。全35境界は新しく確認します。
認証送信・ログイン・チャレンジ操作・週次設定・アプリへの取り込み・デプロイは行いません。
全35境界の確認が終わった集計、数値と判定のみのレポート、途中保存だけを
固定 rank-distribution-cloud-output/ に用意します。Artifactsへの実アップロードはworkflowが行います。`

type Environment = Record<string, string | undefined>
type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>
export type RankDistributionCloudErrorCode = 'arguments' | 'runner' | 'session-missing'
  | 'session-too-large' | 'session-invalid' | 'checkpoint-without-resume' | 'checkpoint-too-large'
  | 'checkpoint-invalid' | 'output' | 'collection'

export class RankDistributionCloudError extends Error {
  readonly code: RankDistributionCloudErrorCode
  constructor(code: RankDistributionCloudErrorCode) {
    const messages = {
      arguments: '--saved-session [--resume] [--max-requests 2〜1000] または --help を指定してください。',
      runner: '指定リポジトリの許可されたGitHub hosted実行が必要です。',
      'session-missing': 'クラウド取得用の保存状態が設定されていません。',
      'session-too-large': 'クラウド取得用の保存状態は48KiB未満にしてください。',
      'session-invalid': 'クラウド取得用の保存状態の形式・対象サイトを確認できません。',
      'checkpoint-without-resume': '探索位置を入力する場合は --resume を指定してください。',
      'checkpoint-too-large': '探索位置の入力は1MiB以下にしてください。',
      'checkpoint-invalid': '探索位置の入力形式または日時を確認できません。',
      output: 'クラウド取得の安全な出力先を準備または保存できませんでした。',
      collection: 'クラウド取得を完了できませんでした。認証情報や生のエラーは表示しません。',
    }
    super(messages[code])
    this.name = 'RankDistributionCloudError'
    this.code = code
  }
}

export function parseRankDistributionCloudArguments(args: string[]): RankDistributionCaptureOptions | { mode: 'help' } {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' }
  if (args[0] !== '--saved-session' || args.includes('--strict')) throw new RankDistributionCloudError('arguments')
  try {
    const parsed = parseRankDistributionCaptureArguments(['--collect', ...args.slice(1)])
    if (parsed.mode !== 'collect') throw new Error()
    return { ...parsed, accuracy: 'estimate' }
  } catch { throw new RankDistributionCloudError('arguments') }
}

/** Only platform settings needed by Edge are inherited, never workflow credentials. */
export function rankDistributionCloudBrowserEnvironment(env: Environment): Record<string, string> {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
    'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL', 'TZ'])
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] =>
    allowed.has(entry[0].toUpperCase()) && typeof entry[1] === 'string'))
}

export interface RankDistributionCloudLaunchOptions {
  storageState: StorageState
  env: Record<string, string>
  signal: AbortSignal
  channel: 'msedge'
  headless: false
  minIntervalMs: 5000
  totalCountPolicy: 'record'
  allowReadablePagesAfterSignIn: true
}

export interface RankDistributionCloudOutputIo {
  inspect(path: string): Promise<{ directory: boolean; file: boolean; symbolicLink: boolean } | null>
  mkdir(path: string): Promise<void>
  write(path: string, text: string): Promise<void>
}
const outputIo: RankDistributionCloudOutputIo = {
  async inspect(path) {
    try {
      const info = await lstat(path)
      return { directory: info.isDirectory(), file: info.isFile(), symbolicLink: info.isSymbolicLink() }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  },
  async mkdir(path) { await mkdir(path, { mode: 0o700 }) },
  async write(path, text) {
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
  },
}

async function checkOutputParents(io: RankDistributionCloudOutputIo, path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    const info = await io.inspect(current)
    if (!info?.directory || info.symbolicLink) throw new RankDistributionCloudError('output')
    if (current === dirname(current)) return
  }
}
async function prepareOutput(io: RankDistributionCloudOutputIo): Promise<void> {
  await checkOutputParents(io, ROOT)
  // Refuse a reused staging directory rather than uploading leftovers from a prior run.
  if (await io.inspect(RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY)) throw new RankDistributionCloudError('output')
  await io.mkdir(RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY)
  await checkOutputParents(io, RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY)
}
async function writeOutput(io: RankDistributionCloudOutputIo, path: string, value: unknown): Promise<void> {
  if (![RANK_DISTRIBUTION_CLOUD_REPORT_PATH, RANK_DISTRIBUTION_CLOUD_CHECKPOINT_PATH].includes(path)) throw new RankDistributionCloudError('output')
  await checkOutputParents(io, RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY)
  if (await io.inspect(path)) throw new RankDistributionCloudError('output')
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > OUTPUT_LIMIT) throw new RankDistributionCloudError('output')
  await io.write(path, text)
}

const stages = ['checkpoint-load', 'checkpoint-save', 'authentication', 'browser-launch', 'preflight', 'collection', 'dataset-save', 'publication', 'complete'] as const
const reasons = ['source-changed', 'unknown-rank', 'evidence-unconfirmed', 'authentication-required', 'authentication-unconfirmed',
  'access-denied', 'maintenance', 'read-failed', 'publication-failed', 'configuration-invalid', 'checkpoint-unavailable',
  'cancelled', 'request-limit', 'observation-changed'] as const
const readCodes = ['invalid-request', 'concurrent-read', 'first-page-required', 'cancelled', 'http-denied', 'http-error',
  'server-error', 'maintenance', 'login-required', 'authentication-unconfirmed', 'condition-mismatch', 'page-mismatch',
  'unsupported-rank-icon', 'unsupported-dom', 'total-count-changed', 'timeout', 'read-failed'] as const
function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum }
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  try { return new Date(value).toISOString() === value ? value : null } catch { return null }
}
export interface RankDistributionCloudCaptureSummary {
  status: 'succeeded' | 'failed'
  stage: typeof stages[number] | null
  reason: typeof reasons[number] | null
  startedAt: string | null
  endedAt: string | null
  requestCount: number
  successfulReadCount: number
  confirmedBoundaryCount: number
  retryCount: number
  sessionRefreshCount: number
  checkpointHintCount: number
  checkpointLoaded: boolean
  checkpointSaved: boolean
  datasetSaved: boolean
  published: boolean
  browserClosed: boolean
  totalMin: number | null
  totalMax: number | null
  totalAtEnd: number | null
  lastObservedTotal: number | null
  lastAttemptedPage: number | null
  lastHttpStatus: number | null
  readFailureCode: typeof readCodes[number] | null
  lastAuthenticationEvidence: 'logout-control' | 'login-control' | 'conflicting-controls' | 'no-control' | null
  lastLoginRequiredHeading: boolean | null
  lastRankingReadable: boolean | null
  readableWithoutSignInReadCount: number
}

/** Fixed enums, dates, counts and booleans only; never serialize an arbitrary report. */
export function summarizeRankDistributionCloudCapture(value: unknown): RankDistributionCloudCaptureSummary {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const result: RankDistributionCloudCaptureSummary = {
    status: input.status === 'succeeded' ? 'succeeded' : 'failed',
    stage: stages.includes(input.stage as never) ? input.stage as typeof stages[number] : null,
    reason: reasons.includes(input.reason as never) ? input.reason as typeof reasons[number] : null,
    startedAt: timestamp(input.startedAt), endedAt: timestamp(input.endedAt),
    requestCount: 0, successfulReadCount: 0, confirmedBoundaryCount: 0, retryCount: 0, sessionRefreshCount: 0, checkpointHintCount: 0,
    checkpointLoaded: input.checkpointLoaded === true, checkpointSaved: input.checkpointSaved === true,
    datasetSaved: input.datasetSaved === true, published: input.published === true, browserClosed: input.browserClosed === true,
    totalMin: null, totalMax: null, totalAtEnd: null, lastObservedTotal: null, lastAttemptedPage: null, lastHttpStatus: null,
    readFailureCode: readCodes.includes(input.readFailureCode as never) ? input.readFailureCode as typeof readCodes[number] : null,
    lastAuthenticationEvidence: null, lastLoginRequiredHeading: null, lastRankingReadable: null, readableWithoutSignInReadCount: 0,
  }
  for (const key of ['requestCount', 'successfulReadCount', 'retryCount', 'sessionRefreshCount'] as const) {
    if (integer(input[key]) && input[key] <= 1000) result[key] = input[key]
  }
  for (const key of ['confirmedBoundaryCount', 'checkpointHintCount'] as const) {
    if (integer(input[key]) && input[key] <= 35) result[key] = input[key]
  }
  for (const key of ['totalMin', 'totalMax', 'totalAtEnd', 'lastObservedTotal', 'lastAttemptedPage'] as const) {
    if (integer(input[key], 1)) result[key] = input[key]
  }
  if (integer(input.lastHttpStatus, 100) && input.lastHttpStatus <= 599) result.lastHttpStatus = input.lastHttpStatus
  if (['logout-control', 'login-control', 'conflicting-controls', 'no-control'].includes(input.lastAuthenticationEvidence as string)) {
    result.lastAuthenticationEvidence = input.lastAuthenticationEvidence as RankDistributionCloudCaptureSummary['lastAuthenticationEvidence']
  }
  for (const key of ['lastLoginRequiredHeading', 'lastRankingReadable'] as const) {
    if (typeof input[key] === 'boolean') result[key] = input[key]
  }
  if (integer(input.readableWithoutSignInReadCount)) result.readableWithoutSignInReadCount = input.readableWithoutSignInReadCount
  return result
}

export interface RankDistributionCloudReport {
  schemaVersion: 1
  cloudExecution: true
  publicationTarget: 'artifact-staging'
  appImported: false
  deployed: false
  artifactUploaded: false
  /** False suppresses the complete artifact upload, even if a dataset was completed. */
  artifactReady: boolean
  manualLoginPerformed: false
  sessionLifetime: 'not-tested'
  weeklyExecution: 'not-tested'
  datasetStaged: boolean
  checkpointStaged: boolean
  checkpointSeeded: boolean
  checkpointExport: 'saved' | 'absent' | 'failed'
  capture: RankDistributionCloudCaptureSummary
}
export interface RankDistributionCloudDependencies {
  /** Weekly access is an explicit in-process policy, never a CLI flag. */
  executionPolicy?: 'probe' | 'weekly'
  /** Weekly runner supplies an already parsed envelope's state only in memory. */
  memorySessionState?: StorageState
  env?: Environment
  launch?: (options: RankDistributionCloudLaunchOptions) => Promise<RankDistributionCaptureTransport>
  collect?: typeof runRankDistributionCollection
  checkpointStore?: RankDistributionCheckpointStore
  writePrivate?: ReturnType<typeof createRankDistributionPrivateWriter>
  importDataset?: typeof importRankDistributionData
  outputIo?: RankDistributionCloudOutputIo
  now?: () => Date
  signal?: AbortSignal
  wait?: RankDistributionCaptureDependencies['wait']
  /** Called only after every available safe output has been staged successfully. */
  artifactReady?: () => Promise<void>
}

/** Use GitHub's existing output channel, never a caller-selected output location. */
export async function markRankDistributionArtifactReady(env: Environment): Promise<void> {
  const path = env.GITHUB_OUTPUT
  if (!path || !isAbsolute(path)) throw new RankDistributionCloudError('output')
  await checkOutputParents(outputIo, dirname(path))
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024) throw new RankDistributionCloudError('output')
  // O_CREAT is deliberately absent: a missing runner output file is an error.
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND)
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) throw new RankDistributionCloudError('output')
    await handle.writeFile('artifact_ready=true\n', 'utf8')
    await handle.sync()
  } finally { await handle.close() }
}

/** Preserve the original probe guard; weekly access additionally pins the workflow identity. */
export function isAllowedRankDistributionCloudExecution(env: Environment, policy: 'probe' | 'weekly' = 'probe'): boolean {
  if (!isHostedGitHubExecution(env) || env.GITHUB_REPOSITORY !== REPOSITORY || env.RUNNER_OS !== 'Windows') return false
  if (policy === 'weekly') return env.GITHUB_REF === 'refs/heads/main'
    && (env.GITHUB_EVENT_NAME === 'schedule' || env.GITHUB_EVENT_NAME === 'workflow_dispatch')
    && env.GITHUB_WORKFLOW_REF === WEEKLY_WORKFLOW_REF
  return policy === 'probe' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF?.startsWith(BRANCH_PREFIX) === true
}

async function launchCloudEdge(options: RankDistributionCloudLaunchOptions): Promise<RankDistributionCaptureTransport> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ channel: options.channel, headless: options.headless, env: options.env, timeout: 30_000 })
  try {
    options.signal.throwIfAborted()
    const context = await browser.newContext({ locale: 'ja-JP', acceptDownloads: false, storageState: options.storageState })
    const page = await context.newPage()
    const reader = createRankDistributionPageReader(page, { signal: options.signal,
      minIntervalMs: options.minIntervalMs, totalCountPolicy: options.totalCountPolicy,
      allowReadablePagesAfterSignIn: options.allowReadablePagesAfterSignIn })
    return { ...reader, close: () => browser.close() }
  } catch (error) { await browser.close().catch(() => {}); throw error }
}

/** No credential file is read or written. Only the supplied fixed env value enters memory. */
export async function runRankDistributionCloudCollection(args: string[], dependencies: RankDistributionCloudDependencies = {}): Promise<{
  report: RankDistributionCloudReport; succeeded: boolean; artifactReady: boolean
}> {
  const env = dependencies.env ?? process.env
  let sessionJson = env[BUCKLER_CLOUD_SESSION_ENV]
  let checkpointJson = env[BUCKLER_CLOUD_RANK_CHECKPOINT_ENV]
  delete env[BUCKLER_CLOUD_SESSION_ENV]
  delete env[BUCKLER_CLOUD_RANK_CHECKPOINT_ENV]
  disableRankDistributionDiagnostics(env)
  const options = parseRankDistributionCloudArguments(args)
  if (options.mode === 'help') throw new RankDistributionCloudError('arguments')
  const executionPolicy = dependencies.executionPolicy ?? 'probe'
  if (!isAllowedRankDistributionCloudExecution(env, executionPolicy)) throw new RankDistributionCloudError('runner')
  if (executionPolicy === 'weekly') {
    if (dependencies.memorySessionState === undefined || sessionJson) throw new RankDistributionCloudError('session-invalid')
    try { sessionJson = JSON.stringify(dependencies.memorySessionState) } catch { throw new RankDistributionCloudError('session-invalid') }
  } else if (dependencies.memorySessionState !== undefined) throw new RankDistributionCloudError('session-invalid')
  if (!sessionJson) throw new RankDistributionCloudError('session-missing')
  if (Buffer.byteLength(sessionJson, 'utf8') >= BUCKLER_CLOUD_SESSION_SIZE_LIMIT) throw new RankDistributionCloudError('session-too-large')
  let state: StorageState | undefined
  try { state = JSON.parse(validateBucklerSessionState(sessionJson)) as StorageState }
  catch { throw new RankDistributionCloudError('session-invalid') }
  finally { sessionJson = undefined }
  let checkpointSeed: RankDistributionCheckpoint | undefined
  if (checkpointJson) {
    if (!options.resume) throw new RankDistributionCloudError('checkpoint-without-resume')
    if (Buffer.byteLength(checkpointJson, 'utf8') > RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT) throw new RankDistributionCloudError('checkpoint-too-large')
    try {
      checkpointSeed = parseRankDistributionCheckpoint(JSON.parse(checkpointJson))
      const currentTime = Date.prototype.getTime.call((dependencies.now ?? (() => new Date()))())
      if (!Number.isFinite(currentTime) || Date.parse(checkpointSeed.savedAt) > currentTime) throw new Error()
    } catch { throw new RankDistributionCloudError('checkpoint-invalid') }
    finally { checkpointJson = undefined }
  }
  const childEnvironment = rankDistributionCloudBrowserEnvironment(env)
  const io = dependencies.outputIo ?? outputIo
  const checkpoints = dependencies.checkpointStore ?? createRankDistributionCheckpointStore()
  const writer = dependencies.writePrivate ?? createRankDistributionPrivateWriter()
  let datasetPath: string | undefined
  let datasetStaged = false
  let checkpointSeeded = false
  let capture: RankDistributionCaptureReport
  try {
    await prepareOutput(io)
    if (checkpointSeed) {
      await checkpoints.save(checkpointSeed)
      checkpointSeeded = true
      checkpointSeed = undefined
    }
    capture = await (dependencies.collect ?? runRankDistributionCollection)(options, {
      loadSession: async () => state!,
      launch: async (storageState, signal) => (dependencies.launch ?? launchCloudEdge)({ storageState, signal,
        env: { ...childEnvironment }, channel: 'msedge', headless: false, minIntervalMs: 5000,
        totalCountPolicy: 'record', allowReadablePagesAfterSignIn: true }),
      loadCheckpoint: () => checkpoints.load(),
      saveCheckpoint: value => checkpoints.save(parseRankDistributionCheckpoint(value)),
      saveDataset: async value => {
        const parsed = parseRankDistributionDataset(value)
        if (parsed.method !== 'boundary-search-estimate') throw new RankDistributionCloudError('collection')
        datasetPath = await writer(`${parsed.id}.json`, parsed)
        return datasetPath
      },
      publish: async path => {
        if (!datasetPath || path !== datasetPath) throw new RankDistributionCloudError('output')
        await checkOutputParents(io, RANK_DISTRIBUTION_CLOUD_OUTPUT_DIRECTORY)
        await (dependencies.importDataset ?? importRankDistributionData)(path, RANK_DISTRIBUTION_CLOUD_DATA_DIRECTORY)
        datasetStaged = true
      },
      // The cloud run's failure is recorded in its safe report, never the app manifest.
      recordAvailability: async () => {},
      writeReport: async value => {
        const summary = summarizeRankDistributionCloudCapture(value)
        if (!summary.startedAt) throw new RankDistributionCloudError('output')
        await writer(`capture-${summary.startedAt.replace(/[:.]/g, '-')}.json`, summary)
      },
      now: dependencies.now, signal: dependencies.signal, wait: dependencies.wait,
    })
  } catch (error) {
    throw new RankDistributionCloudError(error instanceof RankDistributionCloudError && error.code === 'output' ? 'output' : 'collection')
  } finally { state = undefined }
  let checkpointStaged = false
  let checkpointExport: RankDistributionCloudReport['checkpointExport'] = 'absent'
  try {
    const checkpoint = await checkpoints.load()
    if (checkpoint) {
      await writeOutput(io, RANK_DISTRIBUTION_CLOUD_CHECKPOINT_PATH, parseRankDistributionCheckpoint(checkpoint))
      checkpointStaged = true
      checkpointExport = 'saved'
    }
  } catch { checkpointExport = 'failed' }
  // A failed direct write may have left an incomplete checkpoint file. Keep the
  // report for stdout diagnosis, but never authorize any artifact upload then.
  const artifactReady = checkpointExport !== 'failed'
  const report: RankDistributionCloudReport = {
    schemaVersion: 1, cloudExecution: true, publicationTarget: 'artifact-staging', appImported: false, deployed: false,
    artifactUploaded: false, artifactReady, manualLoginPerformed: false, sessionLifetime: 'not-tested', weeklyExecution: 'not-tested',
    datasetStaged, checkpointStaged, checkpointSeeded, checkpointExport, capture: summarizeRankDistributionCloudCapture(capture),
  }
  try {
    await writeOutput(io, RANK_DISTRIBUTION_CLOUD_REPORT_PATH, report)
    if (artifactReady) await dependencies.artifactReady?.()
  }
  catch { throw new RankDistributionCloudError('output') }
  return { report, succeeded: capture.status === 'succeeded' && datasetStaged && artifactReady, artifactReady }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    delete process.env[BUCKLER_CLOUD_SESSION_ENV]
    delete process.env[BUCKLER_CLOUD_RANK_CHECKPOINT_ENV]
    disableRankDistributionDiagnostics(process.env)
    console.log(HELP)
    return
  }
  const interrupted = new AbortController()
  const interrupt = (): void => { interrupted.abort() }
  process.once('SIGINT', interrupt)
  try {
    const result = await runRankDistributionCloudCollection(args, { signal: interrupted.signal,
      artifactReady: () => markRankDistributionArtifactReady(process.env) })
    console.log(JSON.stringify(result.report))
    if (!result.succeeded) process.exitCode = 2
  } finally { process.removeListener('SIGINT', interrupt) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof RankDistributionCloudError ? error.message : 'クラウド取得を完了できませんでした。')
    process.exitCode = 1
  })
}
