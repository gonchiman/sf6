import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSampleSurveyConfig, parseSampleSurveyPlan, parseSampleSurveyRun } from '../src/lib/sampleSurvey.ts'
import type { SampleSurveyConfig, SampleSurveyRun } from '../src/types/sampleSurvey.ts'
import { disableRankDistributionDiagnostics } from './collect-rank-distribution.ts'
import { markRankDistributionArtifactReady, rankDistributionCloudBrowserEnvironment } from './collect-rank-distribution-cloud.ts'
import { BUCKLER_WEEKLY_SESSION_SECRET, parseBucklerWeeklySession } from './lib/buckler-weekly-session.ts'
import { createSampleSurveyReader } from './lib/sample-survey-browser.ts'
import { serializeSampleSurveyFailureDiagnostic, serializeSampleSurveyReadRetry } from './lib/sample-survey-diagnostics.ts'
import { SampleSurveyReadError } from './lib/sample-survey-reader.ts'
import type { SampleSurveyReader } from './lib/sample-survey-reader.ts'
import { canResumeSampleSurvey, canRecoverSampleSurveyAuthentication, createSampleSurveyCheckpoint, runSampleSurvey } from './lib/sample-survey-runner.ts'
import type { SampleSurveyCheckpoint } from './lib/sample-survey-runner.ts'
import { SAMPLE_SURVEY_CHECKPOINT_KEY_SECRET, finalizeSampleSurveyCloudCheckpoint, loadSampleSurveyCloudCheckpointBundle, saveSampleSurveyCloudCheckpoint } from './lib/sample-survey-cloud-checkpoint.ts'
import type { SampleSurveyCheckpointContext } from './lib/sample-survey-cloud-checkpoint.ts'
import { parseSampleSurveyRecovery } from './lib/sample-survey-production-source.ts'
import { publishableSampleSurveyRun, validateSampleSurveyResultsDirectory, writeSampleSurveyResults } from './lib/sample-survey-publication.ts'

