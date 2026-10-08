import type {
  CharacterDataset, CharacterDescriptor, CharacterManifest, CharacterMove,
  CharacterMoveFilters, CharacterMoveSort,
} from '../types/characters.ts'

type UnknownRecord = Record<string, unknown>

function invalid(field: string): never {
  throw new Error(`キャラクターデータの形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as UnknownRecord
}

function text(value: unknown, field: string, required = false): string {
  if (typeof value !== 'string' || (required && (!value.trim() || value !== value.trim()))) invalid(field)
  return value
}

function id(value: unknown, field: string): string {
  const result = text(value, field, true)
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

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, true)
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

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(`${field}: duplicate`)
}

function descriptor(value: unknown): CharacterDescriptor {
  const input = record(value, 'character descriptor')
  const characterId = id(input.id, 'id')
  const file = text(input.file, 'file', true)
  if (file !== `${characterId}.json`) invalid('file')
  return {
    id: characterId, name: text(input.name, 'name', true),
    englishName: text(input.englishName, 'englishName', true), file,
  }
}

export function parseCharacterManifest(value: unknown): CharacterManifest {
  const input = record(value, 'manifest')
  const characters = array(input.characters, 'characters').map(descriptor)
  if (characters.length === 0) invalid('characters: empty')
  unique(characters.map((entry) => entry.id), 'characters.id')
  unique(characters.map((entry) => entry.file.toLowerCase()), 'characters.file')
  return { schemaVersion: schema(input.schemaVersion), generatedAt: timestamp(input.generatedAt, 'generatedAt'), characters }
}

const MOVE_TEXT_FIELDS = [
  'startup', 'active', 'recovery', 'onHit', 'onBlock', 'cancel', 'damage',
  'comboScaling', 'driveGaugeGain', 'driveGaugeLoss', 'punishCounterDriveLoss',
  'superGaugeGain', 'properties', 'notes',
] as const

function move(value: unknown): CharacterMove {
  const input = record(value, 'move')
  const inputs = record(input.inputs, 'move.inputs')
  if (input.controlType !== 'classic' && input.controlType !== 'modern') invalid('move.controlType')
  const result = {
    id: id(input.id, 'move.id'), controlType: input.controlType, category: text(input.category, 'move.category', true),
    name: text(input.name, 'move.name', true),
    inputs: { classic: text(inputs.classic, 'move.inputs.classic'), modern: text(inputs.modern, 'move.inputs.modern') },
  } as CharacterMove
  for (const key of MOVE_TEXT_FIELDS) result[key] = text(input[key], `move.${key}`)
  return result
}

function assertMatches(dataset: CharacterDataset, expected: CharacterDescriptor): void {
  for (const key of ['id', 'name', 'englishName'] as const) {
    if (dataset[key] !== expected[key]) {
      throw new Error(`選択したキャラクターとデータが一致しません（${key}）。ページを再読み込みしてください。`)
    }
  }
}

export function parseCharacterDataset(value: unknown, expected?: CharacterDescriptor): CharacterDataset {
  const input = record(value, 'dataset')
  const characterId = id(input.id, 'id')
  if (input.health !== null && (typeof input.health !== 'number' || !Number.isSafeInteger(input.health) || input.health <= 0)) invalid('health')
  if (input.gameVersion !== null) text(input.gameVersion, 'gameVersion', true)
  const source = record(input.source, 'source')
  const url = text(source.url, 'source.url', true)
  let parsed: URL
  try { parsed = new URL(url) } catch { return invalid('source.url') }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.streetfighter.com' || parsed.username || parsed.password || parsed.port
    || parsed.search || parsed.hash || parsed.pathname !== `/6/ja-jp/character/${characterId}/frame`) invalid('source.url')
  const moves = array(input.moves, 'moves').map(move)
  if (moves.length === 0) invalid('moves: empty')
  unique(moves.map((entry) => entry.id), 'moves.id')
  const dataset: CharacterDataset = {
    schemaVersion: schema(input.schemaVersion), id: characterId,
    name: text(input.name, 'name', true), englishName: text(input.englishName, 'englishName', true),
    health: input.health as number | null, capturedAt: timestamp(input.capturedAt, 'capturedAt'),
    gameVersion: input.gameVersion as string | null, source: { title: text(source.title, 'source.title', true), url }, moves,
  }
  if (expected) assertMatches(dataset, descriptor(expected))
  return dataset
}

const manifestRequests = new Map<string, Promise<CharacterManifest>>()
const datasetRequests = new Map<string, Promise<CharacterDataset>>()

function dataUrl(file: string): string {
  const base = import.meta.env?.BASE_URL ?? '/'
  return `${base.endsWith('/') ? base : `${base}/`}data/characters/${file}`
}

function loadJson<T>(url: string, parse: (value: unknown) => T, cache: Map<string, Promise<T>>): Promise<T> {
  const existing = cache.get(url)
  if (existing) return existing
  const request = Promise.resolve().then(() => fetch(url)).then(async (response) => {
    if (!response.ok) throw new Error('キャラクターデータを読み込めませんでした。もう一度お試しください。')
    return parse(await response.json())
  }).catch((cause) => {
    if (cache.get(url) === request) cache.delete(url)
    throw cause
  })
  cache.set(url, request)
  return request
}

export function loadCharacterManifest(): Promise<CharacterManifest> {
  return loadJson(dataUrl('index.json'), parseCharacterManifest, manifestRequests)
}

export function loadCharacterDataset(value: CharacterDescriptor, generatedAt?: string): Promise<CharacterDataset> {
  const expected = descriptor(value)
  const version = generatedAt === undefined ? '' : `?v=${encodeURIComponent(timestamp(generatedAt, 'generatedAt'))}`
  const url = `${dataUrl(expected.file)}${version}`
  const request = loadJson(url, parseCharacterDataset, datasetRequests)
  return request.then((dataset) => {
    assertMatches(dataset, expected)
    return dataset
  }).catch((cause) => {
    if (datasetRequests.get(url) === request) datasetRequests.delete(url)
    throw cause
  })
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ja')
}

export function filterCharacterMoves(moves: readonly CharacterMove[], filters: CharacterMoveFilters): CharacterMove[] {
  const query = normalizeSearch(filters.query)
  const commandQuery = query.replace(/\s+/g, '')
  return moves.filter((entry) => {
    if (filters.controlType && entry.controlType !== filters.controlType) return false
    if (filters.category && filters.category !== 'ALL' && entry.category !== filters.category) return false
    return !query
      || normalizeSearch(`${entry.name} ${entry.inputs.classic} ${entry.inputs.modern} ${entry.properties} ${entry.notes}`).includes(query)
      || [entry.inputs.classic, entry.inputs.modern].some((command) => normalizeSearch(command).replace(/\s+/g, '').includes(commandQuery))
  })
}

export function characterMoveCategories(moves: readonly CharacterMove[]): string[] {
  return [...new Set(moves.map((entry) => entry.category))]
}

/** Only an unqualified numeric value can participate in numeric sorting. */
export function characterNumericValue(value: string): number | null {
  const normalized = value.normalize('NFKC').trim()
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*F)?$/i.test(normalized)) return null
  const number = Number(normalized.replace(/\s*F$/i, ''))
  return Number.isFinite(number) ? number : null
}

export function sortCharacterMoves(moves: readonly CharacterMove[], sort: CharacterMoveSort | null): CharacterMove[] {
  if (sort === null) return [...moves]
  const direction = sort.direction === 'asc' ? 1 : -1
  return moves.map((entry, index) => ({ entry, index, value: characterNumericValue(entry[sort.key]) }))
    .sort((left, right) => {
      if (left.value === null) return right.value === null ? left.index - right.index : 1
      if (right.value === null) return -1
      return (left.value - right.value) * direction || left.index - right.index
    })
    .map(({ entry }) => entry)
}
