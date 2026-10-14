import type {
  UsageRateControlType, UsageRateDataset, UsageRateDatasetDescriptor, UsageRateDistribution,
  UsageRateEdition, UsageRateEntry, UsageRateHistoryResult, UsageRateManifest, UsageRateSelection, UsageRateSource, UsageRateTotalMismatch,
} from '../types/usageRates.ts'
import { WIN_RATE_EDITION_LEAGUES } from './winRateConditions.ts'

export const USAGE_RATE_EDITIONS = ['general', 'master'] as const
export const USAGE_RATE_EDITION_LEAGUES: Readonly<Record<UsageRateEdition, readonly string[]>> = {
  general: ['ALL', ...WIN_RATE_EDITION_LEAGUES.general],
  master: WIN_RATE_EDITION_LEAGUES.master,
}
export const USAGE_RATE_EDITION_OPERATION_MODES: Readonly<Record<UsageRateEdition, readonly ('combined' | 'separate')[]>> = {
  general: ['combined', 'separate'], master: ['combined'],
}
export const USAGE_RATE_EDITION_SOURCES: Readonly<Record<UsageRateEdition, UsageRateSource>> = {
  general: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/usagerate', title: 'Buckler 総合版 キャラクター使用率' },
  master: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/usagerate_master', title: 'Buckler マスター版 キャラクター使用率' },
}
export const USAGE_RATE_LEAGUES = USAGE_RATE_EDITION_LEAGUES.general
export const USAGE_RATE_SOURCE = USAGE_RATE_EDITION_SOURCES.general

export function usageRateEditionOf(value: { edition?: UsageRateEdition }): UsageRateEdition {
  return value.edition ?? 'general'
}
type UnknownRecord = Record<string, unknown>

