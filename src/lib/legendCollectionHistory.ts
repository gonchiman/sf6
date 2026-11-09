export const LEGEND_COLLECTION_HISTORY_LIMIT = 10
export const LEGEND_COLLECTION_HISTORY_PATH = 'collection-history/legend-runs.json'

const triggers = ['schedule', 'workflow_dispatch'] as const
const outcomes = ['succeeded', 'partial', 'stopped', 'save-failed'] as const
const phases = ['preparation', 'listing', 'profiles', 'saving', 'complete', 'unknown'] as const
const reasons = [
  'captcha', 'human-verification', 'authentication-unavailable', 'source-unconfirmed', 'source-changed',
  'access-unavailable', 'cancelled', 'request-limit', 'collection-failed', 'output-unavailable',
] as const

export interface LegendCollectionRun {
  runId: string
  runAttempt: number
  trigger: typeof triggers[number]
  startedAt: string | null
  endedAt: string
  outcome: typeof outcomes[number]
  phase: typeof phases[number]
  reason: typeof reasons[number] | null
  lastAttemptedPage: number | null
  datasetId: string | null
  rankingCount: number | null
  rankedMatchCount: number | null
}

export interface LegendCollectionHistory {
  schemaVersion: 1
  runs: LegendCollectionRun[]
}

function invalid(): never {
  throw new Error('レジェンド帯の取得履歴の形式が正しくありません。')
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid()
  return value as Record<string, unknown>
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function isInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isAllowed<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return choices.some(choice => choice === value)
}

function parseRun(value: unknown): LegendCollectionRun {
  const input = fields(value, ['runId', 'runAttempt', 'trigger', 'startedAt', 'endedAt', 'outcome', 'phase',
    'reason', 'lastAttemptedPage', 'datasetId', 'rankingCount', 'rankedMatchCount'])
  const { runId, runAttempt, trigger, startedAt, endedAt, outcome, phase, reason,
    lastAttemptedPage, datasetId, rankingCount, rankedMatchCount } = input
  if (typeof runId !== 'string' || !/^[1-9]\d{0,19}$/.test(runId) || !isInteger(runAttempt, 1)
    || !isAllowed(trigger, triggers) || !isTimestamp(endedAt)
    || (startedAt !== null && (!isTimestamp(startedAt) || startedAt > endedAt))
    || !isAllowed(outcome, outcomes) || !isAllowed(phase, phases)
    || (reason !== null && !isAllowed(reason, reasons))
    || (lastAttemptedPage !== null && !isInteger(lastAttemptedPage, 1))
    || (datasetId !== null && (typeof datasetId !== 'string' || !/^legend-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(datasetId)))
    || (rankingCount !== null && !isInteger(rankingCount))
    || (rankedMatchCount !== null && !isInteger(rankedMatchCount))) invalid()

  if (outcome === 'succeeded' || outcome === 'partial') {
    if (datasetId === null || rankingCount === null) invalid()
    if (outcome === 'succeeded' && (rankedMatchCount !== rankingCount || reason !== null)) invalid()
    if (outcome === 'partial' && rankedMatchCount !== 0) invalid()
  } else if (datasetId !== null || rankingCount !== null || rankedMatchCount !== null) invalid()

  return { runId, runAttempt, trigger, startedAt, endedAt, outcome, phase, reason,
    lastAttemptedPage, datasetId, rankingCount, rankedMatchCount }
}

export function parseLegendCollectionHistory(value: unknown): LegendCollectionHistory {
  const { schemaVersion, runs } = fields(value, ['schemaVersion', 'runs'])
  if (schemaVersion !== 1 || !Array.isArray(runs) || runs.length > LEGEND_COLLECTION_HISTORY_LIMIT) invalid()
  const parsed = runs.map(parseRun)
  if (new Set(parsed.map(run => `${run.runId}:${run.runAttempt}`)).size !== parsed.length) invalid()
  parsed.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || b.runId.length - a.runId.length
    || b.runId.localeCompare(a.runId) || b.runAttempt - a.runAttempt)
  return { schemaVersion, runs: parsed }
}
