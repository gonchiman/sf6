import type {
  WinRateCell,
  WinRateControlType,
  WinRateDataset,
  WinRateDatasetDescriptor,
  WinRateFighter,
  WinRateManifest,
  WinRateOperationMode,
  WinRateSource,
} from '../types/winRates.ts'

type UnknownRecord = Record<string, unknown>

function invalid(field: string): never {
  throw new Error(`勝率データの形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as UnknownRecord
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) invalid(field)
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

function schema(value: unknown): 1 {
  if (value !== 1) invalid('schemaVersion')
  return value
}

function month(value: unknown): string {
  const result = string(value, 'month')
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(result)) invalid('month')
  return result
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field)
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result)
  if (!match || !Number.isFinite(Date.parse(result))) invalid(field)
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  const day = Number(match[3])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (monthNumber < 1 || monthNumber > 12 || day < 1 || day > days[monthNumber - 1]) invalid(field)
  return result
}

function operationMode(value: unknown): WinRateOperationMode {
  if (value !== 'combined' && value !== 'separate') invalid('operationMode')
  return value
}

function source(value: unknown): WinRateSource {
  const input = record(value, 'source')
  const url = string(input.url, 'source.url')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return invalid('source.url')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || !['www.streetfighter.com', 'streetfighter.com'].includes(parsed.hostname)
    || !/^\/6\/buckler\/[a-z]{2}(?:-[a-z]{2})?\/stats\/dia\/?$/i.test(parsed.pathname)) {
    invalid('source.url')
  }
  return { url, title: string(input.title, 'source.title') }
}

function datasetPath(value: unknown): string {
  const path = string(value, 'path')
  const parts = path.split('/')
  if (!path.endsWith('.json') || path.toLowerCase() === 'index.json'
    || parts.some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) invalid('path')
  return path
}

function descriptor(value: unknown): WinRateDatasetDescriptor {
  const input = record(value, 'dataset descriptor')
  return {
    id: id(input.id, 'id'),
    month: month(input.month),
    league: string(input.league, 'league'),
    operationMode: operationMode(input.operationMode),
    path: datasetPath(input.path),
    capturedAt: timestamp(input.capturedAt, 'capturedAt'),
  }
}

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(`${field}: duplicate`)
}

export function parseWinRateManifest(value: unknown): WinRateManifest {
  const input = record(value, 'manifest')
  const datasets = array(input.datasets, 'datasets').map(descriptor)
  if (datasets.length === 0) invalid('datasets: empty')
  unique(datasets.map((item) => item.id), 'datasets.id')
  unique(datasets.map((item) => item.path.toLowerCase()), 'datasets.path')
  unique(datasets.map((item) => JSON.stringify([item.month, item.league, item.operationMode])), 'datasets.conditions')
  return {
    schemaVersion: schema(input.schemaVersion),
    generatedAt: timestamp(input.generatedAt, 'generatedAt'),
    source: source(input.source),
    datasets,
  }
}

function cell(value: unknown, field: string): WinRateCell {
  const input = record(value, field)
  if (typeof input.text !== 'string' || !/^(?:[0-9]\.\d{3}|10\.000|-|-\.---)$/.test(input.text)) invalid(`${field}.text`)
  if (typeof input.lowSample !== 'boolean') invalid(`${field}.lowSample`)
  return { text: input.text, lowSample: input.lowSample }
}

function fighter(value: unknown, mode: WinRateOperationMode): WinRateFighter {
  const input = record(value, 'fighter')
  const controlType = input.controlType
  if (mode === 'combined' ? controlType !== null : controlType !== 'classic' && controlType !== 'modern') {
    invalid('fighter.controlType')
  }
  return {
    id: id(input.id, 'fighter.id'),
    characterId: id(input.characterId, 'fighter.characterId'),
    name: string(input.name, 'fighter.name'),
    controlType: controlType as WinRateControlType,
  }
}

function assertMatches(dataset: WinRateDataset, expected: WinRateDatasetDescriptor): void {
  for (const key of ['id', 'month', 'league', 'operationMode', 'capturedAt'] as const) {
    if (dataset[key] !== expected[key]) {
      throw new Error(`選択した条件と勝率データが一致しません（${key}）。ページを再読み込みしてください。`)
    }
  }
}

export function parseWinRateDataset(value: unknown, expected?: WinRateDatasetDescriptor): WinRateDataset {
  const input = record(value, 'dataset')
  const mode = operationMode(input.operationMode)
  const fighters = array(input.fighters, 'fighters').map((item) => fighter(item, mode))
  if (fighters.length === 0) invalid('fighters: empty')
  unique(fighters.map((item) => item.id), 'fighters.id')
  unique(fighters.map((item) => JSON.stringify([item.characterId, item.controlType])), 'fighters.identity')
  const fighterIds = new Set(fighters.map((item) => item.id))
  const rows = array(input.rows, 'rows').map((value, index) => {
    const row = record(value, `rows[${index}]`)
    const fighterId = id(row.fighterId, `rows[${index}].fighterId`)
    if (!fighterIds.has(fighterId)) invalid(`rows[${index}].fighterId: unknown`)
    const cells = array(row.cells, `rows[${index}].cells`).map((value, column) => cell(value, `rows[${index}].cells[${column}]`))
    if (cells.length !== fighters.length) invalid(`rows[${index}].cells: length`)
    return { fighterId, total: cell(row.total, `rows[${index}].total`), cells }
  })
  if (rows.length !== fighters.length) invalid('rows: length')
  unique(rows.map((item) => item.fighterId), 'rows.fighterId')
  const sourceInput = record(input.source, 'source')
  const dataset: WinRateDataset = {
    schemaVersion: schema(input.schemaVersion),
    id: id(input.id, 'id'),
    month: month(input.month),
    league: string(input.league, 'league'),
    operationMode: mode,
    capturedAt: timestamp(input.capturedAt, 'capturedAt'),
    generatedAt: timestamp(input.generatedAt, 'generatedAt'),
    source: {
      ...source(sourceInput),
      population: string(sourceInput.population, 'source.population'),
      metric: string(sourceInput.metric, 'source.metric'),
      notes: array(sourceInput.notes, 'source.notes').map((note) => string(note, 'source.notes[]')),
    },
    fighters,
    rows,
  }
  if (expected) assertMatches(dataset, descriptor(expected))
  return dataset
}

const manifestRequests = new Map<string, Promise<WinRateManifest>>()
const datasetRequests = new Map<string, Promise<WinRateDataset>>()

function dataUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? '/'
  return `${base.endsWith('/') ? base : `${base}/`}data/win-rates/${path}`
}

function loadJson<T>(url: string, parse: (value: unknown) => T, cache: Map<string, Promise<T>>): Promise<T> {
  const existing = cache.get(url)
  if (existing) return existing
  const request = Promise.resolve().then(() => fetch(url)).then(async (response) => {
    if (!response.ok) throw new Error('勝率データを読み込めませんでした。もう一度お試しください。')
    return parse(await response.json())
  }).catch((cause) => {
    if (cache.get(url) === request) cache.delete(url)
    throw cause
  })
  cache.set(url, request)
  return request
}

export function loadWinRateManifest(): Promise<WinRateManifest> {
  return loadJson(dataUrl('index.json'), parseWinRateManifest, manifestRequests)
}

export function loadWinRateDataset(value: WinRateDatasetDescriptor): Promise<WinRateDataset> {
  const expected = descriptor(value)
  const url = `${dataUrl(expected.path)}?v=${encodeURIComponent(expected.capturedAt)}`
  const request = loadJson(url, parseWinRateDataset, datasetRequests)
  return request.then((dataset) => {
    assertMatches(dataset, expected)
    return dataset
  }).catch((cause) => {
    if (datasetRequests.get(url) === request) datasetRequests.delete(url)
    throw cause
  })
}
