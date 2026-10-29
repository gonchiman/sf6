import { lstat, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseRankDistributionDataset, parseRankDistributionManifest } from '../src/lib/rankDistribution.ts'
import type { RankDistributionDataset } from '../src/types/rankDistribution.ts'
import {
  BUCKLER_CLOUD_RANK_CHECKPOINT_ENV, isAllowedRankDistributionCloudExecution,
  markRankDistributionArtifactReady, RANK_DISTRIBUTION_CLOUD_DATA_DIRECTORY,
  runRankDistributionCloudCollection, summarizeRankDistributionCloudCapture,
} from './collect-rank-distribution-cloud.ts'
import type { RankDistributionCloudDependencies, RankDistributionCloudCaptureSummary } from './collect-rank-distribution-cloud.ts'
import { disableRankDistributionDiagnostics } from './collect-rank-distribution.ts'
import { BUCKLER_CLOUD_SESSION_ENV } from './probe-buckler-cloud.ts'
import { validateRankDistributionDirectory } from './validate-rank-distribution-data.ts'
import { createRankDistributionCheckpointStore, parseRankDistributionCheckpoint } from './lib/rank-distribution-checkpoint.ts'
import type { RankDistributionCheckpoint, RankDistributionCheckpointStore } from './lib/rank-distribution-checkpoint.ts'
import { BUCKLER_WEEKLY_SESSION_SECRET, parseBucklerWeeklySession } from './lib/buckler-weekly-session.ts'
import type { BucklerWeeklySession } from './lib/buckler-weekly-session.ts'
import {
  loadWeeklyHistory, parseRankDistributionWeeklyRunReport, writeWeeklyHistoryOutput,
} from './lib/rank-distribution-weekly-history.ts'
import type { RankDistributionWeeklyHistory, RankDistributionWeeklyRunReport } from './lib/rank-distribution-weekly-history.ts'

const WEEK_SECONDS = 7 * 24 * 60 * 60
const HELP = `Bucklerランク分布の週次クラウド取得

node scripts/collect-rank-distribution-weekly.ts --collect [--max-requests 2〜1000]

固定mainの週次workflowがscheduleまたは手動で実行したGitHub hosted Windows専用です。
BUCKLER_WEEKLY_SESSIONは最初に環境変数から削除し、検証した認証をメモリ内だけで使います。
前回の探索位置はヒントに限り使い、全35境界を新しく確認します。
完成集計・安全なrun記録・checkpointを週次用出力へ保存します。認証操作やアプリ配信は行いません。`

type Environment = Record<string, string | undefined>
export class RankDistributionWeeklyError extends Error {
  readonly code: 'arguments' | 'runner' | 'time'
  constructor(code: 'arguments' | 'runner' | 'time') {
    const messages = {
      arguments: '--collect [--max-requests 2〜1000] または --help を指定してください。',
      runner: '固定mainの週次workflowによるGitHub hosted Windows実行が必要です。',
      time: '週次取得の実行日時を確認できません。',
    }
    super(messages[code])
    this.name = 'RankDistributionWeeklyError'
    this.code = code
  }
}

export function parseRankDistributionWeeklyArguments(args: string[]): { mode: 'collect'; maxRequests: number } | { mode: 'help' } {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' }
  if (args.length === 1 && args[0] === '--collect') return { mode: 'collect', maxRequests: 600 }
  if (args.length === 3 && args[0] === '--collect' && args[1] === '--max-requests'
    && /^[1-9]\d*$/.test(args[2])) {
    const maxRequests = Number(args[2])
    if (Number.isSafeInteger(maxRequests) && maxRequests >= 2 && maxRequests <= 1000) return { mode: 'collect', maxRequests }
  }
  throw new RankDistributionWeeklyError('arguments')
}

function timestamp(now: () => Date): string {
  try {
    const value = Date.prototype.toISOString.call(now())
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error()
    return value
  } catch { throw new RankDistributionWeeklyError('time') }
}

