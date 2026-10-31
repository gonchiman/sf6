import type { SampleSurveyBoundaryAcceptance, SampleSurveyChange, SampleSurveyConfig, SampleSurveyError, SampleSurveyObservation, SampleSurveyPlan, SampleSurveyRank, SampleSurveyRun, SampleSurveyServiceStatus, SampleSurveyStratumObservation, SampleSurveyStratumResult } from '../types/sampleSurvey.ts'
import { parseSampleSurveyInsights } from './sampleSurveyInsights.ts'

export const SAMPLE_SURVEY_RANKS: readonly SampleSurveyRank[] = ['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER']
export const SAMPLE_SURVEY_MR_BANDS = [
  { id: 'mr-under-1200', label: '1200未満', min: 0, max: 1200 },
  { id: 'mr-1200-1399', label: '1200〜1399', min: 1200, max: 1400 },
  { id: 'mr-1400-1599', label: '1400〜1599', min: 1400, max: 1600 },
  { id: 'mr-1600-1799', label: '1600〜1799', min: 1600, max: 1800 },
  { id: 'mr-1800-1999', label: '1800〜1999', min: 1800, max: 2000 },
  { id: 'mr-2000-plus', label: '2000以上', min: 2000, max: null },
] as const
export const SAMPLE_SURVEY_INTERVAL_MS = 10_000
export const SAMPLE_SURVEY_MAX_CHANGES = 64
export const SAMPLE_SURVEY_MAX_BOUNDARY_DELTA = 20
export const SAMPLE_SURVEY_MAX_BOUNDARY_RELATIVE_DELTA = 0.001
export const DEFAULT_SAMPLE_SURVEY_CONFIG: SampleSurveyConfig = {
  ranks: [...SAMPLE_SURVEY_RANKS], rankSampleSize: 200, includeMr: true, mrSampleSize: 100, maxDurationMinutes: 120,
}
const errors: Record<SampleSurveyError, string> = {
  cancelled: '停止しました', 'limit-reached': '取得回数・時間の上限', 'human-verification': '人間確認が必要',
  'http-denied': 'アクセス制限', 'login-required': 'ログインが必要', 'authentication-unconfirmed': 'ログイン状態を確認できません',
  maintenance: 'メンテナンス中', 'server-error': '取得先のサーバーエラー', 'http-error': '取得先の応答エラー',
  timeout: '取得がタイムアウト', 'read-failed': 'ページを読み取れません', 'condition-mismatch': '取得条件が不一致',
  'page-mismatch': 'ページ番号が不一致', 'frame-changed': '抽出対象の範囲が変化',
  'session-unavailable': '保存済みログイン情報がありません', 'browser-unavailable': '取得用ブラウザーを起動できません',
  'storage-error': 'ローカルの記録を保存・読込できません', interrupted: '前回の取得が中断されました', 'invalid-request': '調査条件が不正',
}
export const sampleSurveyErrorLabel = (code: SampleSurveyError) => errors[code]
export const sampleSurveyRunActive = (run: SampleSurveyRun) => run.state === 'preparing' || run.state === 'running'
function fail(): never { throw new Error('標本調査データの形式が不正です。') }
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const item = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) fail()
  return item
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail()
  return value as number
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value }
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) fail(); return value }
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail()
  return value
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) fail(); return value as T }

