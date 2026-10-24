import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseParallelFetchConcurrencyInput, parseParallelFetchIntervalInput, parseParallelFetchReport } from '../src/lib/parallelFetch.ts'
import { cloudConfig, parseCloudIntervalOptions, sameParallelFetchConfig } from '../src/lib/parallelFetchCloud.ts'
import { PARALLEL_FETCH_ERRORS } from '../src/types/parallelFetch.ts'
import type { ParallelFetchErrorCode, ParallelFetchReport } from '../src/types/parallelFetch.ts'
import type { CloudIntervalOptions, CloudMode } from '../src/types/parallelFetchCloud.ts'
import { disableRankDistributionDiagnostics } from './collect-rank-distribution.ts'
import { markRankDistributionArtifactReady } from './collect-rank-distribution-cloud.ts'
import { BUCKLER_WEEKLY_SESSION_SECRET, parseBucklerWeeklySession } from './lib/buckler-weekly-session.ts'
import type { BucklerWeeklyStorageState } from './lib/buckler-weekly-session.ts'
import { createParallelFetchBrowserSession } from './lib/parallel-fetch-browser.ts'
import type { ParallelFetchBrowserSession } from './lib/parallel-fetch-browser.ts'
import { ParallelFetchReadError, runParallelFetch } from './lib/parallel-fetch-runner.ts'
import { createParallelFetchReportWriter } from './lib/parallel-fetch-service.ts'

type Environment = Record<string, string | undefined>
export type ParallelFetchCloudMode = CloudMode
export const PARALLEL_FETCH_CLOUD_BRANCH = 'refs/heads/codex/buckler-cloud-collection-parallel-20261021'
export const PARALLEL_FETCH_CLOUD_WORKFLOW = `gonchiman/sf6/.github/workflows/rank-distribution-cloud-probe.yml@${PARALLEL_FETCH_CLOUD_BRANCH}`
export const PARALLEL_FETCH_MAIN_WORKFLOW = 'gonchiman/sf6/.github/workflows/parallel-fetch-test.yml@refs/heads/main'
export const PARALLEL_FETCH_CLOUD_TIMEOUT_MS = 10 * 60 * 1000
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HELP = `Bucklerランキングの小規模クラウド取得テスト

node scripts/test-parallel-fetch-cloud.ts --serial
node scripts/test-parallel-fetch-cloud.ts --compare
node scripts/test-parallel-fetch-cloud.ts --interval-compare --interval-seconds=5,3 --concurrencies=1,2 --repetitions=1 --interval-scope=global

--serial: LPの1〜20ページを並列数1で3回（事前確認を含め63取得予定）
--compare: 同じ20ページを並列数1・2で各1回（事前確認を含め43取得予定）
--interval-compare: 0〜60秒（0.1秒単位、最大3種類）と並列数1〜8（1必須）をカンマ区切りで指定し、長い間隔から比較
--interval-scope: globalは全タブ共通、per-tabはタブごとの取得開始間隔。省略時global。旧--intervalsはミリ秒入力。
固定テストの開始間隔は5秒。全条件合計200取得以内、最大10分。認証・チャレンジ検出時は停止します。
指定のmain上の手動workflow、または既存の検証ブランチ・GitHub hosted Windows専用です。
mainのworkflowでは PARALLEL_FETCH_REQUEST_ID に小文字のUUID v4を指定します。`

export class ParallelFetchCloudError extends Error {
  readonly code: 'arguments' | 'runner' | 'time'
  constructor(code: 'arguments' | 'runner' | 'time') {
    super({ arguments: 'テスト種別と許可された取得間隔・並列数・反復回数を確認してください。',
      runner: '指定ブランチ・手動workflowのGitHub hosted Windows実行が必要です。',
      time: 'クラウドテストの実行日時を確認できません。' }[code])
    this.name = 'ParallelFetchCloudError'
    this.code = code
  }
}

