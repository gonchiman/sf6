import type {
  RankDistributionAvailability, RankDistributionConditions, RankDistributionDataset,
  RankDistributionDescriptor, RankDistributionEntry, RankDistributionManifest,
  RankDistributionObservation, RankDistributionRow, RankDistributionSource, RankDistributionValidation,
} from '../types/rankDistribution.ts'
import { leagueLabel, WIN_RATE_EDITION_LEAGUES } from './winRateConditions.ts'

export const RANK_DISTRIBUTION_GROUPS: readonly string[] = WIN_RATE_EDITION_LEAGUES.general
export const RANK_DISTRIBUTION_SOURCE: RankDistributionSource = {
  url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league',
  title: 'Buckler LPランキング',
}
export const RANK_DISTRIBUTION_CONDITIONS: RankDistributionConditions = {
  league: 'all', character: 'max-lp', region: 'all', platform: 'all', users: 'buckler-user-status-1',
}
/** Every check must have been completed before a distribution can be published. */
export const RANK_DISTRIBUTION_VALIDATION_CHECKS: readonly string[] = [
  // Confirm the four visible selectors and fixed URL, without interpreting user_status=1 as all users.
  'conditions-confirmed', 'pagination-confirmed', 'final-page-confirmed', 'ordering-confirmed',
  'rank-mapping-confirmed', 'max-lp-account-unit-confirmed', 'total-count-stable',
  'boundaries-rechecked', 'unranked-tail-confirmed',
]
/** Estimates record changing totals and verify every rank boundary, rather than an atomic population. */
export const RANK_DISTRIBUTION_ESTIMATE_CHECKS: readonly string[] = RANK_DISTRIBUTION_VALIDATION_CHECKS
  .map((check) => check === 'total-count-stable' ? 'changes-recorded' : check)

type UnknownRecord = Record<string, unknown>

