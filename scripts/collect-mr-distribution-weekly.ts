import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MR_DISTRIBUTION_SOURCE, parseMrDistributionDataset, parseMrDistributionManifest } from '../src/lib/mrDistribution.ts'
import type { MrDistributionDataset } from '../src/types/mrDistribution.ts'
import { launchMrDistributionEdge, parseMrDistributionCaptureArguments, runMrDistributionCollection } from './collect-mr-distribution.ts'
import type { MrDistributionCaptureDependencies, MrDistributionCaptureDiagnostics, MrDistributionCaptureReport } from './collect-mr-distribution.ts'
import { disableRankDistributionDiagnostics } from './collect-rank-distribution.ts'
import { markRankDistributionArtifactReady, rankDistributionCloudBrowserEnvironment } from './collect-rank-distribution-cloud.ts'
import { BUCKLER_WEEKLY_SESSION_SECRET, parseBucklerWeeklySession } from './lib/buckler-weekly-session.ts'
import { mrDistributionPathWithin, validateMrDistributionDirectory } from './validate-mr-distribution-data.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MR_WEEKLY_OUTPUT = resolve(ROOT, '.local/mr-distribution-weekly/output')
type Environment = Record<string, string | undefined>

export class MrWeeklyError extends Error {
  readonly code: 'arguments' | 'runner' | 'report' | 'output'
  constructor(code: MrWeeklyError['code']) {
    super({ arguments: '--collect [--max-requests 2〜600] または --help を指定してください。',
      runner: '固定mainのMR週次workflowによるGitHub hosted Windows実行が必要です。',
      report: 'MR取得の実行記録を検証できません。', output: 'MR取得の集計出力を確認できません。' }[code])
    this.name = 'MrWeeklyError'; this.code = code
  }
}

export interface MrWeeklyRunReport {
  schemaVersion: 1
  id: string
  startedAt: string
  endedAt: string
  event: 'manual' | 'schedule'
  status: 'succeeded' | 'failed'
  failureReason: null | 'authentication-unavailable' | 'collection-failed' | 'output-unavailable'
  datasetId: string | null
  capture: MrDistributionCaptureReport | null
}

function reject(): never { throw new MrWeeklyError('report') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject()
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || Object.keys(result).some(key => !keys.includes(key))) reject()
  return result
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) reject()
  return value
}
function oneOf<T extends string | null>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) reject()
  return value as T
}
function count(value: unknown, maximum = 600): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) reject()
  return value
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') reject(); return value }
function datasetId(value: unknown): string {
  if (typeof value !== 'string' || !/^max-mr-estimate-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(value)) reject()
  return value
}

function parseCaptureDiagnostics(value: unknown): MrDistributionCaptureDiagnostics {
  const item = record(value, ['lastAttemptedPage', 'lastSuccessfulPage', 'lastHttpStatus', 'lastAuthenticationEvidence',
    'lastLoginRequiredHeading', 'lastRankingReadable'])
  const page = (value: unknown): number | null => {
    if (value === null) return null
    const result = count(value, Number.MAX_SAFE_INTEGER)
    if (result < 1) reject()
    return result
  }
  const status = item.lastHttpStatus === null ? null : count(item.lastHttpStatus, 599)
  if (status !== null && status < 100) reject()
  return { lastAttemptedPage: page(item.lastAttemptedPage), lastSuccessfulPage: page(item.lastSuccessfulPage), lastHttpStatus: status,
    lastAuthenticationEvidence: oneOf(item.lastAuthenticationEvidence, [null, 'logout-control', 'login-control', 'conflicting-controls', 'no-control']),
    lastLoginRequiredHeading: item.lastLoginRequiredHeading === null ? null : bool(item.lastLoginRequiredHeading),
    lastRankingReadable: item.lastRankingReadable === null ? null : bool(item.lastRankingReadable) }
}

