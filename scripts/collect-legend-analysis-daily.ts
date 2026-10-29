import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runLegendAnalysisCollection, summarizeLegendAnalysisCaptureReport } from './collect-legend-analysis.ts'
import type { LegendAnalysisSafeCaptureReport } from './collect-legend-analysis.ts'
import { disableRankDistributionDiagnostics } from './collect-rank-distribution.ts'
import { markRankDistributionArtifactReady, rankDistributionCloudBrowserEnvironment } from './collect-rank-distribution-cloud.ts'
import { parseBucklerWeeklySession, BUCKLER_WEEKLY_SESSION_SECRET } from './lib/buckler-weekly-session.ts'
import { validateLegendDailyBundle } from './lib/legend-analysis-daily-bundle.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LEGEND_DAILY_OUTPUT = resolve(ROOT, '.local/legend-analysis-daily/output')
type Environment = Record<string, string | undefined>

export class LegendDailyError extends Error {
  readonly code: 'arguments' | 'runner' | 'players-setting' | 'session' | 'collection' | 'output'
  constructor(code: LegendDailyError['code']) {
    super({ arguments: '--collect または --help を指定してください。', runner: '固定mainの日次workflowによるGitHub hosted Windows実行が必要です。',
      'players-setting': 'プレイヤー一覧の取得設定を確認できません。',
      session: '日次取得用の保存認証を確認できません。', collection: 'レジェンド帯データの取得を完了できませんでした。', output: '日次取得の集計出力を確認できません。' }[code])
    this.name = 'LegendDailyError'
    this.code = code
  }
}

/** The workflow resolves manual input or the daily opt-in; any other value fails closed. */
export function legendDailyIncludesPlayers(env: Environment): boolean {
  if (env.LEGEND_PLAYERS_ENABLED === 'true') return true
  if (env.LEGEND_PLAYERS_ENABLED === 'false') return false
  throw new LegendDailyError('players-setting')
}

export function isAllowedLegendDailyExecution(env: Environment): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Windows'
    && env.GITHUB_REPOSITORY === 'gonchiman/sf6' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_WORKFLOW_REF === 'gonchiman/sf6/.github/workflows/legend-analysis-daily.yml@refs/heads/main'
    && ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')
}

export async function runLegendDaily(dependencies: {
  env?: Environment
  now?: () => Date
  collect?: typeof runLegendAnalysisCollection
  validate?: typeof validateLegendDailyBundle
  artifactReady?: (env: Environment) => Promise<void>
  logReport?: (report: LegendAnalysisSafeCaptureReport) => void
} = {}): Promise<{ succeeded: boolean }> {
  const env = dependencies.env ?? process.env
  const raw = env[BUCKLER_WEEKLY_SESSION_SECRET]
  delete env[BUCKLER_WEEKLY_SESSION_SECRET]
  disableRankDistributionDiagnostics(env)
  if (!isAllowedLegendDailyExecution(env)) throw new LegendDailyError('runner')
  const includePlayers = legendDailyIncludesPlayers(env)
  let session
  try { session = parseBucklerWeeklySession(raw ?? '', (dependencies.now ?? (() => new Date()))()) }
  catch { throw new LegendDailyError('session') }
  let result
  try {
    result = await (dependencies.collect ?? runLegendAnalysisCollection)({ storageState: session.storageState,
      outputDirectory: LEGEND_DAILY_OUTPUT, includePlayers, browserEnvironment: rankDistributionCloudBrowserEnvironment(env) })
  } catch { throw new LegendDailyError('collection') }
  const safeReport = summarizeLegendAnalysisCaptureReport(result.report)
  const logReport = dependencies.logReport ?? (report => console.log(JSON.stringify({ capture: report })))
  logReport(safeReport)
  try {
    await (dependencies.validate ?? validateLegendDailyBundle)(resolve(LEGEND_DAILY_OUTPUT, 'public'), includePlayers)
    await (dependencies.artifactReady ?? markRankDistributionArtifactReady)(env)
  } catch { throw new LegendDailyError('output') }
  return { succeeded: result.succeeded }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('レジェンド帯の日次取得。固定mainのGitHub hosted Windows専用。--collect で保存認証をメモリ内だけで再利用し、集計JSONと、有効化された場合はプレイヤー一覧を用意します。')
    return
  }
  if (args.length !== 1 || args[0] !== '--collect') {
    delete process.env[BUCKLER_WEEKLY_SESSION_SECRET]
    throw new LegendDailyError('arguments')
  }
  const result = await runLegendDaily()
  console.log(result.succeeded ? 'レジェンド帯の集計を完了しました。' : '取得に失敗しました。前回の正常データを維持する取得状況を保存しました。')
  if (!result.succeeded) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof LegendDailyError ? error.message : '日次取得を完了できませんでした。'); process.exitCode = 1 })
}