type Environment = Record<string, string | undefined>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SAMPLE_SURVEY_CLOUD_OUTPUT = resolve(ROOT, '.local/sample-survey-cloud/output/public/data/sample-survey')
export const SAMPLE_SURVEY_CHECKPOINT_OUTPUT = resolve(ROOT, '.local/sample-survey-cloud/checkpoint-output/checkpoint.enc.json')
export const SAMPLE_SURVEY_CHECKPOINT_MANIFEST = resolve(ROOT, '.local/sample-survey-cloud/checkpoint-output/manifest.json')
export const SAMPLE_SURVEY_CHECKPOINT_INPUT = resolve(ROOT, '.local/sample-survey-cloud/checkpoint-input/checkpoint.enc.json')
export class SampleSurveyCloudError extends Error {
  readonly code: 'arguments' | 'runner' | 'session' | 'collection' | 'output'
  constructor(code: SampleSurveyCloudError['code']) {
    super({ arguments: '標本調査のActions入力が不正です。', runner: '固定mainの手動workflowによるGitHub hosted Windows実行が必要です。',
      session: '標本取得用の保存認証を確認できません。', collection: '標本調査を完了できませんでした。', output: '標本調査の集計出力を確認できません。' }[code])
    this.name = 'SampleSurveyCloudError'; this.code = code
  }
}
export function isAllowedSampleSurveyCloudExecution(env: Environment): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Windows'
    && env.GITHUB_REPOSITORY === 'gonchiman/sf6' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_WORKFLOW_REF === 'gonchiman/sf6/.github/workflows/sample-survey.yml@refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
}
export function parseSampleSurveyCloudConfig(env: Environment): SampleSurveyConfig {
  try {
    const number = (value: string | undefined, fallback: string) => {
      const text = value ?? fallback
      if (!/^[1-9][0-9]{0,3}$/.test(text)) throw new Error()
      return Number(text)
    }
    const mr = env.SAMPLE_SURVEY_INCLUDE_MR ?? 'false', ranks = env.SAMPLE_SURVEY_RANKS ?? 'MASTER'
    if (!['true', 'false'].includes(mr) || ranks.length > 100) throw new Error()
    const config = parseSampleSurveyConfig({ ranks: ranks === '' ? [] : ranks.split(',').map(rank => rank.trim()),
      rankSampleSize: number(env.SAMPLE_SURVEY_RANK_SAMPLE_SIZE, '10'), includeMr: mr === 'true',
      mrSampleSize: number(env.SAMPLE_SURVEY_MR_SAMPLE_SIZE, '10'), maxDurationMinutes: number(env.SAMPLE_SURVEY_MAX_DURATION_MINUTES, '10') })
    const maximumMinutes = config.ranks.length === 0 && config.includeMr ? 180 : 120
    if (config.maxDurationMinutes > maximumMinutes) throw new Error()
    return config
  } catch { throw new SampleSurveyCloudError('arguments') }
}
export function parseSampleSurveyExecutionBudget(env: Environment, config: SampleSurveyConfig): number {
  const raw = env.SAMPLE_SURVEY_EXECUTION_BUDGET_MINUTES
  if (!raw) return config.maxDurationMinutes
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > config.maxDurationMinutes) throw new SampleSurveyCloudError('arguments')
  return Number(raw)
}
export async function runSampleSurveyCloud(dependencies: {
  env?: Environment; now?: () => Date; signal?: AbortSignal
  createReader?: typeof createSampleSurveyReader; collect?: typeof runSampleSurvey
  write?: typeof writeSampleSurveyResults; validate?: typeof validateSampleSurveyResultsDirectory
  artifactReady?: (env: Environment) => Promise<void>; logReport?: (report: SampleSurveyRun) => void
  logFailureDiagnostic?: (line: string) => void | Promise<void>
  logReadRetry?: (line: string) => void
  logAuthenticationVerified?: (line: string) => void
  saveCheckpoint?: (checkpoint: SampleSurveyCheckpoint, context: SampleSurveyCheckpointContext, key: string, path: string) => Promise<unknown>
  loadCheckpoint?: typeof loadSampleSurveyCloudCheckpointBundle
} = {}): Promise<{ succeeded: boolean; report: SampleSurveyRun }> {
  const env = dependencies.env ?? process.env
  let raw = env[BUCKLER_WEEKLY_SESSION_SECRET]
  let checkpointKey = env[SAMPLE_SURVEY_CHECKPOINT_KEY_SECRET]
  delete env[BUCKLER_WEEKLY_SESSION_SECRET]
  delete env[SAMPLE_SURVEY_CHECKPOINT_KEY_SECRET]
  disableRankDistributionDiagnostics(env)
  if (!isAllowedSampleSurveyCloudExecution(env)) throw new SampleSurveyCloudError('runner')
  const config = parseSampleSurveyCloudConfig(env), now = dependencies.now ?? (() => new Date())
  const executionBudget = parseSampleSurveyExecutionBudget(env, config)
  const sourceSha = env.SAMPLE_SURVEY_SOURCE_SHA || env.GITHUB_SHA, runId = env.GITHUB_RUN_ID
  const resumeRunId = env.SAMPLE_SURVEY_RESUME_RUN_ID || ''
  const recovery = parseSampleSurveyRecovery(env)
  if (!sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha) || !runId || !/^[1-9]\d{0,14}$/.test(runId)
    || env.GITHUB_RUN_ATTEMPT !== '1' || resumeRunId && (!/^[1-9]\d{0,14}$/.test(resumeRunId) || resumeRunId === runId)
    || !checkpointKey || !/^[A-Za-z0-9+/]{43}=$/.test(checkpointKey)
    || Buffer.from(checkpointKey, 'base64').toString('base64') !== checkpointKey) throw new SampleSurveyCloudError('arguments')
  let saved: SampleSurveyCheckpoint | undefined, resumeDepth = 0
  if (resumeRunId) {
    try {
      const restored = await (dependencies.loadCheckpoint ?? loadSampleSurveyCloudCheckpointBundle)(SAMPLE_SURVEY_CHECKPOINT_INPUT, checkpointKey,
        { sourceSha: recovery.resumeSourceSha ?? sourceSha, runId: resumeRunId, runAttempt: 1, config })
      const { manifest, checkpoint } = restored, time = now().getTime()
      const permitted = recovery.recoverAuthentication ? canRecoverSampleSurveyAuthentication(checkpoint)
        : checkpoint.report.resumeAllowed && canResumeSampleSurvey(checkpoint)
      if (!permitted || manifest.resumeDepth >= 6
        || Date.parse(manifest.startedAt) < time - 72 * 60 * 60_000
        || Date.parse(manifest.checkpointAt) > time - 5 * 60_000) throw new Error()
      saved = checkpoint; resumeDepth = manifest.resumeDepth + 1
    } catch { throw new SampleSurveyCloudError('collection') }
  }
  let session: ReturnType<typeof parseBucklerWeeklySession> | undefined
  try { session = parseBucklerWeeklySession(raw ?? '', now()) }
  catch { throw new SampleSurveyCloudError('session') }
  finally { raw = undefined }
  const plan = saved?.plan ?? parseSampleSurveyPlan({ schemaVersion: 1, id: randomUUID(), createdAt: now().toISOString(), seed: randomBytes(32).toString('hex'), config })
  const context: SampleSurveyCheckpointContext = { sourceSha, runId, runAttempt: 1, resumeDepth }
  const onUpdate = async (checkpoint: SampleSurveyCheckpoint): Promise<void> => {
    if (!checkpointKey) throw new SampleSurveyCloudError('output')
    await (dependencies.saveCheckpoint ?? saveSampleSurveyCloudCheckpoint)(checkpoint, context, checkpointKey, SAMPLE_SURVEY_CHECKPOINT_OUTPUT)
  }
  const controller = new AbortController()
  const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new SampleSurveyReadError('limit-reached')), executionBudget * 60_000)
  timer.unref()
  let failureRecorded = false
  const onReadFailure = async (diagnostic: unknown): Promise<void> => {
    if (failureRecorded) return
    failureRecorded = true
    try {
      const line = serializeSampleSurveyFailureDiagnostic(diagnostic)
      if (line !== null) await (dependencies.logFailureDiagnostic ?? (value => console.log(value)))(line)
    } catch { /* Logging cannot replace the original collection failure or trigger another read. */ }
  }
  const retriesRecorded = new Set<number>()
  const verifiedTargets = new Set<string>()
  const onAuthenticationVerified = (value: unknown): void => {
    try {
      if (!value || typeof value !== 'object') return
      const { target, page, observedAt, evidence } = value as Record<string, unknown>
      if ((target !== 'lp' && target !== 'mr') || !Number.isSafeInteger(page) || Number(page) < 1
        || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))
        || new Date(observedAt).toISOString() !== observedAt || evidence !== 'logout-control' || verifiedTargets.has(target)) return
      verifiedTargets.add(target)
      ;(dependencies.logAuthenticationVerified ?? (line => console.log(line)))(JSON.stringify({
        sampleSurveyAuthenticationVerified: { target, page, observedAt, evidence },
      }))
    } catch { /* A diagnostic must not affect collection or expose an arbitrary payload. */ }
  }
  const onReadRetry = (event: unknown): void => {
    if (retriesRecorded.size >= 3) return
    const line = serializeSampleSurveyReadRetry(event)
    if (line === null) return
    // Use the reconstructed event, never re-read caller properties after validation.
    const retryNumber: number = JSON.parse(line).sampleSurveyReadRetry.retryNumber
    if (retriesRecorded.has(retryNumber)) return
    retriesRecorded.add(retryNumber)
    try { (dependencies.logReadRetry ?? (value => console.log(value)))(line) }
    catch { /* Reporting cannot affect the bounded retry or disclose an exception. */ }
  }
  let reader: SampleSurveyReader | undefined, report: SampleSurveyRun
  try {
    if (signal.aborted) throw new SampleSurveyReadError('cancelled')
    const initial = saved ? structuredClone(saved) : createSampleSurveyCheckpoint(plan, now().getTime())
    if (saved) {
      Object.assign(initial.report, { state: 'preparing', phase: 'boundaries', updatedAt: now().toISOString(), finishedAt: null, stopReason: null, resumeAllowed: false })
      delete initial.transientFailure
    }
    // Manual auth recovery keeps the old checkpoint untouched until a fresh signed-in read succeeds.
    if (!recovery.recoverAuthentication) await onUpdate(initial)
    const browserEnvironment = rankDistributionCloudBrowserEnvironment(env)
    reader = await (dependencies.createReader ?? createSampleSurveyReader)({ signal, onReadFailure, onAuthenticationVerified }, { browser: {
      loadSession: async () => {
        if (!session) throw new SampleSurveyReadError('session-unavailable')
        return session.storageState
      },
      launch: async () => {
        const { chromium } = await import('playwright')
        return chromium.launch({ channel: 'msedge', headless: false, timeout: 30000, env: browserEnvironment })
      },
    } })
    // Persist the fixed sample and progress encrypted; public output remains aggregate-only.
    report = parseSampleSurveyRun((await (dependencies.collect ?? runSampleSurvey)(plan, { reader, signal, now: () => now().getTime(), onReadRetry,
      onUpdate, checkpoint: saved, maxInvocationMinutes: executionBudget,
      recoverAuthentication: recovery.recoverAuthentication,
      resetReadRetryBudget: !!saved?.transientFailure || recovery.recoverAuthentication })).report)
  } catch { throw new SampleSurveyCloudError('collection') }
  finally { clearTimeout(timer); await reader?.close().catch(() => {}); session = undefined; checkpointKey = undefined }
  ;(dependencies.logReport ?? (value => console.log(JSON.stringify({ capture: value }))))(report)
  try { publishableSampleSurveyRun(report) } catch { return { succeeded: false, report } }
  try {
    await (dependencies.write ?? writeSampleSurveyResults)([report], SAMPLE_SURVEY_CLOUD_OUTPUT, now().toISOString())
    await (dependencies.validate ?? validateSampleSurveyResultsDirectory)(SAMPLE_SURVEY_CLOUD_OUTPUT)
    await (dependencies.artifactReady ?? markRankDistributionArtifactReady)(env)
  } catch { throw new SampleSurveyCloudError('output') }
  return { succeeded: true, report }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--finalize-checkpoint') {
    delete process.env[BUCKLER_WEEKLY_SESSION_SECRET]; delete process.env[SAMPLE_SURVEY_CHECKPOINT_KEY_SECRET]
    if (!isAllowedSampleSurveyCloudExecution(process.env)) throw new SampleSurveyCloudError('runner')
    await finalizeSampleSurveyCloudCheckpoint(SAMPLE_SURVEY_CHECKPOINT_OUTPUT, SAMPLE_SURVEY_CHECKPOINT_MANIFEST)
    console.log('暗号化した途中記録の保存準備が完了しました。')
    return
  }
  if (args.length === 1 && args[0] === '--help') {
    delete process.env[BUCKLER_WEEKLY_SESSION_SECRET]
    delete process.env[SAMPLE_SURVEY_CHECKPOINT_KEY_SECRET]
    console.log('標本調査の手動Actions取得。--collect で実行。途中記録は暗号化して保存し、完了した集計JSONを公開します。')
    return
  }
  if (args.length !== 1 || args[0] !== '--collect') {
    delete process.env[BUCKLER_WEEKLY_SESSION_SECRET]
    delete process.env[SAMPLE_SURVEY_CHECKPOINT_KEY_SECRET]
    throw new SampleSurveyCloudError('arguments')
  }
  const controller = new AbortController(), stop = () => controller.abort(new SampleSurveyReadError('cancelled'))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const result = await runSampleSurveyCloud({ signal: controller.signal })
    const reviewRequired = result.report.schemaVersion === 2 && result.report.observation!.strata.some(row => row.status === 'review-required')
    console.log(result.succeeded
      ? reviewRequired ? '標本調査の取得処理が完了しました。要確認の層を含む観測期間中の集計を公開します。' : '標本調査の取得処理と集計が完了しました。'
      : '公開条件を満たさないため公開しません。以前の公開データを保持します。')
    if (!result.succeeded) process.exitCode = 1
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof SampleSurveyCloudError ? error.message : '標本取得を完了できませんでした。'); process.exitCode = 1 })
}