/** Read only the validated single-dataset cloud staging directory, never arbitrary input paths. */
async function loadCloudDataset(): Promise<RankDistributionDataset> {
  for (let current = RANK_DISTRIBUTION_CLOUD_DATA_DIRECTORY; ; current = dirname(current)) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
    if (current === dirname(current)) break
  }
  const result = await validateRankDistributionDirectory(RANK_DISTRIBUTION_CLOUD_DATA_DIRECTORY)
  if (result.datasets !== 1 || result.entries !== 36) throw new Error()
  const manifest = parseRankDistributionManifest(JSON.parse(await readFile(resolve(RANK_DISTRIBUTION_CLOUD_DATA_DIRECTORY, 'index.json'), 'utf8')))
  if (manifest.datasets.length !== 1) throw new Error()
  const descriptor = manifest.datasets[0]
  const dataset = parseRankDistributionDataset(JSON.parse(await readFile(resolve(RANK_DISTRIBUTION_CLOUD_DATA_DIRECTORY, descriptor.path), 'utf8')), descriptor)
  if (dataset.method !== 'boundary-search-estimate') throw new Error()
  return dataset
}

export interface RankDistributionWeeklyDependencies {
  env?: Environment
  now?: () => Date
  signal?: AbortSignal
  loadPrevious?: () => Promise<RankDistributionWeeklyHistory>
  writeHistory?: typeof writeWeeklyHistoryOutput
  loadDataset?: () => Promise<RankDistributionDataset>
  checkpointStore?: RankDistributionCheckpointStore
  runCloud?: typeof runRankDistributionCloudCollection
  cloudDependencies?: Omit<RankDistributionCloudDependencies,
    'env' | 'executionPolicy' | 'memorySessionState' | 'artifactReady' | 'checkpointStore' | 'now' | 'signal'>
  artifactReady?: () => Promise<void>
}

