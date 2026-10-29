import type { SampleSurveyRun } from '../types/sampleSurvey.ts'
import { SAMPLE_SURVEY_INSIGHT_METRICS, type SampleSurveyInsightCategory, type SampleSurveyInsightCoverage,
  type SampleSurveyInsightDataset, type SampleSurveyInsightMetric, type SampleSurveyInsightMetrics,
  type SampleSurveyInsightMode, type SampleSurveyInsightPeriod, type SampleSurveyInsightRow,
  type SampleSurveyInsights, type SampleSurveyInsightTheme, type SampleSurveyMetricValue } from '../types/sampleSurveyInsights.ts'

export const SAMPLE_SURVEY_INSIGHT_THEME_METRICS: Record<SampleSurveyInsightTheme, readonly SampleSurveyInsightMetric[]> = {
  activity: ['activeShare', 'meanBattles', 'meanCharacters'],
  character: ['userShare', 'wins', 'battles', 'winRate', 'medianLp', 'medianMr'],
  matchup: ['battles', 'medianWinRate'],
  battle: ['driveParryShare', 'driveImpactShare', 'overdriveShare', 'parryRushShare', 'cancelRushShare', 'driveReversalShare',
    'driveDamageShare', 'reversalMean', 'parryMean', 'perfectParryMean', 'parryThrowMean', 'parryThrownMean',
    'impactHitMean', 'impactPunishMean', 'impactCounterMean', 'impactTakenMean', 'impactPunishTakenMean', 'impactCounteredMean',
    'sa1Share', 'sa2Share', 'sa3Share', 'caShare', 'stunMean', 'stunnedMean', 'throwMean', 'thrownMean', 'throwTechMean',
    'cornerAttackMean', 'cornerDefenseMean'],
  recent: ['records', 'recentActiveShare', 'classicRecords', 'modernRecords', 'unknownRecords', 'modernShare', 'wins', 'losses'],
  attributes: ['categoryShare', 'meanPlayPoints', 'meanEnjoy', 'clubShare', 'medianFavoriteRankHours', 'vMasterShare', 'meanChallengeClears'],
}
const themes = Object.keys(SAMPLE_SURVEY_INSIGHT_THEME_METRICS) as SampleSurveyInsightTheme[]
const modes: SampleSurveyInsightMode[] = ['all', 'rank', 'casual', 'custom', 'hub']
const categories: SampleSurveyInsightCategory[] = ['region-jp', 'region-us', 'region-other', 'region-unset',
  'platform-steam', 'platform-cross', 'platform-unknown']
const characterIds = ['ryu', 'luke', 'jamie', 'chunli', 'guile', 'kimberly', 'juri', 'ken', 'blanka', 'dhalsim',
  'ehonda', 'deejay', 'manon', 'marisa', 'jp', 'zangief', 'lily', 'cammy', 'rashid', 'aki', 'ed',
  'gouki_akuma', 'vega_mbison', 'terry', 'mai', 'elena', 'sagat', 'cviper', 'alex', 'ingrid', 'yasmine', 'arjun', 'random']
const accountRatios = new Set<SampleSurveyInsightMetric>(['activeShare', 'userShare', 'recentActiveShare', 'categoryShare', 'clubShare', 'vMasterShare'])
const percentageMeans = new Set<SampleSurveyInsightMetric>(['driveParryShare', 'driveImpactShare', 'overdriveShare', 'parryRushShare',
  'cancelRushShare', 'driveReversalShare', 'driveDamageShare', 'sa1Share', 'sa2Share', 'sa3Share', 'caShare'])
type Context = Pick<SampleSurveyRun, 'strata' | 'startedAt' | 'updatedAt'>

function fail(): never { throw new Error('標本調査の追加集計の形式が不正です。') }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const item = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) fail()
  return item
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail()
  return value as number
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail()
  return value
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail()
  return value as T
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail()
  return value
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail()
  return value
}
function unique(values: string[]): void { if (new Set(values).size !== values.length) fail() }

