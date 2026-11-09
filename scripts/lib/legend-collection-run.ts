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
  reason: PreparationReason, now: string): LegendCollectionRun {
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
  const partial = report.status === 'partial'
  return checkedRun({ ...common, ...timing, outcome: report.status, phase: partial ? 'profiles' : 'complete',
    reason: partial ? failure : null, datasetId: report.datasetId, rankingCount: entries, rankedMatchCount: partial ? 0 : entries })
}

/** Only the compact allowlisted record can enter the runner's existing output file. */
export async function writeLegendCollectionDraft(env: Environment, run: LegendCollectionRun): Promise<void> {
  const output = env.GITHUB_OUTPUT
  if (!output || !isAbsolute(output)) throw new Error('Missing Actions output')
  await checkLegendAnalysisParents(dirname(output))
  const before = await legendAnalysisFileInfo(output)
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > 64 * 1024) throw new Error('Invalid Actions output')
  const file = await open(output, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await file.stat()
    if (!current.isFile() || current.nlink > 1 || current.dev !== before.dev || current.ino !== before.ino) throw new Error('Changed Actions output')
    await file.writeFile(`collection_result=${JSON.stringify(checkedRun(run))}\n`, 'utf8')
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
  return result
}
