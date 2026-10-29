import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSampleSurveyConfig, parseSampleSurveyPlan, parseSampleSurveyRun } from '../src/lib/sampleSurvey.ts'
import type { SampleSurveyConfig, SampleSurveyRun } from '../src/types/sampleSurvey.ts'
import { disableRankDistributionDiagnostics } from './collect-rank-distribution.ts'
import { markRankDistributionArtifactReady, rankDistributionCloudBrowserEnvironment } from './collect-rank-distribution-cloud.ts'
import { BUCKLER_WEEKLY_SESSION_SECRET, parseBucklerWeeklySession } from './lib/buckler-weekly-session.ts'
import { createSampleSurveyReader } from './lib/sample-survey-browser.ts'
import { SampleSurveyReadError } from './lib/sample-survey-reader.ts'
import type { SampleSurveyReader } from './lib/sample-survey-reader.ts'
import { runSampleSurvey } from './lib/sample-survey-runner.ts'
import { publishableSampleSurveyRun, validateSampleSurveyResultsDirectory, writeSampleSurveyResults } from './lib/sample-survey-publication.ts'

type Environment = Record<string, string | undefined>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SAMPLE_SURVEY_CLOUD_OUTPUT = resolve(ROOT, '.local/sample-survey-cloud/output/public/data/sample-survey')
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
    if (config.maxDurationMinutes > 120) throw new Error()
    return config
  } catch { throw new SampleSurveyCloudError('arguments') }
}
export async function runSampleSurveyCloud(dependencies: {
  env?: Environment; now?: () => Date; signal?: AbortSignal
  createReader?: typeof createSampleSurveyReader; collect?: typeof runSampleSurvey
  write?: typeof writeSampleSurveyResults; validate?: typeof validateSampleSurveyResultsDirectory
  artifactReady?: (env: Environment) => Promise<void>; logReport?: (report: SampleSurveyRun) => void
} = {}): Promise<{ succeeded: boolean; report: SampleSurveyRun }> {
  const env = dependencies.env ?? process.env
  let raw = env[BUCKLER_WEEKLY_SESSION_SECRET]
  delete env[BUCKLER_WEEKLY_SESSION_SECRET]
  disableRankDistributionDiagnostics(env)
  if (!isAllowedSampleSurveyCloudExecution(env)) throw new SampleSurveyCloudError('runner')
  const config = parseSampleSurveyCloudConfig(env), now = dependencies.now ?? (() => new Date())
  let session: ReturnType<typeof parseBucklerWeeklySession> | undefined
  try { session = parseBucklerWeeklySession(raw ?? '', now()) }
  catch { throw new SampleSurveyCloudError('session') }
  finally { raw = undefined }
  const plan = parseSampleSurveyPlan({ schemaVersion: 1, id: randomUUID(), createdAt: now().toISOString(), seed: randomBytes(32).toString('hex'), config })
  const controller = new AbortController()
  const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new SampleSurveyReadError('limit-reached')), config.maxDurationMinutes * 60_000)
  timer.unref()
  let reader: SampleSurveyReader | undefined, report: SampleSurveyRun
  try {
    if (signal.aborted) throw new SampleSurveyReadError('cancelled')
    const browserEnvironment = rankDistributionCloudBrowserEnvironment(env)
    reader = await (dependencies.createReader ?? createSampleSurveyReader)({ signal }, { browser: {
      loadSession: async () => {
        if (!session) throw new SampleSurveyReadError('session-unavailable')
        return session.storageState
      },
      launch: async () => {
        const { chromium } = await import('playwright')
        return chromium.launch({ channel: 'msedge', headless: false, timeout: 30000, env: browserEnvironment })
      },
    } })
    // The runner's IDs, sampled positions, and checkpoint remain in memory only.
    report = parseSampleSurveyRun((await (dependencies.collect ?? runSampleSurvey)(plan, { reader, signal, now: () => now().getTime() })).report)
  } catch { throw new SampleSurveyCloudError('collection') }
  finally { clearTimeout(timer); await reader?.close().catch(() => {}); session = undefined }
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
  if (args.length === 1 && args[0] === '--help') {
    delete process.env[BUCKLER_WEEKLY_SESSION_SECRET]
    console.log('標本調査の手動Actions取得。--collect で実行。認証と個別データはメモリ内、取得手順が完了した集計JSONを品質状態とともに公開します。')
    return
  }
  if (args.length !== 1 || args[0] !== '--collect') {
    delete process.env[BUCKLER_WEEKLY_SESSION_SECRET]
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
