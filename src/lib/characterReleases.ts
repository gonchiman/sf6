import type { CharacterManifest, CharacterSource } from '../types/characters.ts'
import type {
  CharacterRelease, CharacterReleaseCatalog, CharacterReleaseFilters,
  CharacterReleaseOrder, CharacterReleaseRow,
} from '../types/characterReleases.ts'

type UnknownRecord = Record<string, unknown>

function invalid(field: string): never {
  throw new Error(`キャラクター実装日の形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as UnknownRecord
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) invalid(field)
  return value
}

function date(value: unknown, field: string): string {
  const result = text(value, field)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result)
  if (!match) invalid(field)
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid(field)
  return result
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field)
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result)
  if (!match || !Number.isFinite(Date.parse(result))) invalid(field)
  date(match[1], field)
  return result
}

function source(value: unknown, field: string): CharacterSource {
  const input = record(value, field)
  const url = text(input.url, `${field}.url`)
  let parsed: URL
  try { parsed = new URL(url) } catch { return invalid(`${field}.url`) }
  const official = parsed.hostname === 'prtimes.jp'
    ? /^\/main\/html\/rd\/p\/\d{9}\.000013450\.html$/.test(parsed.pathname)
    : (parsed.hostname === 'www.streetfighter.com' && parsed.pathname.startsWith('/6/'))
      || (parsed.hostname === 'www.capcom.co.jp' && parsed.pathname.startsWith('/ir/news/'))
      || (parsed.hostname === 'www.capcom-games.com' && parsed.pathname.startsWith('/ja-jp/'))
      || parsed.hostname === 'news.capcomusa.com'
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !official) {
    invalid(`${field}.url`)
  }
  return { title: text(input.title, `${field}.title`), url }
}

/** Require one explicit record per manifest character, including dates that remain unverified. */
export function parseCharacterReleaseCatalog(value: unknown, manifest: CharacterManifest): CharacterReleaseCatalog {
  const input = record(value, 'catalog')
  if (input.schemaVersion !== 1) invalid('schemaVersion')
  if (input.timezone !== 'Asia/Tokyo') invalid('timezone')
  const generatedAt = timestamp(input.generatedAt, 'generatedAt')
  const checkedAt = timestamp(input.checkedAt, 'checkedAt')
  if (Date.parse(checkedAt) > Date.parse(generatedAt)) invalid('checkedAt と generatedAt')
  if (!Array.isArray(input.characters)) invalid('characters')
  const known = new Set(manifest.characters.map((character) => character.id))
  const seen = new Set<string>()
  const checkedDate = new Date(Date.parse(checkedAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const characters = input.characters.map((value, index): CharacterRelease => {
    const field = `characters[${index}]`
    const item = record(value, field)
    const characterId = text(item.characterId, `${field}.characterId`)
    if (!known.has(characterId) || seen.has(characterId)) invalid(`${field}.characterId（未知または重複）`)
    seen.add(characterId)
    if (item.kind !== 'initial' && item.kind !== 'additional') invalid(`${field}.kind`)
    if (item.status !== 'released' && item.status !== 'scheduled' && item.status !== 'unverified') invalid(`${field}.status`)
    if (item.status === 'unverified') {
      if (item.releaseDate !== null || item.source !== null) invalid(`${field}.unverified`)
      return { characterId, kind: item.kind, status: item.status, releaseDate: null, source: null }
    }
    const releaseDate = date(item.releaseDate, `${field}.releaseDate`)
    if (item.status === 'released' && releaseDate > checkedDate) invalid(`${field}.released と checkedAt`)
    return { characterId, kind: item.kind, status: item.status, releaseDate, source: source(item.source, `${field}.source`) }
  })
  if (seen.size !== known.size) invalid('characters（キャラ一覧の不足）')
  return { schemaVersion: 1, generatedAt, checkedAt, timezone: 'Asia/Tokyo', characters }
}

let catalogRequest: Promise<CharacterReleaseCatalog> | null = null

export function loadCharacterReleaseCatalog(manifest: CharacterManifest): Promise<CharacterReleaseCatalog> {
  if (catalogRequest) {
    const existing = catalogRequest
    return existing.then((catalog) => parseCharacterReleaseCatalog(catalog, manifest)).catch((cause) => {
      if (catalogRequest === existing) catalogRequest = null
      throw cause
    })
  }
  const base = import.meta.env?.BASE_URL ?? '/'
  const url = `${base.endsWith('/') ? base : `${base}/`}data/character-releases.json`
  const request = Promise.resolve().then(() => fetch(url)).then(async (response) => {
    if (!response.ok) throw new Error('キャラクター実装日を読み込めませんでした。もう一度お試しください。')
    return parseCharacterReleaseCatalog(await response.json(), manifest)
  }).catch((cause) => {
    if (catalogRequest === request) catalogRequest = null
    throw cause
  })
  catalogRequest = request
  return request
}

/** Unknown dates stay last and same-day characters retain manifest order in either direction. */
export function filterCharacterReleases(
  catalog: CharacterReleaseCatalog, manifest: CharacterManifest,
  filters: CharacterReleaseFilters = { characterId: 'all', kind: 'all' }, order: CharacterReleaseOrder = 'desc',
): CharacterReleaseRow[] {
  const releases = new Map(catalog.characters.map((release) => [release.characterId, release]))
  return manifest.characters.flatMap((character, index) => {
    const release = releases.get(character.id)
    return release && (filters.characterId === 'all' || filters.characterId === character.id)
      && (filters.kind === 'all' || filters.kind === release.kind) ? [{ row: { ...release, character }, index }] : []
  }).sort((left, right) => {
    const first = left.row.releaseDate, second = right.row.releaseDate
    if (first === null) return second === null ? left.index - right.index : 1
    if (second === null) return -1
    return first.localeCompare(second) * (order === 'asc' ? 1 : -1) || left.index - right.index
  }).map(({ row }) => row)
}