export function parseParallelFetchCloudArguments(args: string[]): { mode: ParallelFetchCloudMode | 'help'; options?: CloudIntervalOptions } {
  if (args.length === 1 && ['--serial', '--compare', '--help'].includes(args[0])) {
    return { mode: args[0].slice(2) as ParallelFetchCloudMode | 'help' }
  }
  if ((args.length === 4 || args.length === 5) && args[0] === '--interval-compare'
    && (args[1].startsWith('--interval-seconds=') || /^--intervals=\d+(?:,\d+){0,2}$/.test(args[1]))
    && args[2].startsWith('--concurrencies=') && /^--repetitions=[13]$/.test(args[3])
    && (args.length === 4 || /^--interval-scope=(global|per-tab)$/.test(args[4]))) {
    try {
      const intervalMsList = args[1].startsWith('--interval-seconds=')
        ? parseParallelFetchIntervalInput(args[1].slice('--interval-seconds='.length))
        : args[1].slice('--intervals='.length).split(',').map(Number)
      const options = parseCloudIntervalOptions({ intervalMsList,
        concurrencies: parseParallelFetchConcurrencyInput(args[2].slice('--concurrencies='.length)),
        repetitions: Number(args[3].slice('--repetitions='.length)),
        intervalScope: args.length === 5 ? args[4].slice('--interval-scope='.length) : 'global' })
      return { mode: 'interval-compare', options }
    } catch { /* Return the same bounded argument error without raw user input. */ }
  }
  throw new ParallelFetchCloudError('arguments')
}

export function isAllowedParallelFetchCloudExecution(env: Environment): boolean {
  const hosted = env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Windows'
    && env.GITHUB_REPOSITORY === 'gonchiman/sf6' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && /^[1-9]\d{0,24}$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
  if (!hosted) return false
  if (env.GITHUB_REF === PARALLEL_FETCH_CLOUD_BRANCH) return env.GITHUB_WORKFLOW_REF === PARALLEL_FETCH_CLOUD_WORKFLOW
  return env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_WORKFLOW_REF === PARALLEL_FETCH_MAIN_WORKFLOW
    && env.GITHUB_SHA?.length === 40 && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA)
    && env.PARALLEL_FETCH_REQUEST_ID?.length === 36 && REQUEST_ID.test(env.PARALLEL_FETCH_REQUEST_ID)
}

function consumeSession(env: Environment): string | undefined {
  const value = env[BUCKLER_WEEKLY_SESSION_SECRET]
  delete env[BUCKLER_WEEKLY_SESSION_SECRET]
  delete env.BUCKLER_CLOUD_PROBE_SESSION
  delete env.BUCKLER_CLOUD_RANK_CHECKPOINT
  disableRankDistributionDiagnostics(env)
  return value
}

function timestamp(now: () => Date): string {
  try { return Date.prototype.toISOString.call(now()) } catch { throw new ParallelFetchCloudError('time') }
}

function safeReadCode(error: unknown): ParallelFetchErrorCode {
  return error instanceof ParallelFetchReadError && PARALLEL_FETCH_ERRORS.includes(error.code) ? error.code : 'read-failed'
}

export interface ParallelFetchCloudDependencies {
  env?: Environment
  now?: () => Date
  signal?: AbortSignal
  openBrowser?: typeof createParallelFetchBrowserSession
  run?: typeof runParallelFetch
  saveReport?: (report: ParallelFetchReport) => Promise<void>
  artifactReady?: () => Promise<void>
  armDeadline?: (abort: () => void, milliseconds: number) => () => void
}

export interface ParallelFetchCloudResult {
  report: ParallelFetchReport
  succeeded: boolean
  artifactReady: boolean
  outputError: 'report-save-failed' | null
}