/** Derive displayed values from stored denominators. No-data cells stay null; observed zero stays zero. */
export function sampleSurveyMetricValue(cell: SampleSurveyMetricValue | undefined): number | null {
  if (!cell || cell.n === 0) return null
  if (cell.kind === 'count') return cell.count
  if (cell.kind === 'ratio') return cell.denominator === 0 ? null : cell.numerator / cell.denominator * 100
  if (cell.kind === 'mean') return cell.total / cell.n
  return cell.value
}
function period(value: unknown): SampleSurveyInsightPeriod {
  const item = record(value, ['kind'], ['act'])
  const kind = oneOf(item.kind, ['act', 'lifetime', 'capture', 'last-100', 'recent-10'] as const)
  if (kind === 'act') return { kind, act: integer(item.act, 1000) }
  if (Object.hasOwn(item, 'act')) fail()
  return { kind }
}
function metric(value: unknown, id: SampleSurveyInsightMetric, validAccounts: number, theme: SampleSurveyInsightTheme): SampleSurveyMetricValue {
  const kind = SAMPLE_SURVEY_INSIGHT_METRICS[id]
  const fields = kind === 'count' ? ['count'] : kind === 'ratio' ? ['numerator', 'denominator'] : kind === 'mean' ? ['total'] : ['value']
  const item = record(value, ['kind', 'n', ...fields])
  if (item.kind !== kind) fail()
  const n = integer(item.n, validAccounts)
  if (kind === 'count') {
    const count = integer(item.count, theme === 'recent' ? n * 10 : Number.MAX_SAFE_INTEGER)
    if (n === 0 && count !== 0) fail()
    return { kind, n, count }
  }
  if (kind === 'ratio') {
    const denominator = integer(item.denominator), numerator = integer(item.numerator, denominator)
    if (n === 0 && denominator !== 0 || accountRatios.has(id) && denominator !== n || id === 'modernShare' && denominator > n * 10) fail()
    return { kind, n, numerator, denominator }
  }
  if (kind === 'mean') {
    const total = number(item.total, percentageMeans.has(id) ? n * 100 : Number.MAX_SAFE_INTEGER)
    if (n === 0 && total !== 0 || id === 'meanCharacters' && total > n * characterIds.length) fail()
    if (['meanBattles', 'meanCharacters', 'meanPlayPoints', 'meanEnjoy', 'meanChallengeClears'].includes(id)) integer(total)
    return { kind, n, total }
  }
  if (n === 0) { if (item.value !== null) fail(); return { kind, n, value: null } }
  return { kind, n, value: number(item.value, id === 'medianWinRate' ? 100 : Number.MAX_SAFE_INTEGER) }
}
function checkMetrics(metrics: SampleSurveyInsightMetrics, theme: SampleSurveyInsightTheme): void {
  const { wins, battles, winRate, medianWinRate, records, classicRecords, modernRecords, unknownRecords, losses, modernShare } = metrics
  if (wins?.kind === 'count' && battles?.kind === 'count' && wins.n === battles.n && wins.count > battles.count) fail()
  if (winRate?.kind === 'ratio') {
    if (wins?.kind === 'count' && (winRate.n !== wins.n || winRate.numerator !== wins.count)) fail()
    if (battles?.kind === 'count' && (winRate.n !== battles.n || winRate.denominator !== battles.count)) fail()
  }
  if (theme === 'matchup' && battles?.kind === 'count' && medianWinRate?.kind === 'median'
    && (medianWinRate.n > battles.n || battles.count < medianWinRate.n)) fail()
  if (theme === 'recent' && records?.kind === 'count') {
    for (const cell of [classicRecords, modernRecords, unknownRecords, wins, losses]) {
      if (cell?.kind === 'count' && (cell.n !== records.n || cell.count > records.count)) fail()
    }
    if (classicRecords?.kind === 'count' && modernRecords?.kind === 'count' && unknownRecords?.kind === 'count'
      && classicRecords.count + modernRecords.count + unknownRecords.count !== records.count) fail()
    if (wins?.kind === 'count' && losses?.kind === 'count' && wins.count + losses.count > records.count) fail()
  }
  if (modernShare?.kind === 'ratio' && classicRecords?.kind === 'count' && modernRecords?.kind === 'count'
    && (modernShare.n !== modernRecords.n || modernShare.n !== classicRecords.n
      || modernShare.numerator !== modernRecords.count || modernShare.denominator !== classicRecords.count + modernRecords.count)) fail()
}
function dataset(value: unknown, context: Context): SampleSurveyInsightDataset {
  const item = record(value, ['theme', 'target', 'period', 'mode', 'capturedAt', 'coverage', 'rows'])
  const theme = oneOf(item.theme, themes), target = oneOf(item.target, ['lp', 'mr'] as const)
  const selectedPeriod = period(item.period), mode = item.mode === null ? null : oneOf(item.mode, modes)
  if (['activity', 'matchup'].includes(theme) && (!['act', 'lifetime'].includes(selectedPeriod.kind) || mode === null)
    || theme === 'battle' && (selectedPeriod.kind !== 'last-100' || mode !== null)
    || theme === 'recent' && (selectedPeriod.kind !== 'recent-10' || mode !== 'all')
    || theme === 'attributes' && (selectedPeriod.kind !== 'capture' || mode !== null)
    || theme === 'character' && (selectedPeriod.kind === 'capture' ? mode !== null : !['act', 'lifetime'].includes(selectedPeriod.kind) || mode === null)) fail()
  const captured = record(item.capturedAt, ['start', 'end']), start = time(captured.start), end = time(captured.end)
  if (start < context.startedAt || end > context.updatedAt || start > end) fail()
  const available = context.strata.filter(row => row.target === target)
  const coverage = array(item.coverage, available.length).map((value): SampleSurveyInsightCoverage => {
    const input = record(value, ['stratumId', 'attemptedAccounts', 'validAccounts', 'failedAccounts'])
    const stratumId = oneOf(input.stratumId, available.map(row => row.id)), stratum = available.find(row => row.id === stratumId)!
    const attemptedAccounts = integer(input.attemptedAccounts, stratum.succeeded), validAccounts = integer(input.validAccounts, attemptedAccounts)
    const failedAccounts = integer(input.failedAccounts, attemptedAccounts)
    if (validAccounts + failedAccounts !== attemptedAccounts) fail()
    return { stratumId, attemptedAccounts, validAccounts, failedAccounts }
  })
  if (coverage.length === 0) fail()
  unique(coverage.map(row => row.stratumId))
  const rows = array(item.rows, 4096).map((value): SampleSurveyInsightRow => {
    const input = record(value, ['stratumId', 'validAccounts', 'metrics'], ['characterId', 'opponentCharacterId', 'category'])
    const stratumId = oneOf(input.stratumId, coverage.map(row => row.stratumId))
    const validAccounts = integer(input.validAccounts, coverage.find(row => row.stratumId === stratumId)!.validAccounts)
    const characterId = Object.hasOwn(input, 'characterId') ? oneOf(input.characterId, characterIds) : undefined
    const opponentCharacterId = Object.hasOwn(input, 'opponentCharacterId') ? oneOf(input.opponentCharacterId, characterIds) : undefined
    const category = Object.hasOwn(input, 'category') ? oneOf(input.category, categories) : undefined
    if (['character', 'matchup'].includes(theme) !== (characterId !== undefined) || (theme === 'matchup') !== (opponentCharacterId !== undefined)
      || category !== undefined && theme !== 'attributes') fail()
    const inputMetrics = record(input.metrics, [], SAMPLE_SURVEY_INSIGHT_THEME_METRICS[theme])
    if (Object.keys(inputMetrics).length === 0) fail()
    const metrics: SampleSurveyInsightMetrics = {}
    for (const key of Object.keys(inputMetrics) as SampleSurveyInsightMetric[]) {
      if (theme === 'character' && (selectedPeriod.kind === 'capture') !== ['medianLp', 'medianMr'].includes(key)) fail()
      if (theme === 'attributes' && (category !== undefined) !== (key === 'categoryShare')) fail()
      metrics[key] = metric(inputMetrics[key], key, validAccounts, theme)
    }
    checkMetrics(metrics, theme)
    return { stratumId, validAccounts, ...(characterId ? { characterId } : {}), ...(opponentCharacterId ? { opponentCharacterId } : {}),
      ...(category ? { category } : {}), metrics }
  })
  unique(rows.map(row => [row.stratumId, row.characterId, row.opponentCharacterId, row.category].join('|')))
  return { theme, target, period: selectedPeriod, mode, capturedAt: { start, end }, coverage, rows }
}

/** Only known aggregate fields are reconstructed. Individual account data has no representation. */
export function parseSampleSurveyInsights(value: unknown, context: Context): SampleSurveyInsights {
  const item = record(value, ['schemaVersion', 'datasets'])
  if (item.schemaVersion !== 1) fail()
  const datasets = array(item.datasets, 128).map(value => dataset(value, context))
  unique(datasets.map(value => [value.theme, value.target, value.period.kind, value.period.kind === 'act' ? value.period.act : '', value.mode].join('|')))
  return { schemaVersion: 1, datasets }
}