function invalid(field: string): never {
  throw new Error(`使用率データの形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as UnknownRecord
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) invalid(field)
  return value
}

function id(value: unknown, field: string): string {
  const result = string(value, field)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) invalid(field)
  return result
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field)
  return value
}

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(`${field}: duplicate`)
}

function schema(value: unknown): 1 {
  if (value !== 1) invalid('schemaVersion')
  return value
}

function month(value: unknown): string {
  const result = string(value, 'month')
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(result)) invalid('month')
  return result
}

function league(value: unknown, edition: UsageRateEdition = 'general'): string {
  const result = string(value, 'league')
  if (!USAGE_RATE_EDITION_LEAGUES[edition].includes(result)) invalid('league')
  return result
}

function conditions(input: UnknownRecord): Pick<UsageRateDatasetDescriptor, 'edition' | 'league'> {
  if (input.edition !== undefined && input.edition !== 'general' && input.edition !== 'master') invalid('edition')
  const edition = input.edition ?? 'general'
  return { ...(input.edition === undefined ? {} : { edition }), league: league(input.league, edition) }
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field)
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result)
  if (!match || !Number.isFinite(Date.parse(result))) invalid(field)
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (monthNumber < 1 || monthNumber > 12 || day < 1 || day > days[monthNumber - 1]) invalid(field)
  return result
}

function source(value: unknown, edition: UsageRateEdition = 'general'): UsageRateSource {
  const input = record(value, 'source')
  const url = string(input.url, 'source.url')
  let parsed: URL
  try { parsed = new URL(url) } catch { return invalid('source.url') }
  const sourcePath = parsed.pathname.match(/^\/6\/buckler\/[a-z]{2}(?:-[a-z]{2})?\/stats\/(usagerate|usagerate_master)\/?$/i)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || !['www.streetfighter.com', 'streetfighter.com'].includes(parsed.hostname)
    || sourcePath?.[1].toLowerCase() !== (edition === 'master' ? 'usagerate_master' : 'usagerate')) invalid('source.url')
  return { url, title: string(input.title, 'source.title') }
}

function datasetPath(value: unknown): string {
  const path = string(value, 'path')
  if (!path.endsWith('.json') || path.toLowerCase() === 'index.json'
    || path.split('/').some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) invalid('path')
  return path
}

export function parseUsageRateDescriptor(value: unknown): UsageRateDatasetDescriptor {
  const input = record(value, 'dataset descriptor')
  return {
    id: id(input.id, 'id'), month: month(input.month), ...conditions(input),
    path: datasetPath(input.path), capturedAt: timestamp(input.capturedAt, 'capturedAt'),
  }
}

export function parseUsageRateManifest(value: unknown): UsageRateManifest {
  const input = record(value, 'manifest')
  const datasets = array(input.datasets, 'datasets').map(parseUsageRateDescriptor)
  if (!datasets.length) invalid('datasets: empty')
  unique(datasets.map((item) => item.id), 'datasets.id')
  unique(datasets.map((item) => item.path.toLowerCase()), 'datasets.path')
  unique(datasets.map((item) => `${usageRateEditionOf(item)}:${item.month}:${item.league}`), 'datasets.conditions')
  return {
    schemaVersion: schema(input.schemaVersion), generatedAt: timestamp(input.generatedAt, 'generatedAt'),
    source: source(input.source), datasets,
  }
}

/** Parse published percentages exactly, without normalizing the distribution to 100%. */
export function usageRatePercentThousandths(text: string): number | null {
  if (text === '-' || text === '-.---') return null
  const match = /^(0|[1-9]\d?|100)\.(\d{3})%?$/.exec(text)
  if (!match) invalid('entry.text')
  const value = Number(match[1]) * 1000 + Number(match[2])
  if (value > 100000) invalid('entry.text: range')
  return value
}

function entry(value: unknown): UsageRateEntry {
  const input = record(value, 'entry')
  const text = string(input.text, 'entry.text')
  const percentThousandths = usageRatePercentThousandths(text)
  if (input.percentThousandths !== percentThousandths) invalid('entry.percentThousandths: text mismatch')
  return { characterId: id(input.characterId, 'entry.characterId'), name: string(input.name, 'entry.name'), text, percentThousandths }
}

function totalMismatch(
  value: unknown,
  observedTotal: number,
  context: { month: string; sourceUrl: string; generatedAt: string },
): UsageRateTotalMismatch {
  const input = record(value, 'distribution.totalMismatch')
  if (!Number.isSafeInteger(input.observedPercentThousandths) || input.observedPercentThousandths !== observedTotal) {
    invalid('distribution.totalMismatch.observedPercentThousandths: mismatch')
  }
  const verifiedAt = timestamp(input.verifiedAt, 'distribution.totalMismatch.verifiedAt')
  if (Date.parse(verifiedAt) > Date.parse(context.generatedAt)) invalid('distribution.totalMismatch.verifiedAt: later than generation')
  const sourceUrl = string(input.sourceUrl, 'distribution.totalMismatch.sourceUrl')
  let parsed: URL
  try { parsed = new URL(sourceUrl) } catch { return invalid('distribution.totalMismatch.sourceUrl') }
  const datasetSource = new URL(context.sourceUrl)
  const canonicalPath = datasetSource.pathname.replace(/\/$/, '')
  const evidencePath = parsed.pathname.replace(/\/$/, '')
  if (parsed.origin !== datasetSource.origin || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || (evidencePath !== canonicalPath && evidencePath !== `${canonicalPath}/${context.month.replace('-', '')}`)) {
    invalid('distribution.totalMismatch.sourceUrl: conditions mismatch')
  }
  return { observedPercentThousandths: observedTotal, verifiedAt, sourceUrl, reason: string(input.reason, 'distribution.totalMismatch.reason') }
}

function distribution(
  value: unknown,
  edition: UsageRateEdition,
  context: { month: string; sourceUrl: string; generatedAt: string },
): UsageRateDistribution {
  const input = record(value, 'distribution')
  if (!['all', 'classic', 'modern'].includes(input.controlType as string)) invalid('distribution.controlType')
  const entries = array(input.entries, 'distribution.entries').map(entry)
  if (!entries.length) invalid('distribution.entries: empty')
  unique(entries.map((item) => item.characterId), 'distribution.entries.characterId')
  // Three-decimal rounding may change the total by at most 0.0005 points per character.
  // Preserve exceptional official totals only when their explicit, source-linked recheck matches.
  // All unacknowledged partial or inconsistent distributions retain the strict sum check.
  const complete = entries.every((item) => item.percentThousandths !== null)
  const total = complete ? entries.reduce((sum, item) => sum + item.percentThousandths!, 0) : null
  const mismatched = total !== null && Math.abs(total - 100000) > entries.length * .5
  const acknowledgement = input.totalMismatch !== undefined
  if (mismatched && !acknowledgement) invalid('distribution.total: incomplete or inconsistent')
  if (acknowledgement && !mismatched) invalid('distribution.totalMismatch: no complete out-of-tolerance total')
  return {
    controlType: input.controlType as UsageRateControlType, month: month(input.month), league: league(input.league, edition), entries,
    ...(acknowledgement ? { totalMismatch: totalMismatch(input.totalMismatch, total!, context) } : {}),
  }
}

function assertMatches(dataset: UsageRateDataset, expected: UsageRateDatasetDescriptor): void {
  if (usageRateEditionOf(dataset) !== usageRateEditionOf(expected)) {
    throw new Error('選択した条件と使用率データが一致しません（edition）。ページを再読み込みしてください。')
  }
  for (const key of ['id', 'month', 'league', 'capturedAt'] as const) {
    if (dataset[key] !== expected[key]) {
      throw new Error(`選択した条件と使用率データが一致しません（${key}）。ページを再読み込みしてください。`)
    }
  }
}

export function parseUsageRateDataset(value: unknown, expected?: UsageRateDatasetDescriptor): UsageRateDataset {
  const input = record(value, 'dataset')
  const datasetMonth = month(input.month)
  const selectedConditions = conditions(input)
  const edition = usageRateEditionOf(selectedConditions)
  const datasetLeague = selectedConditions.league
  const sourceInput = record(input.source, 'source')
  const datasetSource = source(sourceInput, edition)
  const generatedAt = timestamp(input.generatedAt, 'generatedAt')
  const distributionContext = { month: datasetMonth, sourceUrl: datasetSource.url, generatedAt }
  const distributions = array(input.distributions, 'distributions').map((value) => distribution(value, edition, distributionContext))
  if (edition === 'general' && distributions.length !== 3) invalid('distributions: ALL/CLASSIC/MODERN required')
  if (edition === 'master' && (distributions.length !== 1 || distributions[0].controlType !== 'all')) invalid('distributions: MASTER ALL required')
  unique(distributions.map((item) => item.controlType), 'distributions.controlType')
  for (const item of distributions) {
    if (item.month !== datasetMonth || item.league !== datasetLeague) invalid('distribution.conditions: mismatch')
  }
  const dataset: UsageRateDataset = {
    schemaVersion: schema(input.schemaVersion), id: id(input.id, 'id'), month: datasetMonth, ...selectedConditions,
    capturedAt: timestamp(input.capturedAt, 'capturedAt'), generatedAt,
    source: {
      ...datasetSource, population: string(sourceInput.population, 'source.population'),
      metric: string(sourceInput.metric, 'source.metric'), unit: string(sourceInput.unit, 'source.unit'),
      notes: array(sourceInput.notes, 'source.notes').map((note) => string(note, 'source.notes[]')),
    },
    distributions,
  }
  if (expected) assertMatches(dataset, parseUsageRateDescriptor(expected))
  return dataset
}

const manifestRequests = new Map<string, Promise<UsageRateManifest>>()
const datasetRequests = new Map<string, Promise<UsageRateDataset>>()

function dataUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? '/'
  return `${base.endsWith('/') ? base : `${base}/`}data/usage-rates/${path}`
}

function loadJson<T>(url: string, parse: (value: unknown) => T, cache: Map<string, Promise<T>>, cacheKey = url): Promise<T> {
  const existing = cache.get(cacheKey)
  if (existing) return existing
  const request = Promise.resolve().then(() => fetch(url)).then(async (response) => {
    if (!response.ok) throw new Error('使用率データを読み込めませんでした。もう一度お試しください。')
    return parse(await response.json())
  }).catch((cause) => {
    if (cache.get(cacheKey) === request) cache.delete(cacheKey)
    throw cause
  })
  cache.set(cacheKey, request)
  return request
}

export function loadUsageRateManifest(): Promise<UsageRateManifest> {
  return loadJson(dataUrl('index.json'), parseUsageRateManifest, manifestRequests)
}

export function loadUsageRateDataset(
  value: UsageRateDatasetDescriptor,
  publicationVersion?: string,
  expectedSource?: UsageRateSource,
): Promise<UsageRateDataset> {
  const expected = parseUsageRateDescriptor(value)
  const versionQuery = publicationVersion === undefined ? ''
    : `&published=${encodeURIComponent(string(publicationVersion, 'publicationVersion'))}`
  const edition = usageRateEditionOf(expected)
  const selectedSource = expectedSource === undefined ? undefined : source(expectedSource, edition)
  const sourceQuery = selectedSource === undefined ? '' : `&source=${encodeURIComponent(selectedSource.url)}`
  const url = `${dataUrl(expected.path)}?v=${encodeURIComponent(expected.capturedAt)}${versionQuery}${sourceQuery}`
  const cacheKey = `${edition}:${url}`
  const request = loadJson(url, (value) => {
    const dataset = parseUsageRateDataset(value)
    if (selectedSource && dataset.source.url !== selectedSource.url) invalid('source.url: mismatch')
    return dataset
  }, datasetRequests, cacheKey)
  return request.then((dataset) => { assertMatches(dataset, expected); return dataset }).catch((cause) => {
    if (datasetRequests.get(cacheKey) === request) datasetRequests.delete(cacheKey)
    throw cause
  })
}

function monthIndex(value: string): number {
  month(value)
  const [year, number] = value.split('-').map(Number)
  return year * 12 + number - 1
}

function indexedMonth(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`
}

export function usageRateMonths(manifest: UsageRateManifest, selectedLeague?: string, edition: UsageRateEdition = 'general'): string[] {
  return [...new Set(manifest.datasets.filter((item) => usageRateEditionOf(item) === edition && (!selectedLeague || item.league === selectedLeague)).map((item) => month(item.month)))].sort()
}

export function usageRateCalendarMonths(manifest: UsageRateManifest, edition: UsageRateEdition = 'general'): string[] {
  const months = usageRateMonths(manifest, undefined, edition)
  if (!months.length) return []
  const from = monthIndex(months[0])
  const to = monthIndex(months[months.length - 1])
  return Array.from({ length: to - from + 1 }, (_, index) => indexedMonth(from + index))
}

export function initialUsageRateSelection(manifest: UsageRateManifest, edition: UsageRateEdition = 'general'): UsageRateSelection {
  const months = usageRateMonths(manifest, 'MASTER', edition).slice(-12)
  if (!months.length) throw new Error('MASTERの使用率データが登録されていません。')
  return { ...(edition === 'master' ? { edition } : {}), league: 'MASTER', fromMonth: months[0], toMonth: months[months.length - 1] }
}

export function usageRateSelectedMonths(selection: UsageRateSelection): string[] {
  conditions({ edition: selection.edition, league: selection.league })
  const from = monthIndex(selection.fromMonth)
  const to = monthIndex(selection.toMonth)
  if (from > to) throw new Error('開始月は終了月以前にしてください。')
  return Array.from({ length: to - from + 1 }, (_, index) => indexedMonth(from + index))
}

/** Include unregistered calendar months and keep load failures distinct from missing data. */
export async function loadUsageRateHistory(
  manifest: UsageRateManifest,
  selection: UsageRateSelection,
  loader: (descriptor: UsageRateDatasetDescriptor) => Promise<UsageRateDataset> =
    (descriptor) => loadUsageRateDataset(descriptor, manifest.generatedAt,
      usageRateEditionOf(descriptor) === 'master' ? USAGE_RATE_EDITION_SOURCES.master : manifest.source),
): Promise<UsageRateHistoryResult[]> {
  const months = usageRateSelectedMonths(selection)
  const selected = new Set(months)
  const edition = usageRateEditionOf(selection)
  const descriptors = new Map<string, UsageRateDatasetDescriptor>()
  for (const item of manifest.datasets) {
    if (usageRateEditionOf(item) !== edition || item.league !== selection.league || !selected.has(item.month)) continue
    if (descriptors.has(item.month)) throw new Error('同じ月・リーグの使用率データが重複しています。')
    descriptors.set(item.month, item)
  }
  const results = new Array<UsageRateHistoryResult>(months.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < months.length) {
      const index = next++
      const selectedMonth = months[index]
      const descriptor = descriptors.get(selectedMonth)
      if (!descriptor) { results[index] = { month: selectedMonth, status: 'missing' }; continue }
      try {
        const dataset = parseUsageRateDataset(await loader(descriptor), descriptor)
        const expectedSource = edition === 'master' ? USAGE_RATE_EDITION_SOURCES.master : manifest.source
        if (dataset.source.url !== expectedSource.url) invalid('source.url: mismatch')
        results[index] = { month: selectedMonth, descriptor, status: 'ready', dataset }
      } catch {
        results[index] = { month: selectedMonth, descriptor, status: 'error' }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, months.length) }, () => worker()))
  return results
}