function invalid(field: string): never {
  throw new Error(`ランク分布データの形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string, keys: readonly string[]): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  const result = value as UnknownRecord
  // Reject accidental player identities and extra conditions instead of publishing hidden fields.
  if (Object.keys(result).some((key) => !keys.includes(key))) invalid(`${field}: unknown field`)
  return result
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) invalid(field)
  return value
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field)
  return value
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(field)
  return value
}

function unique(values: (number | string)[], field: string): void {
  if (new Set(values).size !== values.length) invalid(`${field}: duplicate`)
}

function schema(value: unknown): 1 {
  if (value !== 1) invalid('schemaVersion')
  return value
}

function id(value: unknown): string {
  const result = string(value, 'id')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) invalid('id')
  return result
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field)
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result)
  if (!match || !Number.isFinite(Date.parse(result))) invalid(field)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid(field)
  return result
}

function interval(input: UnknownRecord): { captureStartedAt: string; captureEndedAt: string } {
  const captureStartedAt = timestamp(input.captureStartedAt, 'captureStartedAt')
  const captureEndedAt = timestamp(input.captureEndedAt, 'captureEndedAt')
  if (Date.parse(captureStartedAt) > Date.parse(captureEndedAt)) invalid('capture interval: reversed')
  return { captureStartedAt, captureEndedAt }
}

function source(value: unknown, extended = false): RankDistributionSource {
  const input = record(value, 'source', extended
    ? ['url', 'title', 'population', 'metric', 'unit', 'notes'] : ['url', 'title'])
  const url = string(input.url, 'source.url')
  let parsed: URL
  try { parsed = new URL(url) } catch { return invalid('source.url') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || !['www.streetfighter.com', 'streetfighter.com'].includes(parsed.hostname)
    || !/^\/6\/buckler\/[a-z]{2}(?:-[a-z]{2})?\/ranking\/league\/?$/i.test(parsed.pathname)) invalid('source.url')
  return { url, title: string(input.title, 'source.title') }
}

function datasetPath(value: unknown): string {
  const result = string(value, 'path')
  if (!result.endsWith('.json') || result.toLowerCase() === 'index.json'
    || result.split('/').some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) invalid('path')
  return result
}

export function parseRankDistributionDescriptor(value: unknown): RankDistributionDescriptor {
  const input = record(value, 'dataset descriptor', ['id', 'path', 'captureStartedAt', 'captureEndedAt', 'totalCount'])
  return { id: id(input.id), path: datasetPath(input.path), ...interval(input), totalCount: integer(input.totalCount, 'totalCount') }
}

function availability(value: unknown): RankDistributionAvailability {
  const input = record(value, 'availability', ['status', 'message', 'checkedAt'])
  if (!['not-collected', 'verification-pending', 'collection-failed'].includes(input.status as string)) invalid('availability.status')
  return {
    status: input.status as RankDistributionAvailability['status'],
    message: string(input.message, 'availability.message'), checkedAt: timestamp(input.checkedAt, 'availability.checkedAt'),
  }
}

export function parseRankDistributionManifest(value: unknown): RankDistributionManifest {
  const input = record(value, 'manifest', ['schemaVersion', 'generatedAt', 'source', 'datasets', 'availability'])
  const generatedAt = timestamp(input.generatedAt, 'generatedAt')
  const datasets = array(input.datasets, 'datasets').map(parseRankDistributionDescriptor)
  unique(datasets.map((item) => item.id), 'datasets.id')
  unique(datasets.map((item) => item.path.toLowerCase()), 'datasets.path')
  unique(datasets.map((item) => `${Date.parse(item.captureStartedAt)}:${Date.parse(item.captureEndedAt)}`), 'datasets.capture interval')
  if (datasets.some((item) => Date.parse(item.captureEndedAt) > Date.parse(generatedAt))) invalid('generatedAt: before capture')
  const result: RankDistributionManifest = { schemaVersion: schema(input.schemaVersion), generatedAt, source: source(input.source), datasets }
  if (input.availability !== undefined) {
    result.availability = availability(input.availability)
    if (Date.parse(result.availability.checkedAt) > Date.parse(generatedAt)) invalid('availability.checkedAt: after publication')
    if (result.availability.status === 'not-collected' && datasets.length) invalid('availability.status: datasets already collected')
  }
  return result
}

function conditions(value: unknown): RankDistributionConditions {
  const input = record(value, 'conditions', Object.keys(RANK_DISTRIBUTION_CONDITIONS))
  for (const key of Object.keys(RANK_DISTRIBUTION_CONDITIONS) as (keyof RankDistributionConditions)[]) {
    if (input[key] !== RANK_DISTRIBUTION_CONDITIONS[key]) invalid(`conditions.${key}`)
  }
  return { ...RANK_DISTRIBUTION_CONDITIONS }
}

function strings(value: unknown, field: string): string[] {
  return array(value, field).map((item) => string(item, `${field}[]`))
}

function validation(value: unknown, estimated: boolean): RankDistributionValidation {
  const input = record(value, 'validation', ['status', 'coverage', 'checks', 'notes'])
  if (input.status !== (estimated ? 'estimated' : 'verified')) invalid('validation.status: unverified')
  if (input.coverage !== (estimated ? 'all-rank-boundaries' : 'all-listed-accounts')) invalid('validation.coverage: incomplete')
  const checks = strings(input.checks, 'validation.checks')
  unique(checks, 'validation.checks')
  const required = estimated ? RANK_DISTRIBUTION_ESTIMATE_CHECKS : RANK_DISTRIBUTION_VALIDATION_CHECKS
  if (checks.length !== required.length || required.some((check) => !checks.includes(check))) invalid('validation.checks: incomplete')
  const notes = strings(input.notes, 'validation.notes')
  if (!notes.length) invalid('validation.notes: empty')
  return estimated ? { status: 'estimated', coverage: 'all-rank-boundaries', checks, notes }
    : { status: 'verified', coverage: 'all-listed-accounts', checks, notes }
}

function entry(value: unknown): RankDistributionEntry {
  const input = record(value, 'entry', ['rankId', 'count'])
  const rankId = integer(input.rankId, 'entry.rankId')
  if (rankId < 1 || rankId > 36) invalid('entry.rankId: unknown rank')
  return { rankId, count: integer(input.count, 'entry.count') }
}

function observation(value: unknown, dataset: RankDistributionDataset): RankDistributionObservation {
  const input = record(value, 'observation', ['totalAtStart', 'totalAtEnd', 'minTotal', 'maxTotal', 'boundaries'])
  const totalAtStart = integer(input.totalAtStart, 'observation.totalAtStart')
  const totalAtEnd = integer(input.totalAtEnd, 'observation.totalAtEnd')
  const minTotal = integer(input.minTotal, 'observation.minTotal')
  const maxTotal = integer(input.maxTotal, 'observation.maxTotal')
  if (minTotal > maxTotal) invalid('observation: reversed total range')
  if (totalAtEnd !== dataset.totalCount) invalid('observation.totalAtEnd: total mismatch')
  const boundaries = array(input.boundaries, 'observation.boundaries').map((value) => {
    const item = record(value, 'observation.boundary', ['rankId', 'countAtOrAbove', 'totalCount', 'observedAt'])
    const rankId = integer(item.rankId, 'observation.boundary.rankId')
    if (rankId < 2 || rankId > 36) invalid('observation.boundary.rankId: unknown boundary')
    const countAtOrAbove = integer(item.countAtOrAbove, 'observation.boundary.countAtOrAbove')
    const totalCount = integer(item.totalCount, 'observation.boundary.totalCount')
    if (countAtOrAbove > totalCount) invalid('observation.boundary.countAtOrAbove: exceeds observed total')
    const observedAt = timestamp(item.observedAt, 'observation.boundary.observedAt')
    const observedTime = Date.parse(observedAt)
    if (observedTime < Date.parse(dataset.captureStartedAt) || observedTime > Date.parse(dataset.captureEndedAt)) {
      invalid('observation.boundary.observedAt: outside capture')
    }
    return { rankId, countAtOrAbove, totalCount, observedAt }
  })
  if (boundaries.length !== 35) invalid('observation.boundaries: all 35 boundaries required')
  unique(boundaries.map((item) => item.rankId), 'observation.boundaries.rankId')
  if ([totalAtStart, totalAtEnd, ...boundaries.map((item) => item.totalCount)]
    .some((total) => total < minTotal || total > maxTotal)) invalid('observation: total outside range')
  const counts = new Map(dataset.entries.map((item) => [item.rankId, item.count]))
  const boundaryCounts = new Map(boundaries.map((item) => [item.rankId, item.countAtOrAbove]))
  let cumulativeCount = 0
  for (let rankId = 36; rankId >= 2; rankId -= 1) {
    cumulativeCount += counts.get(rankId)!
    if (boundaryCounts.get(rankId) !== cumulativeCount) invalid('observation.boundaries: entry cumulative mismatch')
  }
  return { totalAtStart, totalAtEnd, minTotal, maxTotal, boundaries }
}

function assertMatches(dataset: RankDistributionDataset, descriptor: RankDistributionDescriptor): void {
  for (const key of ['id', 'captureStartedAt', 'captureEndedAt', 'totalCount'] as const) {
    if (dataset[key] !== descriptor[key]) {
      throw new Error(`選択した取得日とランク分布データが一致しません（${key}）。ページを再読み込みしてください。`)
    }
  }
}

export function parseRankDistributionDataset(value: unknown, expected?: RankDistributionDescriptor): RankDistributionDataset {
  const input = record(value, 'dataset', [
    'schemaVersion', 'id', 'captureStartedAt', 'captureEndedAt', 'generatedAt', 'source',
    'conditions', 'method', 'totalCount', 'entries', 'validation', 'observation',
  ])
  const capture = interval(input)
  const generatedAt = timestamp(input.generatedAt, 'generatedAt')
  if (Date.parse(generatedAt) < Date.parse(capture.captureEndedAt)) invalid('generatedAt: before capture')
  if (input.method !== 'boundary-search' && input.method !== 'boundary-search-estimate') invalid('method')
  const estimated = input.method === 'boundary-search-estimate'
  if (!estimated && Object.hasOwn(input, 'observation')) invalid('observation: estimates only')
  const totalCount = integer(input.totalCount, 'totalCount')
  const entries = array(input.entries, 'entries').map(entry)
  if (entries.length !== 36) invalid('entries: all 36 ranks required')
  unique(entries.map((item) => item.rankId), 'entries.rankId')
  const sum = entries.reduce((total, item) => total + item.count, 0)
  if (!Number.isSafeInteger(sum) || sum !== totalCount) invalid('entries.count: total mismatch')
  const sourceInput = record(input.source, 'source', ['url', 'title', 'population', 'metric', 'unit', 'notes'])
  if (sourceInput.unit !== 'fighter-account') invalid('source.unit')
  const dataset: RankDistributionDataset = {
    schemaVersion: schema(input.schemaVersion), id: id(input.id), ...capture, generatedAt,
    source: {
      ...source(sourceInput, true), population: string(sourceInput.population, 'source.population'),
      metric: string(sourceInput.metric, 'source.metric'), unit: 'fighter-account', notes: strings(sourceInput.notes, 'source.notes'),
    },
    conditions: conditions(input.conditions), method: input.method, totalCount, entries,
    validation: validation(input.validation, estimated),
  }
  if (estimated) dataset.observation = observation(input.observation, dataset)
  if (expected) assertMatches(dataset, parseRankDistributionDescriptor(expected))
  return dataset
}

const manifestRequests = new Map<string, Promise<RankDistributionManifest>>()
const datasetRequests = new Map<string, Promise<RankDistributionDataset>>()

function dataUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? '/'
  return `${base.endsWith('/') ? base : `${base}/`}data/rank-distribution/${path}`
}

function loadJson<T>(url: string, parse: (value: unknown) => T, cache: Map<string, Promise<T>>): Promise<T> {
  const existing = cache.get(url)
  if (existing) return existing
  const request = Promise.resolve().then(() => fetch(url)).then(async (response) => {
    if (!response.ok) throw new Error('ランク分布データを読み込めませんでした。もう一度お試しください。')
    return parse(await response.json())
  }).catch((cause) => {
    if (cache.get(url) === request) cache.delete(url)
    throw cause
  })
  cache.set(url, request)
  return request
}

export function loadRankDistributionManifest(): Promise<RankDistributionManifest> {
  return loadJson(dataUrl('index.json'), parseRankDistributionManifest, manifestRequests)
}

export function loadRankDistributionDataset(descriptor: RankDistributionDescriptor, publicationVersion?: string): Promise<RankDistributionDataset> {
  const expected = parseRankDistributionDescriptor(descriptor)
  const publication = publicationVersion === undefined ? ''
    : `&published=${encodeURIComponent(timestamp(publicationVersion, 'publicationVersion'))}`
  const url = `${dataUrl(expected.path)}?v=${encodeURIComponent(expected.captureEndedAt)}${publication}`
  const request = loadJson(url, parseRankDistributionDataset, datasetRequests)
  return request.then((dataset) => { assertMatches(dataset, expected); return dataset }).catch((cause) => {
    if (datasetRequests.get(url) === request) datasetRequests.delete(url)
    throw cause
  })
}

export function rankDistributionRankLabel(rankId: number): string {
  if (!Number.isInteger(rankId) || rankId < 1 || rankId > 36) invalid('rankId: unknown rank')
  if (rankId === 36) return leagueLabel('MASTER')
  const group = RANK_DISTRIBUTION_GROUPS[Math.floor((rankId - 1) / 5)]
  return `${leagueLabel(group)} ★${(rankId - 1) % 5 + 1}`
}

/** Aggregate counts first; percentages and global cumulative counts are calculated before rounding. */
export function createRankDistributionRows(dataset: RankDistributionDataset, group = 'ALL'): RankDistributionRow[] {
  const parsed = parseRankDistributionDataset(dataset)
  if (group !== 'ALL' && !RANK_DISTRIBUTION_GROUPS.includes(group)) invalid('group')
  const counts = new Map(parsed.entries.map((item) => [item.rankId, item.count]))
  const cumulative = new Map<number, number>()
  let cumulativeCount = 0
  for (let rankId = 36; rankId >= 1; rankId -= 1) {
    cumulativeCount += counts.get(rankId)!
    cumulative.set(rankId, cumulativeCount)
  }
  const percent = (count: number): number | null => parsed.totalCount === 0 ? null : count / parsed.totalCount * 100
  const groups = group === 'ALL' ? RANK_DISTRIBUTION_GROUPS : [group]
  return groups.flatMap((selected): RankDistributionRow[] => {
    const index = RANK_DISTRIBUTION_GROUPS.indexOf(selected)
    const firstRank = index * 5 + 1
    const rankIds = selected === 'MASTER' ? [36] : Array.from({ length: 5 }, (_, offset) => firstRank + offset)
    if (group !== 'ALL') return rankIds.map((rankId) => ({
      id: String(rankId), label: rankDistributionRankLabel(rankId), group: selected, rankId,
      count: counts.get(rankId)!, percent: percent(counts.get(rankId)!),
      cumulativeCount: cumulative.get(rankId)!, cumulativePercent: percent(cumulative.get(rankId)!),
    }))
    const count = rankIds.reduce((total, rankId) => total + counts.get(rankId)!, 0)
    return [{
      id: selected, label: leagueLabel(selected), group: selected, rankId: selected === 'MASTER' ? 36 : null,
      count, percent: percent(count), cumulativeCount: cumulative.get(firstRank)!, cumulativePercent: percent(cumulative.get(firstRank)!),
    }]
  })
}