function parseCapture(value: unknown): MrDistributionCaptureReport {
  const hasDiagnostics = value !== null && typeof value === 'object' && Object.hasOwn(value, 'diagnostics')
  const item = record(value, ['schemaVersion', 'status', 'startedAt', 'endedAt', 'stage', 'reason', 'readFailureCode',
    'requestCount', 'successfulReadCount', 'retryCount', 'confirmedBoundaryCount', 'datasetSaved', 'imported', 'browserClosed',
    'initialSignInConfirmed', 'readableWithoutSignInReadCount', ...(hasDiagnostics ? ['diagnostics'] : [])])
  if (item.schemaVersion !== 1) reject()
  const result: MrDistributionCaptureReport = {
    schemaVersion: 1, status: oneOf(item.status, ['succeeded', 'failed']), startedAt: time(item.startedAt), endedAt: time(item.endedAt),
    stage: oneOf(item.stage, ['authentication', 'browser-launch', 'collection', 'dataset-save', 'import', 'complete']),
    reason: oneOf(item.reason, [null, 'authentication-unavailable', 'browser-unavailable', 'collection-failed', 'dataset-save-failed', 'import-failed', 'cancelled', 'time-limit', 'request-limit']),
    readFailureCode: oneOf(item.readFailureCode, [null, 'invalid-request', 'concurrent-read', 'first-page-required', 'cancelled', 'http-denied', 'server-error',
      'http-error', 'maintenance', 'login-required', 'authentication-unconfirmed', 'human-verification', 'condition-mismatch', 'page-mismatch', 'unsupported-dom', 'timeout', 'read-failed']),
    requestCount: count(item.requestCount), successfulReadCount: count(item.successfulReadCount), retryCount: count(item.retryCount),
    confirmedBoundaryCount: count(item.confirmedBoundaryCount, 25), datasetSaved: bool(item.datasetSaved), imported: bool(item.imported),
    browserClosed: bool(item.browserClosed), initialSignInConfirmed: bool(item.initialSignInConfirmed), readableWithoutSignInReadCount: count(item.readableWithoutSignInReadCount),
    ...(hasDiagnostics ? { diagnostics: parseCaptureDiagnostics(item.diagnostics) } : {}),
  }
  if (Date.parse(result.startedAt) > Date.parse(result.endedAt) || result.successfulReadCount > result.requestCount
    || result.retryCount > result.requestCount || result.readableWithoutSignInReadCount > result.successfulReadCount || result.imported) reject()
  if (result.status === 'succeeded' && (result.reason !== null || result.stage !== 'complete' || !result.datasetSaved
    || !result.initialSignInConfirmed || result.confirmedBoundaryCount !== 25 || result.successfulReadCount < 1)) reject()
  if (result.status === 'failed' && result.reason === null) reject()
  return result
}

/** Only fixed classifications and bounded aggregate counters can reach logs or artifacts. */
export function parseMrWeeklyRunReport(value: unknown): MrWeeklyRunReport {
  const item = record(value, ['schemaVersion', 'id', 'startedAt', 'endedAt', 'event', 'status', 'failureReason', 'datasetId', 'capture'])
  if (item.schemaVersion !== 1 || typeof item.id !== 'string' || !/^run-[1-9]\d{0,24}-[1-9]\d{0,5}$/.test(item.id)) reject()
  const result: MrWeeklyRunReport = { schemaVersion: 1, id: item.id, startedAt: time(item.startedAt), endedAt: time(item.endedAt),
    event: oneOf(item.event, ['manual', 'schedule']), status: oneOf(item.status, ['succeeded', 'failed']),
    failureReason: oneOf(item.failureReason, [null, 'authentication-unavailable', 'collection-failed', 'output-unavailable']),
    datasetId: item.datasetId === null ? null : datasetId(item.datasetId), capture: item.capture === null ? null : parseCapture(item.capture) }
  if (Date.parse(result.startedAt) > Date.parse(result.endedAt)) reject()
  if (result.capture && (Date.parse(result.capture.startedAt) < Date.parse(result.startedAt) || Date.parse(result.capture.endedAt) > Date.parse(result.endedAt))) reject()
  if (result.status === 'succeeded' && (result.failureReason !== null || result.datasetId === null || result.capture?.status !== 'succeeded' || !result.capture.browserClosed)) reject()
  if (result.status === 'failed' && (result.failureReason === null || result.datasetId !== null)) reject()
  return result
}