/** No local authentication file is consulted; only the fixed workflow Secret enters memory. */
export async function runParallelFetchCloudTest(args: string[], dependencies: ParallelFetchCloudDependencies = {}): Promise<ParallelFetchCloudResult> {
  const env = dependencies.env ?? process.env
  let envelope = consumeSession(env)
  const options = parseParallelFetchCloudArguments(args)
  if (options.mode === 'help') throw new ParallelFetchCloudError('arguments')
  if (!isAllowedParallelFetchCloudExecution(env)) throw new ParallelFetchCloudError('runner')
  if (options.mode === 'interval-compare' && env.GITHUB_REF !== 'refs/heads/main') throw new ParallelFetchCloudError('runner')
  const now = dependencies.now ?? (() => new Date())
  const startedAt = timestamp(now)
  const config = cloudConfig(options.mode, options.options)
  const runId = `cloud-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${options.mode}`
  const failedReport = (code: ParallelFetchErrorCode): ParallelFetchReport => parseParallelFetchReport({
    schemaVersion: 3, runId, config, startedAt, finishedAt: timestamp(now), trials: [],
    state: code === 'cancelled' ? 'stopped' : 'error', errorCode: code,
  })
  let storageState: BucklerWeeklyStorageState | undefined
  try { if (envelope) storageState = parseBucklerWeeklySession(envelope, new Date(startedAt)).storageState }
  catch { /* Invalid and missing Secrets share a fixed public status. */ }
  finally { envelope = undefined }

  let report: ParallelFetchReport
  if (!storageState) report = failedReport('session-unavailable')
  else {
    const controller = new AbortController()
    let timedOut = false
    let session: ParallelFetchBrowserSession | undefined
    let closing: Promise<void> | undefined
    const closeOwned = (): Promise<void> => {
      if (!session) return Promise.resolve()
      return closing ??= session.close().catch(() => {})
    }
    const abort = (): void => { controller.abort(); void closeOwned() }
    dependencies.signal?.addEventListener('abort', abort, { once: true })
    if (dependencies.signal?.aborted) abort()
    const disarm = (dependencies.armDeadline ?? ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds)
      timer.unref()
      return () => clearTimeout(timer)
    }))(() => { timedOut = true; abort() }, PARALLEL_FETCH_CLOUD_TIMEOUT_MS)
    try {
      if (controller.signal.aborted) throw new ParallelFetchReadError('cancelled')
      session = await (dependencies.openBrowser ?? createParallelFetchBrowserSession)({ intervalMs: config.intervalMs, signal: controller.signal }, {
        loadSession: async () => {
          if (!storageState) throw new ParallelFetchReadError('session-unavailable')
          const value = storageState
          storageState = undefined
          return value
        },
      })
      storageState = undefined
      if (controller.signal.aborted) throw new ParallelFetchReadError('cancelled')
      report = parseParallelFetchReport(await (dependencies.run ?? runParallelFetch)(config, {
        runId, signal: controller.signal, wallNow: () => timestamp(now),
        createReader: (worker, target, signal, intervalMs) => session!.createReader(worker, target, signal, intervalMs),
      }))
      if (report.state === 'running' || report.runId !== runId || !sameParallelFetchConfig(report.config, config)) throw new Error()
      if (timedOut) report = parseParallelFetchReport({ ...report, state: 'error', errorCode: 'timeout' })
    } catch (error) {
      report = failedReport(timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : safeReadCode(error))
    } finally {
      storageState = undefined
      disarm()
      dependencies.signal?.removeEventListener('abort', abort)
      await closeOwned()
    }
  }

  try {
    await (dependencies.saveReport ?? createParallelFetchReportWriter())(report)
    await (dependencies.artifactReady ?? (() => markRankDistributionArtifactReady(env)))()
    return { report, succeeded: report.state === 'complete', artifactReady: true, outputError: null }
  } catch {
    return { report, succeeded: false, artifactReady: false, outputError: 'report-save-failed' }
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { consumeSession(process.env); console.log(HELP); return }
  const controller = new AbortController()
  const interrupt = (): void => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const result = await runParallelFetchCloudTest(args, { signal: controller.signal })
    // Fixed keys and validated scalar values only; neither reports nor raw exceptions are logged.
    console.log(JSON.stringify({ runId: result.report.runId, state: result.report.state, errorCode: result.report.errorCode,
      completedPages: result.report.trials.reduce((sum, trial) => sum + trial.completedPages.length, 0),
      attempts: result.report.trials.reduce((sum, trial) => sum + trial.attempts.length, 0),
      artifactReady: result.artifactReady, outputError: result.outputError }))
    if (!result.succeeded) process.exitCode = 2
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof ParallelFetchCloudError ? error.message : 'クラウド取得テストを完了できませんでした。')
    process.exitCode = 1
  })
}