/** Weekly orchestration never serializes the private envelope or its storage state. */
export async function runRankDistributionWeeklyCollection(args: string[], dependencies: RankDistributionWeeklyDependencies = {}): Promise<{
  run: RankDistributionWeeklyRunReport; succeeded: boolean; artifactReady: boolean
}> {
  const env = dependencies.env ?? process.env
  let envelopeJson = env[BUCKLER_WEEKLY_SESSION_SECRET]
  delete env[BUCKLER_WEEKLY_SESSION_SECRET]
  // Weekly execution accepts no probe credential or externally supplied search state.
  delete env[BUCKLER_CLOUD_SESSION_ENV]
  delete env[BUCKLER_CLOUD_RANK_CHECKPOINT_ENV]
  disableRankDistributionDiagnostics(env)
  const options = parseRankDistributionWeeklyArguments(args)
  if (options.mode === 'help') throw new RankDistributionWeeklyError('arguments')
  if (!isAllowedRankDistributionCloudExecution(env, 'weekly') || !/^[1-9]\d{0,24}$/.test(env.GITHUB_RUN_ID ?? '')
    || !/^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw new RankDistributionWeeklyError('runner')
  const now = dependencies.now ?? (() => new Date())
  const startedAt = timestamp(now)
  let session: BucklerWeeklySession | undefined
  let failureReason: RankDistributionWeeklyRunReport['failureReason'] = null
  let sessionCapturedAt: string | null = null
  let sessionUploadedAt: string | null = null
  let sessionAgeSeconds: number | null = null
  try {
    if (!envelopeJson) throw new Error()
    session = parseBucklerWeeklySession(envelopeJson, new Date(startedAt))
    sessionCapturedAt = session.capturedAt
    sessionUploadedAt = session.uploadedAt
    sessionAgeSeconds = Math.floor((Date.parse(startedAt) - Date.parse(sessionCapturedAt)) / 1000)
  } catch { failureReason = 'authentication-unavailable' }
  finally { envelopeJson = undefined }
  let previous: RankDistributionWeeklyHistory | undefined
  try { previous = await (dependencies.loadPrevious ?? (() => loadWeeklyHistory(undefined, now)))() }
  catch { failureReason = 'history-unavailable' }
  let capture: RankDistributionCloudCaptureSummary | null = null
  let dataset: RankDistributionDataset | undefined
  let checkpoint: RankDistributionCheckpoint | undefined
  const checkpoints = dependencies.checkpointStore ?? createRankDistributionCheckpointStore()
  if (previous && session) {
    try {
      if (previous.checkpoint) await checkpoints.save(parseRankDistributionCheckpoint(previous.checkpoint))
      const result = await (dependencies.runCloud ?? runRankDistributionCloudCollection)([
        '--saved-session', '--max-requests', String(options.maxRequests), ...(previous.checkpoint ? ['--resume'] : []),
      ], {
        ...dependencies.cloudDependencies, env, executionPolicy: 'weekly', memorySessionState: session.storageState,
        checkpointStore: checkpoints, now, signal: dependencies.signal, artifactReady: undefined,
      })
      capture = summarizeRankDistributionCloudCapture(result.report.capture)
      if (result.succeeded && result.report.datasetStaged && capture.status === 'succeeded') {
        const loaded = parseRankDistributionDataset(await (dependencies.loadDataset ?? loadCloudDataset)())
        if (loaded.method !== 'boundary-search-estimate' || !capture.startedAt || !capture.endedAt
          || Date.parse(loaded.captureStartedAt) < Date.parse(capture.startedAt)
          || Date.parse(loaded.captureEndedAt) > Date.parse(capture.endedAt)) throw new Error()
        dataset = loaded
      } else failureReason = 'collection-failed'
      const latest = await checkpoints.load()
      if (latest) checkpoint = parseRankDistributionCheckpoint(latest)
    } catch {
      dataset = undefined
      failureReason = capture ? 'output-unavailable' : 'collection-failed'
    } finally { session = undefined }
  } else { session = undefined }
  const endedAt = timestamp(now)
  const initialSignInConfirmed = (capture?.successfulReadCount ?? 0) > 0
  const reuseAfterSevenDays = !initialSignInConfirmed ? 'unconfirmed'
    : sessionAgeSeconds !== null && sessionAgeSeconds >= WEEK_SECONDS ? 'confirmed' : 'pending'
  let run = parseRankDistributionWeeklyRunReport({
    schemaVersion: 1, id: `run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`, startedAt, endedAt,
    event: env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual',
    status: dataset && failureReason === null ? 'succeeded' : 'failed',
    failureReason: dataset && failureReason === null ? null : failureReason ?? 'collection-failed',
    sessionCapturedAt, sessionUploadedAt, sessionAgeSeconds, initialSignInConfirmed, reuseAfterSevenDays,
    capture, datasetId: dataset && failureReason === null ? dataset.id : null,
  }, () => new Date(endedAt))
  if (!previous) return { run, succeeded: false, artifactReady: false }
  try {
    await (dependencies.writeHistory ?? writeWeeklyHistoryOutput)({ previous, run, dataset, checkpoint, now })
    await dependencies.artifactReady?.()
    return { run, succeeded: run.status === 'succeeded', artifactReady: true }
  } catch {
    // A partially staged history is never authorized for upload or publication.
    run = parseRankDistributionWeeklyRunReport({ ...run, status: 'failed', failureReason: 'output-unavailable', datasetId: null }, () => new Date(endedAt))
    return { run, succeeded: false, artifactReady: false }
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    delete process.env[BUCKLER_WEEKLY_SESSION_SECRET]
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
    const result = await runRankDistributionWeeklyCollection(args, { signal: interrupted.signal,
      artifactReady: () => markRankDistributionArtifactReady(process.env) })
    console.log(JSON.stringify(result.run))
    if (!result.succeeded) process.exitCode = 2
  } finally { process.removeListener('SIGINT', interrupt) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof RankDistributionWeeklyError ? error.message : '週次ランク分布の取得を完了できませんでした。')
    process.exitCode = 1
  })
}
