import type {
  MrDistributionAvailability, MrDistributionConditions, MrDistributionDataset, MrDistributionDescriptor,
  MrDistributionEntry, MrDistributionManifest, MrDistributionObservation, MrDistributionRow, MrDistributionSource,
} from '../types/mrDistribution.ts'
import { parseRankDistributionDescriptor } from './rankDistribution.ts'

export const MR_DISTRIBUTION_THRESHOLDS: readonly number[] = Object.freeze(Array.from({ length: 25 }, (_, index) => (index + 1) * 100))
export const MR_DISTRIBUTION_SOURCE: MrDistributionSource = {
  url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/master', title: 'Buckler MRランキング',
}
export const MR_DISTRIBUTION_CONDITIONS: MrDistributionConditions = {
  ranking: 'master-rating', character: 'max-mr', act: 'current', region: 'all', platform: 'all',
}
/** Confirm listing conditions, rather than claiming unobserved accounts are unique or active. */
export const MR_DISTRIBUTION_CHECKS: readonly string[] = Object.freeze([
  'conditions-confirmed', 'pagination-confirmed', 'final-page-confirmed', 'ordering-confirmed',
  'max-mr-listing-confirmed', 'boundaries-rechecked', 'tail-confirmed', 'changes-recorded',
])

type UnknownRecord = Record<string, unknown>