export function isAllowedMrWeeklyExecution(env: Environment): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Windows'
    && env.GITHUB_REPOSITORY === 'gonchiman/sf6' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_WORKFLOW_REF === 'gonchiman/sf6/.github/workflows/mr-distribution-weekly.yml@refs/heads/main'
    && ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')
    && /^[1-9]\d{0,24}$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
}

async function checkParents(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error() }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
    if (current === dirname(current)) break
  }
}

/** A fresh output is promoted only after validating both the aggregate and its run record. */
export async function writeMrWeeklyOutput(input: { run: MrWeeklyRunReport; dataset?: MrDistributionDataset }, output = MR_WEEKLY_OUTPUT): Promise<void> {
  const run = parseMrWeeklyRunReport(input.run)
  const dataset = input.dataset === undefined ? undefined : parseMrDistributionDataset(input.dataset)
  if ((run.status === 'succeeded') !== !!dataset) throw new MrWeeklyError('output')
  if (dataset && (dataset.id !== run.datasetId || !run.capture || Date.parse(dataset.captureStartedAt) < Date.parse(run.capture.startedAt)
    || Date.parse(dataset.captureEndedAt) > Date.parse(run.capture.endedAt) || Date.parse(dataset.generatedAt) > Date.parse(run.endedAt))) throw new MrWeeklyError('output')
  const manifest = parseMrDistributionManifest({ schemaVersion: 1, generatedAt: run.endedAt, source: { ...MR_DISTRIBUTION_SOURCE },
    datasets: dataset ? [{ id: dataset.id, path: `${dataset.id}.json`, captureStartedAt: dataset.captureStartedAt, captureEndedAt: dataset.captureEndedAt, totalCount: dataset.totalCount }] : [],
    ...(!dataset ? { availability: { status: 'collection-failed', checkedAt: run.endedAt,
      message: run.failureReason === 'authentication-unavailable' ? '保存済みの認証状態を確認できませんでした。' : 'MR分布の取得を完了できませんでした。' } } : {}) })
  const destination = resolve(output), parent = dirname(destination)
  if (parent === destination) throw new MrWeeklyError('output')
  await checkParents(parent)
  await mkdir(parent, { recursive: true })
  try { await lstat(destination); throw new MrWeeklyError('output') }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
  const stage = await mkdtemp(resolve(parent, '.mr-output-'))
  if (!mrDistributionPathWithin(parent, stage)) throw new MrWeeklyError('output')
  let promoted = false
  try {
    await mkdir(resolve(stage, 'public'))
    await mkdir(resolve(stage, 'runs'))
    await writeFile(resolve(stage, 'public/index.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    if (dataset) await writeFile(resolve(stage, 'public', `${dataset.id}.json`), `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' })
    const runPath = resolve(stage, 'runs', `${run.id}.json`)
    await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' })
    await validateMrDistributionDirectory(resolve(stage, 'public'))
    parseMrWeeklyRunReport(JSON.parse(await readFile(runPath, 'utf8')))
    await rename(stage, destination)
    promoted = true
  } finally {
    if (!promoted && mrDistributionPathWithin(parent, stage)) await rm(stage, { recursive: true, force: true })
  }
}

export interface MrWeeklyDependencies {
  env?: Environment
  now?: () => Date
  signal?: AbortSignal
  collect?: typeof runMrDistributionCollection
  launch?: MrDistributionCaptureDependencies['launch']
  writeOutput?: typeof writeMrWeeklyOutput
  artifactReady?: (env: Environment) => Promise<void>
  progress?: (confirmed: number) => void
}

