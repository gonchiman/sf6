import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { parseLegendCollectionHistory, type LegendCollectionRun } from '../../src/lib/legendCollectionHistory.ts'
import type { LegendAnalysisSafeCaptureReport } from '../collect-legend-analysis.ts'
import { distributionHumanVerificationKind } from './distribution-human-verification.ts'
import { checkLegendAnalysisParents, legendAnalysisFileInfo } from './legend-analysis-files.ts'

type Environment = Record<string, string | undefined>
type CollectionCapture = { report: LegendAnalysisSafeCaptureReport; entries: number | null }
type PreparationReason = 'authentication-unavailable' | 'collection-failed' | 'cancelled'

function runIdentity(env: Environment) {
  return {
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.LEGEND_COLLECTION_ATTEMPT || env.GITHUB_RUN_ATTEMPT),
    trigger: env.GITHUB_EVENT_NAME,
  }
}

function checkedRun(value: unknown): LegendCollectionRun {
  return parseLegendCollectionHistory({ schemaVersion: 1, runs: [value] }).runs[0]
}

export function buildLegendCollectionDraft(env: Environment, capture: CollectionCapture | undefined,
  reason: PreparationReason, now: string, options: { rankingOnly?: boolean } = {}): LegendCollectionRun {
  const common = { ...runIdentity(env), startedAt: env.LEGEND_COLLECTION_STARTED_AT || null, endedAt: now,
    lastAttemptedPage: null, datasetId: null, rankingCount: null, rankedMatchCount: null }
  if (!capture) return checkedRun({ ...common, outcome: 'stopped', phase: 'preparation', reason })

  const { report, entries } = capture
  const timing = { startedAt: report.startedAt ?? common.startedAt, endedAt: report.endedAt ?? now }
  const failure = distributionHumanVerificationKind(report.humanVerification) ?? report.reason ?? 'collection-failed'
  if (report.reason === 'output-unavailable' || (report.status !== 'failed' && entries === null)) {
    return checkedRun({ ...common, ...timing, outcome: 'save-failed', phase: 'saving', reason: 'output-unavailable' })
  }
  if (report.status === 'failed') {
    const phase = report.lastStep?.startsWith('profile-') || report.collectionPhase === 'complete' ? 'profiles'
      : report.collectionPhase === 'preparation' ? 'preparation' : 'listing'
    return checkedRun({ ...common, ...timing, outcome: 'stopped', phase, reason: failure,
      lastAttemptedPage: phase === 'listing' ? report.lastAttemptedPage : null })
  }
  if (options.rankingOnly && report.status === 'succeeded') {
    // A null reason on this internal draft means the ranking is ready and the profile job is pending.
    return checkedRun({ ...common, ...timing, outcome: 'partial', phase: 'profiles', reason: null,
      datasetId: report.datasetId, rankingCount: entries, rankedMatchCount: 0 })
  }
  const partial = report.status === 'partial'
  return checkedRun({ ...common, ...timing, outcome: report.status, phase: partial ? 'profiles' : 'complete',
    reason: partial ? failure : null, datasetId: report.datasetId, rankingCount: entries, rankedMatchCount: partial ? 0 : entries })
}

/** Only the compact allowlisted record can enter the runner's existing output file. */
export async function writeLegendCollectionDraft(env: Environment, run: LegendCollectionRun): Promise<void> {
  await appendLegendActionsOutput(env, 'collection_result', checkedRun(run))
}

export async function appendLegendActionsOutput(env: Environment, key: 'collection_result' | 'match_collection_result', value: unknown): Promise<void> {
  if (key !== 'collection_result' && key !== 'match_collection_result') throw new Error('Invalid Actions output key')
  const serialized = JSON.stringify(value)
  if (!serialized || serialized.length > 4096) throw new Error('Invalid Actions output value')
  const output = env.GITHUB_OUTPUT
  if (!output || !isAbsolute(output)) throw new Error('Missing Actions output')
  await checkLegendAnalysisParents(dirname(output))
  const before = await legendAnalysisFileInfo(output)
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > 64 * 1024) throw new Error('Invalid Actions output')
  const file = await open(output, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await file.stat()
    if (!current.isFile() || current.nlink > 1 || current.dev !== before.dev || current.ino !== before.ino) throw new Error('Changed Actions output')
    await file.writeFile(`${key}=${serialized}\n`, 'utf8')
  } finally { await file.close() }
}

export function finalizeLegendCollectionRun(env: Environment, now: string): LegendCollectionRun {
  const raw = env.LEGEND_COLLECTION_RESULT
  if (!raw) {
    // An uploaded dataset cannot be classified from job status alone.
    if (env.LEGEND_ARTIFACT_READY === 'true' || env.LEGEND_COLLECT_JOB_RESULT === 'success') throw new Error('Missing collection result')
    const reason = env.LEGEND_COLLECT_JOB_RESULT === 'cancelled' ? 'cancelled' : 'collection-failed'
    const result = buildLegendCollectionDraft(env, undefined, reason, env.LEGEND_COLLECTION_ENDED_AT || now)
    return env.LEGEND_COLLECT_STEP_OUTCOME === 'skipped' ? result : checkedRun({ ...result, phase: 'unknown' })
  }
  if (raw.length > 4096) throw new Error('Invalid collection result')
  const result = checkedRun(JSON.parse(raw))
  const identity = runIdentity(env)
  if (result.runId !== identity.runId || result.runAttempt !== identity.runAttempt || result.trigger !== identity.trigger) {
    throw new Error('Mismatched collection result')
  }
  if ((result.outcome === 'succeeded' || result.outcome === 'partial') && env.LEGEND_SAVE_JOB_RESULT !== 'success') {
    // Keep the acquisition interval stable when only the save job is retried.
    return checkedRun({ ...result, outcome: 'save-failed', phase: 'saving',
      reason: 'output-unavailable', datasetId: null, rankingCount: null, rankedMatchCount: null })
  }
  if (result.outcome === 'partial' && result.phase === 'profiles' && result.reason === null) {
    return finalizeSplitLegendCollection(env, result, now)
  }
  return result
}

function finalizeSplitLegendCollection(env: Environment, ranking: LegendCollectionRun, now: string): LegendCollectionRun {
  const endedAt = env.LEGEND_MATCH_ENDED_AT || now
  if (endedAt < ranking.endedAt) throw new Error('Invalid match collection time')
  const raw = env.LEGEND_MATCH_COLLECTION_RESULT
  if (raw) {
    if (raw.length > 256) throw new Error('Invalid match collection result')
    const result = JSON.parse(raw)
    if (!result || typeof result !== 'object' || Object.keys(result).length !== 2
      || result.datasetId !== ranking.datasetId || !Object.hasOwn(result, 'reason')) {
      throw new Error('Mismatched match collection result')
    }
    if (result.reason !== null) return checkedRun({ ...ranking, endedAt, reason: result.reason })
    if (env.LEGEND_MATCH_COLLECT_JOB_RESULT === 'success' && env.LEGEND_MATCH_SAVE_JOB_RESULT === 'success') {
      return checkedRun({ ...ranking, endedAt, outcome: 'succeeded', phase: 'complete', rankedMatchCount: ranking.rankingCount })
    }
    return checkedRun({ ...ranking, endedAt, reason: 'output-unavailable' })
  }
  const reason = env.LEGEND_MATCH_COLLECT_JOB_RESULT === 'cancelled' || env.LEGEND_MATCH_SAVE_JOB_RESULT === 'cancelled'
    ? 'cancelled' : 'collection-failed'
  return checkedRun({ ...ranking, endedAt, reason })
}