export function parseSampleSurveyConfig(value: unknown): SampleSurveyConfig {
  const item = record(value, ['ranks', 'rankSampleSize', 'includeMr', 'mrSampleSize', 'maxDurationMinutes'])
  if (!Array.isArray(item.ranks) || item.ranks.length > 8 || new Set(item.ranks).size !== item.ranks.length) fail()
  const ranks = item.ranks.map(rank => oneOf(rank, SAMPLE_SURVEY_RANKS))
  const rankSampleSize = integer(item.rankSampleSize, 10, 1000), mrSampleSize = integer(item.mrSampleSize, 10, 1000)
  const includeMr = boolean(item.includeMr)
  if (rankSampleSize % 10 || mrSampleSize % 10 || !ranks.length && !includeMr) fail()
  return { ranks: SAMPLE_SURVEY_RANKS.filter(rank => ranks.includes(rank)), rankSampleSize, includeMr, mrSampleSize,
    maxDurationMinutes: integer(item.maxDurationMinutes, 1, 480) }
}
export function sampleSurveyPlannedCount(config: SampleSurveyConfig): number {
  return config.ranks.length * config.rankSampleSize + (config.includeMr ? SAMPLE_SURVEY_MR_BANDS.length * config.mrSampleSize : 0)
}
export function sampleSurveyEstimate(config: SampleSurveyConfig) {
  const pages = sampleSurveyPlannedCount(config)
  return { pages, minimumMs: pages * 5000, maximumMs: pages * 10000 }
}
export function parseSampleSurveyPlan(value: unknown): SampleSurveyPlan {
  const item = record(value, ['schemaVersion', 'id', 'createdAt', 'seed', 'config'])
  if (item.schemaVersion !== 1 || typeof item.seed !== 'string' || !/^[a-f0-9]{32,64}$/.test(item.seed)) fail()
  return { schemaVersion: 1, id: id(item.id), createdAt: time(item.createdAt), seed: item.seed, config: parseSampleSurveyConfig(item.config) }
}
export function sampleSurveyResultDefinitions(config: SampleSurveyConfig) {
  return [
    ...config.ranks.map(rank => ({ id: `lp-${rank}`, label: rank as string, target: 'lp' as const, requested: config.rankSampleSize })),
    ...(config.includeMr ? SAMPLE_SURVEY_MR_BANDS.map(band => ({ id: band.id as string, label: band.label as string, target: 'mr' as const, requested: config.mrSampleSize })) : []),
  ]
}
function parseStratum(value: unknown, definition: ReturnType<typeof sampleSurveyResultDefinitions>[number]): SampleSurveyStratumResult {
  const item = record(value, ['id', 'label', 'target', 'requested', 'population', 'selected', 'processed', 'succeeded', 'missing', 'duplicates', 'mean', 'min', 'max'])
  if (item.id !== definition.id || item.label !== definition.label || item.target !== definition.target || item.requested !== definition.requested) fail()
  const population = item.population === null ? null : integer(item.population)
  const selected = integer(item.selected, 0, definition.requested)
  const processed = integer(item.processed, 0, selected), succeeded = integer(item.succeeded, 0, processed)
  const missing = integer(item.missing, 0, processed), duplicates = integer(item.duplicates, 0, processed)
  if (processed !== succeeded + missing + duplicates || population === null && selected !== 0 || population !== null && selected > population) fail()
  let mean: number | null = null, min: number | null = null, max: number | null = null
  if (!succeeded) { if (item.mean !== null || item.min !== null || item.max !== null) fail() }
  else {
    min = integer(item.min); max = integer(item.max, min)
    if (typeof item.mean !== 'number' || !Number.isFinite(item.mean) || item.mean < min || item.mean > max) fail()
    mean = item.mean
  }
  return { ...definition, population, selected, processed, succeeded, missing, duplicates, mean, min, max }
}
const changeKinds: readonly SampleSurveyChange['kind'][] = [
  'total-count', 'boundary-start', 'boundary-end', 'page-size', 'row-order', 'range-order',
  'row-outside-stratum', 'duplicate', 'page-unavailable',
]
function nullableInteger(value: unknown): number | null { return value === null ? null : integer(value) }
function nullableTime(value: unknown): string | null { return value === null ? null : time(value) }
function parseBoundaryAcceptance(value: unknown, observation: SampleSurveyStratumObservation, population: number,
  updatedAt: string): SampleSurveyBoundaryAcceptance {
  const input = record(value, ['mode', 'referenceStart', 'referenceEnd', 'referenceCheckedAt', 'start', 'end', 'startObservedAt', 'endObservedAt'])
  const mode = oneOf(input.mode, ['exact', 'approximate'] as const)
  const referenceStart = integer(input.referenceStart), referenceEnd = integer(input.referenceEnd, referenceStart)
  const start = integer(input.start), end = integer(input.end, start)
  const referenceCheckedAt = time(input.referenceCheckedAt), startObservedAt = time(input.startObservedAt), endObservedAt = time(input.endObservedAt)
  const startDelta = Math.abs(start - referenceStart), endDelta = Math.abs(end - referenceEnd)
  // Compare both cuts with the same original range; rounding is toward fewer permitted positions.
  const relativeLimit = Math.floor((referenceEnd - referenceStart) / (1 / SAMPLE_SURVEY_MAX_BOUNDARY_RELATIVE_DELTA))
  if (start !== observation.startBefore || end !== observation.endBefore || population !== end - start
    || observation.totalCountBefore === null || end > observation.totalCountBefore
    || observation.startedAt === null || referenceCheckedAt < observation.startedAt
    || referenceCheckedAt > startObservedAt || startObservedAt > endObservedAt
    || endObservedAt > (observation.finishedAt ?? updatedAt)
    || startDelta > SAMPLE_SURVEY_MAX_BOUNDARY_DELTA || endDelta > SAMPLE_SURVEY_MAX_BOUNDARY_DELTA
    || startDelta + endDelta > relativeLimit
    || (mode === 'exact' ? startDelta + endDelta !== 0
      : startDelta + endDelta === 0 || !observation.boundaryChanged || observation.status === 'checked')) fail()
  return { mode, referenceStart, referenceEnd, referenceCheckedAt, start, end, startObservedAt, endObservedAt }
}
function parseObservation(value: unknown, rows: SampleSurveyStratumResult[], startedAt: string, updatedAt: string): SampleSurveyObservation {
  const item = record(value, ['method', 'strata', 'changes', 'omittedChanges'])
  const method = oneOf(item.method, ['rank-position-interval-v1', 'rank-position-tolerant-v1'] as const)
  if (!Array.isArray(item.strata) || item.strata.length !== rows.length
    || !Array.isArray(item.changes) || item.changes.length > SAMPLE_SURVEY_MAX_CHANGES) fail()
  const withinPeriod = (at: string | null) => at === null || at >= startedAt && at <= updatedAt
  const strata = item.strata.map((value, index): SampleSurveyStratumObservation => {
    const row = rows[index], input = record(value, ['id', 'status', 'startedAt', 'finishedAt', 'totalCountBefore', 'totalCountAfter',
      'startBefore', 'endBefore', 'startAfter', 'endAfter', 'boundaryChanged'], method === 'rank-position-tolerant-v1' ? ['boundaryAcceptance'] : [])
    if (input.id !== row.id) fail()
    const status = oneOf(input.status, ['pending', 'collecting', 'checked', 'review-required'] as const)
    const observation: SampleSurveyStratumObservation = { id: row.id, status, startedAt: nullableTime(input.startedAt),
      finishedAt: nullableTime(input.finishedAt), totalCountBefore: nullableInteger(input.totalCountBefore), totalCountAfter: nullableInteger(input.totalCountAfter),
      startBefore: nullableInteger(input.startBefore), endBefore: nullableInteger(input.endBefore), startAfter: nullableInteger(input.startAfter),
      endAfter: nullableInteger(input.endAfter), boundaryChanged: boolean(input.boundaryChanged) }
    const { startBefore, endBefore, startAfter, endAfter } = observation
    if (!withinPeriod(observation.startedAt) || !withinPeriod(observation.finishedAt)
      || observation.finishedAt !== null && (observation.startedAt === null || observation.finishedAt < observation.startedAt)
      || startBefore !== null && endBefore !== null && startBefore > endBefore
      || startAfter !== null && endAfter !== null && startAfter > endAfter) fail()
    if (status === 'pending') {
      if ([observation.startedAt, observation.finishedAt, observation.totalCountBefore, observation.totalCountAfter,
        startBefore, endBefore, startAfter, endAfter].some(value => value !== null) || observation.boundaryChanged
        || row.population !== null || row.selected !== 0) fail()
    } else if (observation.startedAt === null) fail()
    if (status === 'collecting' && observation.finishedAt !== null) fail()
    if (status === 'checked' || status === 'review-required') {
      if (observation.finishedAt === null) fail()
    }
    if (row.population !== null && startBefore !== null && endBefore !== null && row.population !== endBefore - startBefore) fail()
    if ((startBefore !== null && startAfter !== null && startBefore !== startAfter
      || endBefore !== null && endAfter !== null && endBefore !== endAfter) && !observation.boundaryChanged) fail()
    if (method === 'rank-position-tolerant-v1') {
      const accepted = Object.hasOwn(input, 'boundaryAcceptance')
      if (accepted !== (row.population !== null)) fail()
      if (accepted) observation.boundaryAcceptance = parseBoundaryAcceptance(input.boundaryAcceptance, observation, row.population!, updatedAt)
    }
    if (status === 'checked' && ([observation.totalCountBefore, observation.totalCountAfter, startBefore, endBefore, startAfter, endAfter].some(value => value === null)
      || endBefore! > observation.totalCountBefore! || endAfter! > observation.totalCountAfter!
      || observation.boundaryChanged || startBefore !== startAfter || endBefore !== endAfter || row.population === null
      || row.selected !== Math.min(row.requested, row.population) || row.processed !== row.selected || row.missing !== 0 || row.duplicates !== 0)) fail()
    return observation
  })
  const changes = item.changes.map((value): SampleSurveyChange => {
    const input = record(value, ['kind', 'target', 'stratumId', 'at', 'before', 'after'])
    const kind = oneOf(input.kind, changeKinds), target = oneOf(input.target, ['lp', 'mr'] as const), at = time(input.at)
    const stratumId = input.stratumId === null ? null : id(input.stratumId)
    if (!withinPeriod(at) || !rows.some(row => row.target === target && (stratumId === null || row.id === stratumId))) fail()
    return { kind, target, stratumId, at, before: nullableInteger(input.before), after: nullableInteger(input.after) }
  })
  return { method, strata, changes, omittedChanges: integer(item.omittedChanges) }
}
export function parseSampleSurveyRun(value: unknown): SampleSurveyRun {
  const item = record(value, ['schemaVersion', 'id', 'planId', 'config', 'state', 'phase', 'startedAt', 'updatedAt', 'finishedAt',
    'elapsedMs', 'attempts', 'successfulPages', 'uniqueAccountCount', 'strata', 'frameChanged', 'stopReason', 'resumeAllowed'], ['observation', 'insights'])
  if (item.schemaVersion !== 1 && item.schemaVersion !== 2 || (item.schemaVersion === 2) !== Object.hasOwn(item, 'observation')) fail()
  const config = parseSampleSurveyConfig(item.config), definitions = sampleSurveyResultDefinitions(config)
  if (!Array.isArray(item.strata) || item.strata.length !== definitions.length) fail()
  const strata = item.strata.map((stratum, index) => parseStratum(stratum, definitions[index]))
  const state = oneOf(item.state, ['preparing', 'running', 'complete', 'stopped', 'error'] as const)
  const phase = oneOf(item.phase, ['boundaries', 'sampling', 'complete'] as const)
  const startedAt = time(item.startedAt), updatedAt = time(item.updatedAt), finishedAt = item.finishedAt === null ? null : time(item.finishedAt)
  const active = state === 'preparing' || state === 'running'
  const stopReason = item.stopReason === null ? null : oneOf(item.stopReason, Object.keys(errors) as SampleSurveyError[])
  const resumeAllowed = boolean(item.resumeAllowed)
  const frameChanged = boolean(item.frameChanged)
  const observation = item.schemaVersion === 2 ? parseObservation(item.observation, strata, startedAt, updatedAt) : undefined
  if (Date.parse(updatedAt) < Date.parse(startedAt) || finishedAt && (Date.parse(finishedAt) < Date.parse(startedAt) || Date.parse(finishedAt) > Date.parse(updatedAt))) fail()
  if (active !== (finishedAt === null) || (active || state === 'complete') && stopReason !== null) fail()
  if (resumeAllowed && (active || state === 'complete' || !['cancelled', 'limit-reached', 'interrupted'].includes(stopReason ?? ''))) fail()
  if (item.schemaVersion === 1 && phase !== 'boundaries' && strata.some(row => row.population === null || row.selected !== Math.min(row.requested, row.population))) fail()
  if (resumeAllowed && strata.some(row => row.target === 'mr' && row.processed > 0)) fail()
  if (observation && (observation.strata.some(row => row.boundaryChanged) || strata.some(row => row.missing > 0 || row.duplicates > 0)) && !frameChanged) fail()
  if (state === 'complete' && (phase !== 'complete' || strata.some(row => row.processed !== row.selected
    || row.population !== null && row.selected !== Math.min(row.requested, row.population))
    || (observation ? observation.strata.some(row => !['checked', 'review-required'].includes(row.status)
      || row.finishedAt === null || row.finishedAt > finishedAt!) : strata.some(row => row.population === null)))) fail()
  const attempts = integer(item.attempts)
  if (Object.hasOwn(item, 'insights') && state !== 'complete') fail()
  const insights = Object.hasOwn(item, 'insights') ? parseSampleSurveyInsights(item.insights, { strata, startedAt, updatedAt: finishedAt! }) : undefined
  return { schemaVersion: item.schemaVersion, id: id(item.id), planId: id(item.planId), config, state, phase, startedAt, updatedAt, finishedAt,
    elapsedMs: integer(item.elapsedMs), attempts, successfulPages: integer(item.successfulPages, 0, attempts),
    uniqueAccountCount: integer(item.uniqueAccountCount, 0, strata.reduce((total, row) => total + row.succeeded, 0)),
    strata, frameChanged, stopReason, resumeAllowed, ...(observation ? { observation } : {}), ...(insights ? { insights } : {}) }
}
export function parseSampleSurveyStatus(value: unknown): SampleSurveyServiceStatus {
  const item = record(value, ['available', 'sessionAvailable', 'token', 'plans', 'runs', 'activeRunId'], ['error'])
  if (typeof item.token !== 'string' || !/^[a-f0-9]{64}$/.test(item.token) || !Array.isArray(item.plans) || item.plans.length > 1000
    || !Array.isArray(item.runs) || item.runs.length > 1000) fail()
  const plans = item.plans.map(parseSampleSurveyPlan), runs = item.runs.map(parseSampleSurveyRun)
  if (new Set(plans.map(plan => plan.id)).size !== plans.length || new Set(runs.map(run => run.id)).size !== runs.length) fail()
  const activeRunId = item.activeRunId === null ? null : id(item.activeRunId)
  if (activeRunId !== null && !runs.some(run => run.id === activeRunId && sampleSurveyRunActive(run))) fail()
  return { available: boolean(item.available), sessionAvailable: boolean(item.sessionAvailable), token: item.token,
    plans, runs, activeRunId, ...(item.error === undefined ? {} : { error: oneOf(item.error, ['storage-error', 'service-closed'] as const) }) }
}