function invalid(field: string): never {
  throw new Error(`MR分布データの形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string, keys: readonly string[]): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  const result = value as UnknownRecord
  if (Object.keys(result).some(key => !keys.includes(key))) invalid(`${field}: unknown field`)
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

function strings(value: unknown, field: string): string[] {
  return array(value, field).map(item => string(item, `${field}[]`))
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

function timestamp(value: unknown, field: string): string {
  const result = string(value, field)
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result)
  if (!match || !Number.isFinite(Date.parse(result))) invalid(field)
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid(field)
  return result
}

function source(value: unknown, extended = false): MrDistributionSource {
  const input = record(value, 'source', extended ? ['url', 'title', 'population', 'metric', 'unit', 'notes'] : ['url', 'title'])
  const url = string(input.url, 'source.url')
  let parsed: URL
  try { parsed = new URL(url) } catch { return invalid('source.url') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || !['www.streetfighter.com', 'streetfighter.com'].includes(parsed.hostname)
    || !/^\/6\/buckler\/[a-z]{2}(?:-[a-z]{2})?\/ranking\/master\/?$/i.test(parsed.pathname)) invalid('source.url')
  return { url, title: string(input.title, 'source.title') }
}

/** Capture descriptors use the same safe path and timestamp contract as LP snapshots. */
export function parseMrDistributionDescriptor(value: unknown): MrDistributionDescriptor {
  return parseRankDistributionDescriptor(value)
}

function availability(value: unknown): MrDistributionAvailability {
  const input = record(value, 'availability', ['status', 'message', 'checkedAt'])
  if (!['not-collected', 'verification-pending', 'collection-failed'].includes(input.status as string)) invalid('availability.status')
  return { status: input.status as MrDistributionAvailability['status'], message: string(input.message, 'availability.message'),
    checkedAt: timestamp(input.checkedAt, 'availability.checkedAt') }
}

export function parseMrDistributionManifest(value: unknown): MrDistributionManifest {
  const input = record(value, 'manifest', ['schemaVersion', 'generatedAt', 'source', 'datasets', 'availability'])
  const generatedAt = timestamp(input.generatedAt, 'generatedAt')
  const datasets = array(input.datasets, 'datasets').map(parseMrDistributionDescriptor)
  unique(datasets.map(item => item.id), 'datasets.id')
  unique(datasets.map(item => item.path.toLowerCase()), 'datasets.path')
  unique(datasets.map(item => `${Date.parse(item.captureStartedAt)}:${Date.parse(item.captureEndedAt)}`), 'datasets.capture interval')
  if (datasets.some(item => Date.parse(item.captureEndedAt) > Date.parse(generatedAt))) invalid('generatedAt: before capture')
  const result: MrDistributionManifest = { schemaVersion: schema(input.schemaVersion), generatedAt, source: source(input.source), datasets }
  if (input.availability !== undefined) {
    result.availability = availability(input.availability)
    if (Date.parse(result.availability.checkedAt) > Date.parse(generatedAt)) invalid('availability.checkedAt: after publication')
    if (result.availability.status === 'not-collected' && datasets.length) invalid('availability.status: datasets already collected')
  }
  return result
}

function entry(value: unknown): MrDistributionEntry {
  const input = record(value, 'entry', ['minimum', 'maximum', 'count'])
  const minimum = integer(input.minimum, 'entry.minimum')
  if (minimum > 2500 || minimum % 100 !== 0) invalid('entry.minimum: unknown bin')
  const maximum = minimum === 2500 ? null : minimum + 100
  if (input.maximum !== maximum) invalid('entry.maximum: exclusive bound mismatch')
  return { minimum, maximum, count: integer(input.count, 'entry.count') }
}

function observation(value: unknown, dataset: Omit<MrDistributionDataset, 'observation'>): MrDistributionObservation {
  const input = record(value, 'observation', ['totalAtStart', 'totalAtEnd', 'minTotal', 'maxTotal', 'boundaries'])
  const totalAtStart = integer(input.totalAtStart, 'observation.totalAtStart')
  const totalAtEnd = integer(input.totalAtEnd, 'observation.totalAtEnd')
  const minTotal = integer(input.minTotal, 'observation.minTotal')
  const maxTotal = integer(input.maxTotal, 'observation.maxTotal')
  if (minTotal > maxTotal) invalid('observation: reversed total range')
  if (totalAtEnd !== dataset.totalCount) invalid('observation.totalAtEnd: total mismatch')
  const boundaries = array(input.boundaries, 'observation.boundaries').map(value => {
    const item = record(value, 'observation.boundary', ['minimumMr', 'countAtOrAbove', 'totalCount', 'observedAt'])
    const minimumMr = integer(item.minimumMr, 'observation.boundary.minimumMr')
    if (!MR_DISTRIBUTION_THRESHOLDS.includes(minimumMr)) invalid('observation.boundary.minimumMr: unknown boundary')
    const countAtOrAbove = integer(item.countAtOrAbove, 'observation.boundary.countAtOrAbove')
    const totalCount = integer(item.totalCount, 'observation.boundary.totalCount')
    if (countAtOrAbove > totalCount) invalid('observation.boundary.countAtOrAbove: exceeds observed total')
    const observedAt = timestamp(item.observedAt, 'observation.boundary.observedAt')
    if (Date.parse(observedAt) < Date.parse(dataset.captureStartedAt) || Date.parse(observedAt) > Date.parse(dataset.captureEndedAt)) {
      invalid('observation.boundary.observedAt: outside capture')
    }
    return { minimumMr, countAtOrAbove, totalCount, observedAt }
  })
  if (boundaries.length !== 25) invalid('observation.boundaries: all 25 boundaries required')
  unique(boundaries.map(item => item.minimumMr), 'observation.boundaries.minimumMr')
  if ([totalAtStart, totalAtEnd, ...boundaries.map(item => item.totalCount)].some(total => total < minTotal || total > maxTotal)) {
    invalid('observation: total outside range')
  }
  const counts = new Map(dataset.entries.map(item => [item.minimum, item.count]))
  const cumulative = new Map(boundaries.map(item => [item.minimumMr, item.countAtOrAbove]))
  let countAtOrAbove = 0
  for (const minimum of [...MR_DISTRIBUTION_THRESHOLDS].reverse()) {
    countAtOrAbove += counts.get(minimum)!
    if (cumulative.get(minimum) !== countAtOrAbove) invalid('observation.boundaries: entry cumulative mismatch')
  }
  return { totalAtStart, totalAtEnd, minTotal, maxTotal, boundaries }
}

function assertMatches(dataset: MrDistributionDataset, descriptor: MrDistributionDescriptor): void {
  for (const key of ['id', 'captureStartedAt', 'captureEndedAt', 'totalCount'] as const) {
    if (dataset[key] !== descriptor[key]) throw new Error(`選択した取得日とMR分布データが一致しません（${key}）。ページを再読み込みしてください。`)
  }
}

export function parseMrDistributionDataset(value: unknown, expected?: MrDistributionDescriptor): MrDistributionDataset {
  const input = record(value, 'dataset', ['schemaVersion', 'id', 'captureStartedAt', 'captureEndedAt', 'generatedAt',
    'source', 'conditions', 'method', 'binWidth', 'totalCount', 'entries', 'observation', 'validation'])
  const captureStartedAt = timestamp(input.captureStartedAt, 'captureStartedAt')
  const captureEndedAt = timestamp(input.captureEndedAt, 'captureEndedAt')
  const generatedAt = timestamp(input.generatedAt, 'generatedAt')
  if (Date.parse(captureStartedAt) > Date.parse(captureEndedAt)) invalid('capture interval: reversed')
  if (Date.parse(generatedAt) < Date.parse(captureEndedAt)) invalid('generatedAt: before capture')
  if (input.method !== 'boundary-search-estimate') invalid('method: estimates only')
  if (input.binWidth !== 100) invalid('binWidth')
  const totalCount = integer(input.totalCount, 'totalCount')
  const entries = array(input.entries, 'entries').map(entry)
  if (entries.length !== 26) invalid('entries: all 26 bins required')
  unique(entries.map(item => item.minimum), 'entries.minimum')
  const sum = entries.reduce((total, item) => total + item.count, 0)
  if (!Number.isSafeInteger(sum) || sum !== totalCount) invalid('entries.count: total mismatch')
  const conditionInput = record(input.conditions, 'conditions', Object.keys(MR_DISTRIBUTION_CONDITIONS))
  for (const key of Object.keys(MR_DISTRIBUTION_CONDITIONS) as (keyof MrDistributionConditions)[]) {
    if (conditionInput[key] !== MR_DISTRIBUTION_CONDITIONS[key]) invalid(`conditions.${key}`)
  }
  const validation = record(input.validation, 'validation', ['status', 'coverage', 'checks', 'notes'])
  if (validation.status !== 'estimated') invalid('validation.status: estimates only')
  if (validation.coverage !== 'all-mr-boundaries') invalid('validation.coverage: incomplete')
  const checks = strings(validation.checks, 'validation.checks')
  unique(checks, 'validation.checks')
  if (checks.length !== MR_DISTRIBUTION_CHECKS.length || MR_DISTRIBUTION_CHECKS.some(check => !checks.includes(check))) {
    invalid('validation.checks: incomplete')
  }
  const notes = strings(validation.notes, 'validation.notes')
  if (!notes.length) invalid('validation.notes: empty')
  const sourceInput = record(input.source, 'source', ['url', 'title', 'population', 'metric', 'unit', 'notes'])
  if (sourceInput.unit !== 'fighter-account') invalid('source.unit')
  const identity = parseMrDistributionDescriptor({ id: input.id, path: 'capture.json', captureStartedAt, captureEndedAt, totalCount })
  const dataset: Omit<MrDistributionDataset, 'observation'> = {
    schemaVersion: schema(input.schemaVersion), id: identity.id, captureStartedAt, captureEndedAt, generatedAt,
    source: { ...source(sourceInput, true), population: string(sourceInput.population, 'source.population'),
      metric: string(sourceInput.metric, 'source.metric'), unit: 'fighter-account', notes: strings(sourceInput.notes, 'source.notes') },
    conditions: { ...MR_DISTRIBUTION_CONDITIONS }, method: 'boundary-search-estimate', binWidth: 100, totalCount, entries,
    validation: { status: 'estimated', coverage: 'all-mr-boundaries', checks, notes },
  }
  const result: MrDistributionDataset = { ...dataset, observation: observation(input.observation, dataset) }
  if (expected) assertMatches(result, parseMrDistributionDescriptor(expected))
  return result
}

const manifestRequests = new Map<string, Promise<MrDistributionManifest>>()
const datasetRequests = new Map<string, Promise<MrDistributionDataset>>()

function dataUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? '/'
  return `${base.endsWith('/') ? base : `${base}/`}data/mr-distribution/${path}`
}

function loadJson<T>(url: string, parse: (value: unknown) => T, cache: Map<string, Promise<T>>): Promise<T> {
  const existing = cache.get(url)
  if (existing) return existing
  const request = Promise.resolve().then(() => fetch(url)).then(async response => {
    if (!response.ok) throw new Error('MR分布データを読み込めませんでした。もう一度お試しください。')
    return parse(await response.json())
  }).catch(cause => { if (cache.get(url) === request) cache.delete(url); throw cause })
  cache.set(url, request)
  return request
}

export function loadMrDistributionManifest(): Promise<MrDistributionManifest> {
  return loadJson(dataUrl('index.json'), parseMrDistributionManifest, manifestRequests)
}

export function loadMrDistributionDataset(descriptor: MrDistributionDescriptor, publicationVersion?: string): Promise<MrDistributionDataset> {
  const expected = parseMrDistributionDescriptor(descriptor)
  const publication = publicationVersion === undefined ? '' : `&published=${encodeURIComponent(timestamp(publicationVersion, 'publicationVersion'))}`
  const url = `${dataUrl(expected.path)}?v=${encodeURIComponent(expected.captureEndedAt)}${publication}`
  const request = loadJson(url, parseMrDistributionDataset, datasetRequests)
  return request.then(dataset => { assertMatches(dataset, expected); return dataset }).catch(cause => {
    if (datasetRequests.get(url) === request) datasetRequests.delete(url)
    throw cause
  })
}

export function mrDistributionBinLabel(minimum: number, maximum: number | null): string {
  entry({ minimum, maximum, count: 0 })
  return maximum === null ? `${minimum}以上` : `${minimum}〜${maximum - 1}`
}

/** Preserve raw counts and percentages; the UI decides display rounding. */
export function createMrDistributionRows(dataset: MrDistributionDataset): MrDistributionRow[] {
  const parsed = parseMrDistributionDataset(dataset)
  const sorted = [...parsed.entries].sort((a, b) => a.minimum - b.minimum)
  const cumulative = new Map<number, number>()
  let count = 0
  for (const bin of [...sorted].reverse()) { count += bin.count; cumulative.set(bin.minimum, count) }
  const percent = (value: number): number | null => parsed.totalCount === 0 ? null : value / parsed.totalCount * 100
  return sorted.map(bin => ({ id: `mr-${bin.minimum}`, label: mrDistributionBinLabel(bin.minimum, bin.maximum), group: 'MR', rankId: null,
    count: bin.count, percent: percent(bin.count), cumulativeCount: cumulative.get(bin.minimum)!, cumulativePercent: percent(cumulative.get(bin.minimum)!) }))
}
