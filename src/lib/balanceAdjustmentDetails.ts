import { loadBalanceAdjustmentCatalog } from './balanceAdjustments.ts'
import type { BalanceAdjustment, BalanceAdjustmentCatalog, BalanceAdjustmentSource } from '../types/balanceAdjustments.ts'
import type {
  BalanceAdjustmentChange, BalanceAdjustmentCharacterDetails, BalanceAdjustmentDetailsCatalog,
  BalanceAdjustmentPatchDetails,
} from '../types/balanceAdjustmentDetails.ts'
import type { CharacterManifest } from '../types/characters.ts'

type UnknownRecord = Record<string, unknown>

function invalid(field: string): never {
  throw new Error(`バランス調整詳細の形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as UnknownRecord
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value !== value.trim()) invalid(field)
  return value
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) invalid(field)
  return result
}

function date(value: unknown, field: string): string {
  const result = text(value, field)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result)
  if (!match) invalid(field)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
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

function source(value: unknown, field: string, pathname?: string): BalanceAdjustmentSource {
  const input = record(value, field)
  const url = text(input.url, `${field}.url`)
  let parsed: URL
  try { parsed = new URL(url) } catch { return invalid(`${field}.url`) }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.streetfighter.com'
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || (pathname ? parsed.pathname !== pathname
      : !/^\/6\/buckler\/ja-jp\/battle_change\/\d{6}(?:\d{2})?\/?$/.test(parsed.pathname))) invalid(`${field}.url`)
  return { url, title: text(input.title, `${field}.title`) }
}

function changes(value: unknown, field: string): BalanceAdjustmentChange[] {
  if (!Array.isArray(value)) invalid(field)
  const result = value.map((entry, index) => {
    const child = `${field}[${index}]`
    const input = record(entry, child)
    return {
      id: identifier(input.id, `${child}.id`), target: text(input.target, `${child}.target`, true),
      categoryLabel: text(input.categoryLabel, `${child}.categoryLabel`, true), description: text(input.description, `${child}.description`),
    }
  })
  if (new Set(result.map(({ id }) => id)).size !== result.length) invalid(`${field}.id の重複`)
  return result
}

function patch(value: unknown, index: number): BalanceAdjustmentPatchDetails {
  const field = `patches[${index}]`
  const input = record(value, field)
  const patchSource = source(input.source, `${field}.source`)
  const path = new URL(patchSource.url).pathname.replace(/\/$/, '')
  const common = record(input.common, `${field}.common`)
  if (!Array.isArray(input.characters)) invalid(`${field}.characters`)
  const characters = input.characters.map((entry, childIndex): BalanceAdjustmentCharacterDetails => {
    const child = `${field}.characters[${childIndex}]`
    const character = record(entry, child)
    const characterId = identifier(character.characterId, `${child}.characterId`)
    if (character.status !== 'ready' && character.status !== 'unlisted') invalid(`${child}.status`)
    const characterPolicy = text(character.policy, `${child}.policy`, true)
    const characterChanges = changes(character.changes, `${child}.changes`)
    if (character.status === 'unlisted' && (character.source !== null || characterPolicy !== '' || characterChanges.length !== 0)) {
      invalid(`${child}.unlisted`)
    }
    const slug = characterId === 'ehonda' ? 'honda' : characterId
    return {
      characterId, name: text(character.name, `${child}.name`),
      status: character.status,
      source: character.status === 'ready' ? source(character.source, `${child}.source`, `${path}/${slug}`) : null,
      policy: characterPolicy, changes: characterChanges,
    }
  })
  if (characters.length === 0) invalid(`${field}.characters: empty`)
  if (new Set(characters.map(({ characterId }) => characterId)).size !== characters.length) invalid(`${field}.characters.characterId の重複`)
  return {
    adjustmentId: identifier(input.adjustmentId, `${field}.adjustmentId`), date: date(input.date, `${field}.date`),
    capturedAt: timestamp(input.capturedAt, `${field}.capturedAt`), source: patchSource,
    common: { policy: text(common.policy, `${field}.common.policy`, true), changes: changes(common.changes, `${field}.common.changes`) },
    characters,
  }
}

/** Optional reference catalogs verify identity without inventing historical character coverage. */
export function parseBalanceAdjustmentDetails(
  value: unknown, history?: BalanceAdjustmentCatalog, manifest?: CharacterManifest,
): BalanceAdjustmentDetailsCatalog {
  const input = record(value, 'catalog')
  if (input.schemaVersion !== 1) invalid('schemaVersion')
  if (!Array.isArray(input.patches)) invalid('patches')
  const generatedAt = timestamp(input.generatedAt, 'generatedAt')
  const patches = input.patches.map(patch)
  if (new Set(patches.map(({ adjustmentId }) => adjustmentId)).size !== patches.length) invalid('patches.adjustmentId の重複')
  const events = history && new Map(history.events.map((entry) => [entry.id, entry]))
  const characters = manifest && new Map(manifest.characters.map((entry) => [entry.id, entry]))
  for (const item of patches) {
    if (Date.parse(item.capturedAt) > Date.parse(generatedAt)) invalid(`${item.adjustmentId}.capturedAt と generatedAt`)
    if (events) {
      const event = events.get(item.adjustmentId)
      if (!event || event.date !== item.date || event.source.url !== item.source.url) invalid(`${item.adjustmentId} と履歴`)
    }
    if (characters) {
      for (const character of item.characters) {
        const expected = characters.get(character.characterId)
        if (!expected || expected.name !== character.name) invalid(`${item.adjustmentId}.${character.characterId} とキャラ一覧`)
      }
    }
  }
  return { schemaVersion: 1, generatedAt, patches }
}

let detailsRequest: Promise<BalanceAdjustmentDetailsCatalog> | null = null

export function loadBalanceAdjustmentDetails(
  history?: BalanceAdjustmentCatalog, manifest?: CharacterManifest,
): Promise<BalanceAdjustmentDetailsCatalog> {
  if (detailsRequest) {
    const existing = detailsRequest
    if (!history && !manifest) return existing
    return existing.then((catalog) => parseBalanceAdjustmentDetails(catalog, history, manifest)).catch((cause) => {
      if (detailsRequest === existing) detailsRequest = null
      throw cause
    })
  }
  const base = import.meta.env?.BASE_URL ?? '/'
  const url = `${base.endsWith('/') ? base : `${base}/`}data/balance-adjustment-details.json`
  const request = Promise.all([
    Promise.resolve().then(() => fetch(url)).then(async (response) => {
      if (!response.ok) throw new Error('バランス調整詳細を読み込めませんでした。もう一度お試しください。')
      return response.json() as Promise<unknown>
    }),
    history ? Promise.resolve(history) : loadBalanceAdjustmentCatalog(),
  ]).then(([value, expectedHistory]) => parseBalanceAdjustmentDetails(value, expectedHistory, manifest)).catch((cause) => {
    if (detailsRequest === request) detailsRequest = null
    throw cause
  })
  detailsRequest = request
  return request
}

export function balanceAdjustmentPatchDetails(
  catalog: BalanceAdjustmentDetailsCatalog, event: BalanceAdjustment,
): BalanceAdjustmentPatchDetails | null {
  return catalog.patches.find((item) => item.adjustmentId === event.id && item.date === event.date && item.source.url === event.source.url) ?? null
}

export function balanceAdjustmentCharacterStatus(
  patch: BalanceAdjustmentPatchDetails | null, characterId: string,
): 'ready' | 'unchanged' | 'unlisted' | 'unimported' {
  const character = patch?.characters.find((item) => item.characterId === characterId)
  if (!character) return 'unimported'
  if (character.status === 'unlisted') return 'unlisted'
  return character.changes.length > 0 ? 'ready' : 'unchanged'
}
