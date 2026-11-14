import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLegendRankedMatchSupplement } from '../src/lib/legendPlayers.ts'
import type { LegendCollectionRun } from '../src/lib/legendCollectionHistory.ts'
import type { LegendRankedMatchSupplement } from '../src/types/legendPlayers.ts'
import { isAllowedLegendDailyExecution, legendDailyIncludesPlayers, LegendDailyError } from './collect-legend-analysis-daily.ts'
import { runLegendRankedMatchCollection, summarizeLegendAnalysisCaptureReport } from './collect-legend-analysis.ts'
import type { LegendAnalysisSafeCaptureReport } from './collect-legend-analysis.ts'
import { disableRankDistributionDiagnostics } from './collect-rank-distribution.ts'
import { markRankDistributionArtifactReady, rankDistributionCloudBrowserEnvironment } from './collect-rank-distribution-cloud.ts'
import { parseBucklerWeeklySession, BUCKLER_WEEKLY_SESSION_SECRET } from './lib/buckler-weekly-session.ts'
import { distributionHumanVerificationKind } from './lib/distribution-human-verification.ts'
import { checkLegendAnalysisParents } from './lib/legend-analysis-files.ts'
import { appendLegendActionsOutput } from './lib/legend-collection-run.ts'
import { readLegendMatchRanking, readPublishedLegendMatchResult, writeLegendMatchResult } from './lib/legend-ranked-match-history.ts'
import { LEGEND_DAILY_HISTORY_ROOT } from './publish-legend-analysis-daily.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MATCH_OUTPUT = resolve(ROOT, '.local/legend-analysis-daily/match-output/result.json')
type Environment = Record<string, string | undefined>
type MatchResult = { datasetId: string; reason: LegendCollectionRun['reason'] }

export async function runLegendRankedMatchesDaily(dependencies: {
  env?: Environment
  history?: string
  output?: string
  now?: () => Date
  collect?: typeof runLegendRankedMatchCollection
  artifactReady?: (env: Environment) => Promise<void>
  recordResult?: (env: Environment, result: MatchResult) => Promise<void>
  logReport?: (report: LegendAnalysisSafeCaptureReport) => void
} = {}): Promise<boolean> {
  const env = dependencies.env ?? process.env
  const raw = env[BUCKLER_WEEKLY_SESSION_SECRET]
  delete env[BUCKLER_WEEKLY_SESSION_SECRET]
  disableRankDistributionDiagnostics(env)
  if (!isAllowedLegendDailyExecution(env)) throw new LegendDailyError('runner')
  if (!legendDailyIncludesPlayers(env)) throw new LegendDailyError('players-setting')

  const history = dependencies.history ?? LEGEND_DAILY_HISTORY_ROOT
  const ranking = await readLegendMatchRanking(history, env)
  let supplement = await readPublishedLegendMatchResult(history, ranking)
  // A failed-job rerun must not resume source reads after the original collection was stopped.
  if (!supplement && env.LEGEND_COLLECTION_ATTEMPT !== env.GITHUB_RUN_ATTEMPT) return false
  let reason: MatchResult['reason'] = supplement?.rankedMatchAvailability?.reason ?? null
  if (!supplement) {
    const now = (dependencies.now ?? (() => new Date()))()
    let session
    try { session = parseBucklerWeeklySession(raw ?? '', now) } catch {
      reason = 'authentication-unavailable'
      const checkedAt = now.toISOString()
      supplement = { schemaVersion: 1, datasetId: ranking.id, generatedAt: checkedAt,
        rankedMatchAvailability: { status: 'unavailable', reason, checkedAt } }
    }
    if (session) {
      try {
        const result = await (dependencies.collect ?? runLegendRankedMatchCollection)({ ranking, storageState: session.storageState,
          browserEnvironment: rankDistributionCloudBrowserEnvironment(env) })
        const report = summarizeLegendAnalysisCaptureReport(result.report)
        const logReport = dependencies.logReport ?? (report => console.log(JSON.stringify({ profiles: report })))
        logReport(report)
        supplement = result.supplement
        if (!result.succeeded) {
          reason = distributionHumanVerificationKind(report.humanVerification) ?? report.reason
            ?? supplement?.rankedMatchAvailability?.reason ?? 'collection-failed'
        }
      } catch {
        reason = 'collection-failed'
      }
    }
  }

  const record = dependencies.recordResult ?? ((env, result) => appendLegendActionsOutput(env, 'match_collection_result', result))
  await record(env, { datasetId: ranking.id, reason })
  if (supplement) {
    const verified = parseLegendRankedMatchSupplement(supplement, ranking)
    if (Boolean(verified.rankedMatchAvailability) !== (reason !== null)) throw new LegendDailyError('output')
    const output = dependencies.output ?? MATCH_OUTPUT
    await checkLegendAnalysisParents(dirname(output))
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await writeLegendMatchResult(output, verified)
    await (dependencies.artifactReady ?? markRankDistributionArtifactReady)(env)
  }
  return Boolean(supplement) && reason === null
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) {
      delete process.env[BUCKLER_WEEKLY_SESSION_SECRET]
      throw new LegendDailyError('arguments')
    }
    if (!await runLegendRankedMatchesDaily()) {
      console.error('レジェンド帯の対戦数取得を完了できませんでした。')
      process.exitCode = 1
    }
  } catch {
    console.error('レジェンド帯の対戦数を取得または保存できませんでした。')
    process.exitCode = 1
  }
}
