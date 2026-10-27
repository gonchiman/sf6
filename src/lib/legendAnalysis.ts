import type {
  LegendAnalysisConditions, LegendAnalysisDataset, LegendAnalysisDescriptor, LegendAnalysisManifest,
  LegendAnalysisSource, LegendCharacterAggregate, LegendCharacterRow, LegendMembershipRule,
  LegendMrDistribution,
} from '../types/legendAnalysis.ts'

export const LEGEND_ANALYSIS_SOURCE: LegendAnalysisSource = {
  url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/master', title: 'Buckler MRランキング',
}
export const LEGEND_ANALYSIS_BIN_SIZE = 50
export const LEGEND_ANALYSIS_VALIDATION_CHECKS = [
  'conditions-confirmed', 'act-confirmed', 'membership-confirmed', 'pagination-confirmed',
  'boundary-confirmed', 'ordering-confirmed', 'account-character-unit-confirmed', 'roster-confirmed',
  'duplicates-checked', 'capture-rechecked',
] as const

type RecordValue = Record<string, unknown>
function invalid(field: string): never { throw new Error(`レジェンド分析データの形式が正しくありません（${field}）。`) }
function record(value: unknown, field: string, keys: readonly string[]): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) invalid(`${field}: unknown field or invalid object`)
  return value as RecordValue
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) invalid(field)
  return value
}
function id(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) invalid(field)
  return result
}
function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(field)
  return value
}
function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(field)
  return value
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field)
  return value
}
function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(`${field}: duplicate`)
}
function strings(value: unknown, field: string): string[] { return array(value, field).map(item => text(item, field)) }
function time(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(field)
  return result
}
function interval(input: RecordValue): { captureStartedAt: string; captureEndedAt: string } {
  const captureStartedAt = time(input.captureStartedAt, 'captureStartedAt'), captureEndedAt = time(input.captureEndedAt, 'captureEndedAt')
  if (captureStartedAt > captureEndedAt) invalid('capture interval: reversed')
  return { captureStartedAt, captureEndedAt }
}
function source(value: unknown, extended = false): LegendAnalysisSource {
  const input = record(value, 'source', extended ? ['url', 'title', 'population', 'metric', 'unit', 'notes'] : ['url', 'title'])
  if (input.url !== LEGEND_ANALYSIS_SOURCE.url) invalid('source.url')
  return { url: LEGEND_ANALYSIS_SOURCE.url, title: text(input.title, 'source.title') }
}
function membership(value: unknown): LegendMembershipRule {
  if (value !== 'official-legend-badge' && value !== 'official-ranking-cutoff') invalid('membershipRule')
  return value
}
function conditions(value: unknown): LegendAnalysisConditions {
  const input = record(value, 'conditions', ['region', 'platform', 'characters', 'users'])
  if (input.characters !== 'all') invalid('conditions.characters')
  return { region: id(input.region, 'conditions.region'), platform: id(input.platform, 'conditions.platform'),
    characters: 'all', users: id(input.users, 'conditions.users') }
}
function characterId(value: unknown): string {
  const result = id(value, 'characterId')
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(result)) invalid('characterId')
  return result
}
function characterName(value: unknown): string {
  const result = text(value, 'character.name')
  if (result.length > 64 || !/^[\p{L}\p{M}\p{N} .・･'’ｰー\-（）()]+$/u.test(result)) invalid('character.name')
  return result
}
function safeSum(values: readonly number[], field: string): number {
  const sum = values.reduce((total, item) => total + item, 0)
  if (!Number.isSafeInteger(sum)) invalid(field)
  return sum
}
function path(value: unknown): string {
  const result = text(value, 'path')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(result) || result.toLowerCase() === 'index.json') invalid('path')
  return result
}

export function parseLegendAnalysisDescriptor(value: unknown): LegendAnalysisDescriptor {
  const input = record(value, 'descriptor', ['id', 'path', 'actId', 'definitionVersion', 'membershipRule', 'conditions',
    'captureStartedAt', 'captureEndedAt', 'totalCount'])
  return { id: id(input.id, 'id'), path: path(input.path), actId: id(input.actId, 'actId'),
    definitionVersion: id(input.definitionVersion, 'definitionVersion'), membershipRule: membership(input.membershipRule),
    conditions: conditions(input.conditions), ...interval(input), totalCount: integer(input.totalCount, 'totalCount') }
}

export function parseLegendAnalysisManifest(value: unknown): LegendAnalysisManifest {
  const input = record(value, 'manifest', ['schemaVersion', 'generatedAt', 'source', 'datasets', 'availability'])
  if (input.schemaVersion !== 1) invalid('schemaVersion')
  const generatedAt = time(input.generatedAt, 'generatedAt')
  const datasets = array(input.datasets, 'datasets').map(parseLegendAnalysisDescriptor)
  unique(datasets.map(item => item.id), 'datasets.id')
  unique(datasets.map(item => item.path.toLowerCase()), 'datasets.path')
  unique(datasets.map(item => `${item.captureStartedAt}:${item.captureEndedAt}`), 'datasets.capture interval')
  if (datasets.some(item => item.captureEndedAt > generatedAt)) invalid('generatedAt: before capture')
  const result: LegendAnalysisManifest = { schemaVersion: 1, generatedAt, source: source(input.source), datasets }
  if (input.availability !== undefined) {
    const status = record(input.availability, 'availability', ['status', 'checkedAt', 'message'])
    if (!['not-collected', 'verification-pending', 'collection-failed'].includes(status.status as string)) invalid('availability.status')
    const checkedAt = time(status.checkedAt, 'availability.checkedAt')
    if (checkedAt > generatedAt) invalid('availability.checkedAt: after publication')
    if (status.status === 'not-collected' && datasets.length) invalid('availability.status: already collected')
    result.availability = { status: status.status as NonNullable<LegendAnalysisManifest['availability']>['status'],
      checkedAt, message: text(status.message, 'availability.message') }
  }
  return result
}

/** Uses raw values, never an average of character means or percentiles inferred from bins. */
export function summarizeLegendMr(values: readonly number[]): LegendMrDistribution {
  const sorted = values.map(value => integer(value, 'MR')).sort((a, b) => a - b)
  const count = sorted.length
  if (!count) return { count: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null, bins: [] }
  const min = sorted[0], max = sorted[count - 1]
  const first = Math.floor(min / LEGEND_ANALYSIS_BIN_SIZE) * LEGEND_ANALYSIS_BIN_SIZE
  const last = Math.floor(max / LEGEND_ANALYSIS_BIN_SIZE) * LEGEND_ANALYSIS_BIN_SIZE
  const length = (last - first) / LEGEND_ANALYSIS_BIN_SIZE + 1
  if (!Number.isSafeInteger(last + LEGEND_ANALYSIS_BIN_SIZE) || length > 20_000) invalid('MR bin capacity')
  const bins = Array.from({ length }, (_, index) => ({ lower: first + index * LEGEND_ANALYSIS_BIN_SIZE,
    upper: first + (index + 1) * LEGEND_ANALYSIS_BIN_SIZE, count: 0 }))
  for (const value of sorted) bins[Math.floor((value - first) / LEGEND_ANALYSIS_BIN_SIZE)].count++
  const quantile = (p: number): number => {
    const position = (count - 1) * p, left = Math.floor(position), fraction = position - left
    return sorted[left] + (sorted[Math.ceil(position)] - sorted[left]) * fraction
  }
  const mean = safeSum(sorted, 'MR sum') / count
  return { count, min, p25: quantile(0.25), median: quantile(0.5), p75: quantile(0.75), max, mean, bins }
}

function distribution(value: unknown, field: string): LegendMrDistribution {
  const input = record(value, field, ['count', 'min', 'p25', 'median', 'p75', 'max', 'mean', 'bins'])
  const count = integer(input.count, `${field}.count`)
  const stats = ['min', 'p25', 'median', 'p75', 'max', 'mean'] as const
  const bins = array(input.bins, `${field}.bins`).map(value => {
    const bin = record(value, `${field}.bin`, ['lower', 'upper', 'count'])
    const lower = integer(bin.lower, `${field}.bin.lower`), upper = integer(bin.upper, `${field}.bin.upper`)
    if (lower % LEGEND_ANALYSIS_BIN_SIZE !== 0 || upper - lower !== LEGEND_ANALYSIS_BIN_SIZE) invalid(`${field}.bin: width/alignment`)
    return { lower, upper, count: integer(bin.count, `${field}.bin.count`) }
  })
  if (!count) {
    if (stats.some(key => input[key] !== null) || bins.length) invalid(`${field}: empty distribution`)
    return { count: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null, bins: [] }
  }
  const min = integer(input.min, `${field}.min`), max = integer(input.max, `${field}.max`)
  const p25 = number(input.p25, `${field}.p25`), median = number(input.median, `${field}.median`)
  const p75 = number(input.p75, `${field}.p75`), mean = number(input.mean, `${field}.mean`)
  if (!(min <= p25 && p25 <= median && median <= p75 && p75 <= max && mean >= min && mean <= max)) invalid(`${field}: summary ordering`)
  if (!bins.length || bins.length > 20_000 || !bins[0].count || !bins[bins.length - 1].count
    || bins.some((bin, i) => i > 0 && bin.lower !== bins[i - 1].upper)
    || safeSum(bins.map(bin => bin.count), `${field}.count`) !== count
    || min < bins[0].lower || min >= bins[0].upper
    || max < bins[bins.length - 1].lower || max >= bins[bins.length - 1].upper) invalid(`${field}: histogram mismatch`)
  const boundsAt = (index: number): [number, number] => {
    if (index === 0) return [min, min]
    if (index === count - 1) return [max, max]
    let offset = 0
    for (const bin of bins) {
      offset += bin.count
      if (index < offset) return [Math.max(min, bin.lower), Math.min(max, bin.upper - 1)]
    }
    return invalid(`${field}: quantile position`)
  }
  for (const [p, value] of [[0.25, p25], [0.5, median], [0.75, p75]]) {
    const position = (count - 1) * p, fraction = position - Math.floor(position)
    const left = boundsAt(Math.floor(position)), right = boundsAt(Math.ceil(position))
    if (value < left[0] + (right[0] - left[0]) * fraction - 1e-8
      || value > left[1] + (right[1] - left[1]) * fraction + 1e-8) invalid(`${field}: quantile outside histogram`)
  }
  const meanLower = bins.reduce((sum, bin) => sum + Math.max(min, bin.lower) * bin.count / count, 0)
  const meanUpper = bins.reduce((sum, bin) => sum + Math.min(max, bin.upper - 1) * bin.count / count, 0)
  if (mean < meanLower - 1e-8 || mean > meanUpper + 1e-8) invalid(`${field}: mean outside histogram`)
  return { count, min, p25, median, p75, max, mean, bins }
}

function character(value: unknown): LegendCharacterAggregate {
  const input = record(value, 'character', ['characterId', 'name', 'count', 'mr'])
  const count = integer(input.count, 'character.count'), mr = distribution(input.mr, 'character.mr')
  if (mr.count !== count) invalid('character.mr.count: mismatch')
  return { characterId: characterId(input.characterId), name: characterName(input.name), count, mr }
}
function sameConditions(left: LegendAnalysisConditions, right: LegendAnalysisConditions): boolean {
  return left.region === right.region && left.platform === right.platform && left.characters === right.characters && left.users === right.users
}
function assertMatches(dataset: LegendAnalysisDataset, descriptor: LegendAnalysisDescriptor): void {
  if (dataset.id !== descriptor.id || dataset.act.id !== descriptor.actId || dataset.definitionVersion !== descriptor.definitionVersion
    || dataset.membershipRule !== descriptor.membershipRule || !sameConditions(dataset.conditions, descriptor.conditions)
    || dataset.captureStartedAt !== descriptor.captureStartedAt || dataset.captureEndedAt !== descriptor.captureEndedAt
    || dataset.totalCount !== descriptor.totalCount) throw new Error('選択した取得日とレジェンド分析データが一致しません。ページを再読み込みしてください。')
}

export function parseLegendAnalysisDataset(value: unknown, expected?: LegendAnalysisDescriptor): LegendAnalysisDataset {
  const input = record(value, 'dataset', ['schemaVersion', 'id', 'captureStartedAt', 'captureEndedAt', 'generatedAt', 'source',
    'act', 'definitionVersion', 'membershipRule', 'conditions', 'totalCount', 'characterIds', 'characters', 'mr', 'validation'])
  if (input.schemaVersion !== 1) invalid('schemaVersion')
  const capture = interval(input), generatedAt = time(input.generatedAt, 'generatedAt')
  if (generatedAt < capture.captureEndedAt) invalid('generatedAt: before capture')
  const act = record(input.act, 'act', ['id', 'label'])
  const characterIds = array(input.characterIds, 'characterIds').map(characterId)
  if (!characterIds.length) invalid('characterIds: empty')
  unique(characterIds, 'characterIds')
  const characters = array(input.characters, 'characters').map(character)
  unique(characters.map(item => item.characterId), 'characters.characterId')
  if (characters.length !== characterIds.length || characters.some(item => !characterIds.includes(item.characterId))) invalid('characters: incomplete roster')
  const totalCount = integer(input.totalCount, 'totalCount'), mr = distribution(input.mr, 'mr')
  if (safeSum(characters.map(item => item.count), 'characters.count') !== totalCount || mr.count !== totalCount) invalid('totalCount: mismatch')
  const combined = new Map<number, number>()
  for (const item of characters) for (const bin of item.mr.bins) combined.set(bin.lower, (combined.get(bin.lower) ?? 0) + bin.count)
  if (mr.bins.some(bin => bin.count !== (combined.get(bin.lower) ?? 0))
    || [...combined.keys()].some(lower => !mr.bins.some(bin => bin.lower === lower))) invalid('mr: character histogram mismatch')
  const present = characters.filter(item => item.count > 0)
  if (totalCount && (mr.min !== Math.min(...present.map(item => item.mr.min!)) || mr.max !== Math.max(...present.map(item => item.mr.max!))
    || Math.abs(mr.mean! - present.reduce((sum, item) => sum + item.mr.mean! * item.count / totalCount, 0)) > 1e-8)) invalid('mr: character summary mismatch')
  const validation = record(input.validation, 'validation', ['status', 'coverage', 'checks', 'notes'])
  if (validation.status !== 'verified' || validation.coverage !== 'all-listed-legend-entries') invalid('validation: incomplete')
  const checks = strings(validation.checks, 'validation.checks'), notes = strings(validation.notes, 'validation.notes')
  unique(checks, 'validation.checks')
  if (checks.length !== LEGEND_ANALYSIS_VALIDATION_CHECKS.length || LEGEND_ANALYSIS_VALIDATION_CHECKS.some(check => !checks.includes(check))) invalid('validation.checks: incomplete')
  if (!notes.length) invalid('validation.notes: empty')
  const sourceInput = record(input.source, 'source', ['url', 'title', 'population', 'metric', 'unit', 'notes'])
  if (sourceInput.unit !== 'account-character') invalid('source.unit')
  const dataset: LegendAnalysisDataset = {
    schemaVersion: 1, id: id(input.id, 'id'), ...capture, generatedAt,
    source: { ...source(sourceInput, true), population: text(sourceInput.population, 'source.population'),
      metric: text(sourceInput.metric, 'source.metric'), unit: 'account-character', notes: strings(sourceInput.notes, 'source.notes') },
    act: { id: id(act.id, 'act.id'), label: text(act.label, 'act.label') }, definitionVersion: id(input.definitionVersion, 'definitionVersion'),
    membershipRule: membership(input.membershipRule), conditions: conditions(input.conditions), totalCount, characterIds, characters, mr,
    validation: { status: 'verified', coverage: 'all-listed-legend-entries', checks, notes },
  }
  if (expected) assertMatches(dataset, parseLegendAnalysisDescriptor(expected))
  return dataset
}

/** Capture intervals must not overlap; a previous capture never crosses an Act or source definition. */
export function findPreviousLegendAnalysisDescriptor(manifest: LegendAnalysisManifest, current: LegendAnalysisDescriptor): LegendAnalysisDescriptor | null {
  const parsed = parseLegendAnalysisManifest(manifest), selected = parseLegendAnalysisDescriptor(current)
  return parsed.datasets.filter(item => item.id !== selected.id && item.captureEndedAt < selected.captureStartedAt
    && item.actId === selected.actId && item.definitionVersion === selected.definitionVersion && item.membershipRule === selected.membershipRule
    && sameConditions(item.conditions, selected.conditions)).sort((a, b) => b.captureEndedAt.localeCompare(a.captureEndedAt) || a.id.localeCompare(b.id))[0] ?? null
}

export function legendAnalysisCanCompare(current: LegendAnalysisDataset, previous: LegendAnalysisDataset): boolean {
  return current.act.id === previous.act.id && current.definitionVersion === previous.definitionVersion
    && current.membershipRule === previous.membershipRule && sameConditions(current.conditions, previous.conditions)
    && previous.captureEndedAt < current.captureStartedAt
}

export function createLegendCharacterRows(dataset: LegendAnalysisDataset, previous?: LegendAnalysisDataset | null): LegendCharacterRow[] {
  const current = parseLegendAnalysisDataset(dataset), prior = previous ? parseLegendAnalysisDataset(previous) : null
  const comparable = prior && legendAnalysisCanCompare(current, prior)
  const priorCharacters = new Map(comparable ? prior.characters.map(item => [item.characterId, item]) : [])
  return current.characters.map(item => {
    const earlier = priorCharacters.get(item.characterId)
    const percent = current.totalCount ? item.count / current.totalCount * 100 : null
    const previousCount = earlier?.count ?? null
    const previousPercent = earlier && prior!.totalCount ? earlier.count / prior!.totalCount * 100 : null
    return { ...item, percent, previousCount, previousPercent, countDelta: previousCount === null ? null : item.count - previousCount,
      percentagePointDelta: percent === null || previousPercent === null ? null : percent - previousPercent }
  }).sort((a, b) => b.count - a.count || a.characterId.localeCompare(b.characterId))
}
