import type {
  UsageRateControlType, UsageRateDataset, UsageRateDatasetDescriptor, UsageRateDistribution,
  UsageRateEntry, UsageRateHistoryResult, UsageRateManifest, UsageRateSelection, UsageRateSource,
} from '../types/usageRates.ts'
import { WIN_RATE_EDITION_LEAGUES } from './winRateConditions.ts'

export const USAGE_RATE_LEAGUES: readonly string[] = ['ALL', ...WIN_RATE_EDITION_LEAGUES.general]
export const USAGE_RATE_SOURCE: UsageRateSource = {
  url: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/usagerate',
  title: 'Buckler 総合版 キャラクター使用率',
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

function league(value: unknown): string {
  const result = string(value, 'league')
  if (!USAGE_RATE_LEAGUES.includes(result)) invalid('league')
  return result
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

function source(value: unknown): UsageRateSource {
  const input = record(value, 'source')
  const url = string(input.url, 'source.url')
  let parsed: URL
  try { parsed = new URL(url) } catch { return invalid('source.url') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || !['www.streetfighter.com', 'streetfighter.com'].includes(parsed.hostname)
    || !/^\/6\/buckler\/[a-z]{2}(?:-[a-z]{2})?\/stats\/usagerate\/?$/i.test(parsed.pathname)) invalid('source.url')
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
    id: id(input.id, 'id'), month: month(input.month), league: league(input.league),
    path: datasetPath(input.path), capturedAt: timestamp(input.capturedAt, 'capturedAt'),
  }
}

export function parseUsageRateManifest(value: unknown): UsageRateManifest {
  const input = record(value, 'manifest')
  const datasets = array(input.datasets, 'datasets').map(parseUsageRateDescriptor)
  if (!datasets.length) invalid('datasets: empty')
  unique(datasets.map((item) => item.id), 'datasets.id')
  unique(datasets.map((item) => item.path.toLowerCase()), 'datasets.path')
  unique(datasets.map((item) => `${item.month}:${item.league}`), 'datasets.conditions')
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

function distribution(value: unknown): UsageRateDistribution {
  const input = record(value, 'distribution')
  if (!['all', 'classic', 'modern'].includes(input.controlType as string)) invalid('distribution.controlType')
  const entries = array(input.entries, 'distribution.entries').map(entry)
  if (!entries.length) invalid('distribution.entries: empty')
  unique(entries.map((item) => item.characterId), 'distribution.entries.characterId')
  // Three-decimal rounding may change the total by at most 0.0005 points per character.
  // Keep the published values intact; a partial positive-share distribution must not be normalized.
  if (entries.every((item) => item.percentThousandths !== null)) {
    const total = entries.reduce((sum, item) => sum + item.percentThousandths!, 0)
    if (Math.abs(total - 100000) > entries.length * .5) invalid('distribution.total: incomplete or inconsistent')
  }
  return { controlType: input.controlType as UsageRateControlType, month: month(input.month), league: league(input.league), entries }
}

function assertMatches(dataset: UsageRateDataset, expected: UsageRateDatasetDescriptor): void {
  for (const key of ['id', 'month', 'league', 'capturedAt'] as const) {
    if (dataset[key] !== expected[key]) {
      throw new Error(`選択した条件と使用率データが一致しません（${key}）。ページを再読み込みしてください。`)
    }
  }
}

export function parseUsageRateDataset(value: unknown, expected?: UsageRateDatasetDescriptor): UsageRateDataset {
  const input = record(value, 'dataset')
  const datasetMonth = month(input.month)
  const datasetLeague = league(input.league)
  const distributions = array(input.distributions, 'distributions').map(distribution)
  if (distributions.length !== 3) invalid('distributions: ALL/CLASSIC/MODERN required')
  unique(distributions.map((item) => item.controlType), 'distributions.controlType')
  const allIds = new Set(distributions[0].entries.map((item) => item.characterId))
  for (const item of distributions) {
    if (item.month !== datasetMonth || item.league !== datasetLeague) invalid('distribution.conditions: mismatch')
    if (item.entries.length !== allIds.size || item.entries.some((entry) => !allIds.has(entry.characterId))) {
      invalid('distribution.characterIds: mismatch')
    }
  }
  const sourceInput = record(input.source, 'source')
  const dataset: UsageRateDataset = {
    schemaVersion: schema(input.schemaVersion), id: id(input.id, 'id'), month: datasetMonth, league: datasetLeague,
    capturedAt: timestamp(input.capturedAt, 'capturedAt'), generatedAt: timestamp(input.generatedAt, 'generatedAt'),
    source: {
      ...source(sourceInput), population: string(sourceInput.population, 'source.population'),
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

function loadJson<T>(url: string, parse: (value: unknown) => T, cache: Map<string, Promise<T>>): Promise<T> {
  const existing = cache.get(url)
  if (existing) return existing
  const request = Promise.resolve().then(() => fetch(url)).then(async (response) => {
    if (!response.ok) throw new Error('使用率データを読み込めませんでした。もう一度お試しください。')
    return parse(await response.json())
  }).catch((cause) => {
    if (cache.get(url) === request) cache.delete(url)
    throw cause
  })
  cache.set(url, request)
  return request
}

export function loadUsageRateManifest(): Promise<UsageRateManifest> {
  return loadJson(dataUrl('index.json'), parseUsageRateManifest, manifestRequests)
}

export function loadUsageRateDataset(value: UsageRateDatasetDescriptor, publicationVersion?: string): Promise<UsageRateDataset> {
  const expected = parseUsageRateDescriptor(value)
  const versionQuery = publicationVersion === undefined ? ''
    : `&published=${encodeURIComponent(string(publicationVersion, 'publicationVersion'))}`
  const url = `${dataUrl(expected.path)}?v=${encodeURIComponent(expected.capturedAt)}${versionQuery}`
  const request = loadJson(url, parseUsageRateDataset, datasetRequests)
  return request.then((dataset) => { assertMatches(dataset, expected); return dataset }).catch((cause) => {
    if (datasetRequests.get(url) === request) datasetRequests.delete(url)
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

export function usageRateMonths(manifest: UsageRateManifest, selectedLeague?: string): string[] {
  return [...new Set(manifest.datasets.filter((item) => !selectedLeague || item.league === selectedLeague).map((item) => month(item.month)))].sort()
}

export function usageRateCalendarMonths(manifest: UsageRateManifest): string[] {
  const months = usageRateMonths(manifest)
  if (!months.length) return []
  const from = monthIndex(months[0])
  const to = monthIndex(months[months.length - 1])
  return Array.from({ length: to - from + 1 }, (_, index) => indexedMonth(from + index))
}

export function initialUsageRateSelection(manifest: UsageRateManifest): UsageRateSelection {
  const months = usageRateMonths(manifest, 'MASTER').slice(-12)
  if (!months.length) throw new Error('MASTERの使用率データが登録されていません。')
  return { league: 'MASTER', fromMonth: months[0], toMonth: months[months.length - 1] }
}

export function usageRateSelectedMonths(selection: UsageRateSelection): string[] {
  league(selection.league)
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
    (descriptor) => loadUsageRateDataset(descriptor, manifest.generatedAt),
): Promise<UsageRateHistoryResult[]> {
  const months = usageRateSelectedMonths(selection)
  const selected = new Set(months)
  const descriptors = new Map<string, UsageRateDatasetDescriptor>()
  for (const item of manifest.datasets) {
    if (item.league !== selection.league || !selected.has(item.month)) continue
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
        results[index] = { month: selectedMonth, descriptor, status: 'ready', dataset }
      } catch {
        results[index] = { month: selectedMonth, descriptor, status: 'error' }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, months.length) }, () => worker()))
  return results
}