export async function runMrWeekly(args = ['--collect'], dependencies: MrWeeklyDependencies = {}): Promise<{
  run: MrWeeklyRunReport; succeeded: boolean; artifactReady: boolean
}> {
  const env = dependencies.env ?? process.env
  let raw = env[BUCKLER_WEEKLY_SESSION_SECRET]
  delete env[BUCKLER_WEEKLY_SESSION_SECRET]
  disableRankDistributionDiagnostics(env)
  let options
  try { options = parseMrDistributionCaptureArguments(args); if (options.mode !== 'collect' || options.import) throw new Error() }
  catch { raw = undefined; throw new MrWeeklyError('arguments') }
  if (!isAllowedMrWeeklyExecution(env)) { raw = undefined; throw new MrWeeklyError('runner') }
  const now = dependencies.now ?? (() => new Date())
  const startedAt = time(now().toISOString())
  let session, capture: MrDistributionCaptureReport | null = null, dataset: MrDistributionDataset | undefined
  let failureReason: MrWeeklyRunReport['failureReason'] = null
  try { session = parseBucklerWeeklySession(raw ?? '', new Date(startedAt)) }
  catch { failureReason = 'authentication-unavailable' }
  finally { raw = undefined }
  if (session) {
    try {
      const storageState = session.storageState
      const browserEnvironment = rankDistributionCloudBrowserEnvironment(env)
      const result = await (dependencies.collect ?? runMrDistributionCollection)(options, { loadSession: async () => storageState,
        launch: dependencies.launch ?? ((state, signal) => launchMrDistributionEdge(state, signal, browserEnvironment)),
        saveDataset: async value => { dataset = parseMrDistributionDataset(value); return 'validated-memory-aggregate' },
        now, signal: dependencies.signal, progress: dependencies.progress })
      capture = parseCapture(result)
      if (capture.status !== 'succeeded' || !capture.browserClosed || !dataset) { dataset = undefined; failureReason = 'collection-failed' }
    } catch { dataset = undefined; failureReason = 'collection-failed' }
    finally { session = undefined }
  }
  let run = parseMrWeeklyRunReport({ schemaVersion: 1, id: `run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    startedAt, endedAt: time(now().toISOString()), event: env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual',
    status: dataset ? 'succeeded' : 'failed', failureReason: dataset ? null : failureReason ?? 'collection-failed', datasetId: dataset?.id ?? null, capture })
  try {
    await (dependencies.writeOutput ?? writeMrWeeklyOutput)({ run, dataset })
    await (dependencies.artifactReady ?? markRankDistributionArtifactReady)(env)
    return { run, succeeded: run.status === 'succeeded', artifactReady: true }
  } catch {
    run = parseMrWeeklyRunReport({ ...run, status: 'failed', failureReason: 'output-unavailable', datasetId: null })
    return { run, succeeded: false, artifactReady: false }
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    delete process.env[BUCKLER_WEEKLY_SESSION_SECRET]
    disableRankDistributionDiagnostics(process.env)
    console.log('MR帯の週次取得。固定mainのGitHub hosted Windows専用。--collect [--max-requests 2〜600] で保存認証をメモリ内で使い、完成集計と安全な実行記録を保存します。')
    return
  }
  const controller = new AbortController(), interrupt = (): void => controller.abort()
  process.once('SIGINT', interrupt)
  try {
    const result = await runMrWeekly(args, { signal: controller.signal,
      progress: confirmedBoundaryCount => console.log(JSON.stringify({ confirmedBoundaryCount, requiredBoundaryCount: 25 })) })
    console.log(JSON.stringify(result.run))
    if (!result.succeeded) process.exitCode = 2
  } finally { process.removeListener('SIGINT', interrupt) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof MrWeeklyError ? error.message : 'MR帯の週次取得を完了できませんでした。'); process.exitCode = 1 })
}
