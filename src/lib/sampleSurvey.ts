import type { SampleSurveyConfig, SampleSurveyError, SampleSurveyPlan, SampleSurveyRank, SampleSurveyRun, SampleSurveyServiceStatus, SampleSurveyStratumResult } from '../types/sampleSurvey.ts'

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
export function parseSampleSurveyRun(value: unknown): SampleSurveyRun {
  const item = record(value, ['schemaVersion', 'id', 'planId', 'config', 'state', 'phase', 'startedAt', 'updatedAt', 'finishedAt',
    'elapsedMs', 'attempts', 'successfulPages', 'uniqueAccountCount', 'strata', 'frameChanged', 'stopReason', 'resumeAllowed'])
  if (item.schemaVersion !== 1) fail()
  const config = parseSampleSurveyConfig(item.config), definitions = sampleSurveyResultDefinitions(config)
  if (!Array.isArray(item.strata) || item.strata.length !== definitions.length) fail()
  const strata = item.strata.map((stratum, index) => parseStratum(stratum, definitions[index]))
  const state = oneOf(item.state, ['preparing', 'running', 'complete', 'stopped', 'error'] as const)
  const phase = oneOf(item.phase, ['boundaries', 'sampling', 'complete'] as const)
  const startedAt = time(item.startedAt), updatedAt = time(item.updatedAt), finishedAt = item.finishedAt === null ? null : time(item.finishedAt)
  const active = state === 'preparing' || state === 'running'
  const stopReason = item.stopReason === null ? null : oneOf(item.stopReason, Object.keys(errors) as SampleSurveyError[])
  const resumeAllowed = boolean(item.resumeAllowed)
  if (Date.parse(updatedAt) < Date.parse(startedAt) || finishedAt && (Date.parse(finishedAt) < Date.parse(startedAt) || Date.parse(finishedAt) > Date.parse(updatedAt))) fail()
  if (active !== (finishedAt === null) || (active || state === 'complete') && stopReason !== null) fail()
  if (resumeAllowed && (active || state === 'complete' || !['cancelled', 'limit-reached', 'interrupted'].includes(stopReason ?? ''))) fail()
  if (phase !== 'boundaries' && strata.some(row => row.population === null || row.selected !== Math.min(row.requested, row.population))) fail()
  if (resumeAllowed && strata.some(row => row.target === 'mr' && row.processed > 0)) fail()
  if (state === 'complete' && (phase !== 'complete' || strata.some(row => row.population === null || row.processed !== row.selected))) fail()
  const attempts = integer(item.attempts)
  return { schemaVersion: 1, id: id(item.id), planId: id(item.planId), config, state, phase, startedAt, updatedAt, finishedAt,
    elapsedMs: integer(item.elapsedMs), attempts, successfulPages: integer(item.successfulPages, 0, attempts),
    uniqueAccountCount: integer(item.uniqueAccountCount, 0, strata.reduce((total, row) => total + row.succeeded, 0)),
    strata, frameChanged: boolean(item.frameChanged), stopReason, resumeAllowed }
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
