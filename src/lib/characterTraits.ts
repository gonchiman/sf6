import type { CharacterControlType, CharacterDataset, CharacterDescriptor, CharacterMove } from '../types/characters.ts'
import type {
  CharacterTraitEvidence, CharacterTraitId, CharacterTraitResult, CharacterTraitStatus,
  CharacterTraitsCharacter, CharacterTraitsDataset,
} from '../types/characterTraits.ts'
import { parseCharacterDataset, parseCharacterManifest } from './characters.ts'

export const CHARACTER_TRAIT_RULES_VERSION = 1 as const

export const CHARACTER_TRAITS: ReadonlyArray<{ id: CharacterTraitId; label: string; description: string }> = [
  { id: 'full', label: '1F完全無敵', description: '必殺技の備考に、技の1F目から完全無敵になる範囲が明記されている。通常版・OD版の両方を対象にする。' },
  { id: 'air', label: '通常版の1F対空無敵', description: '強化状態・派生を含む非ODの必殺技に、1F目から空中判定の打撃・空弾属性への無敵が明記されている。完全無敵の記載は含めない。' },
  { id: 'projectile', label: '弾属性', description: '必殺技の公式属性に「弾」または「空弾」が記載されている。備考の飛び道具相殺・無敵の記載とは区別する。' },
  { id: 'armor', label: 'アーマー判定', description: '必殺技の備考に、自分のアーマー判定が明記されている。部位限定・条件付きも含み、相手のアーマーへのヒットやアーマーブレイクは含めない。' },
  { id: 'projectileInv', label: '飛び道具無敵', description: '必殺技の備考に、自分が飛び道具に対して無敵になる範囲が明記されている。部位限定・条件付きも含み、完全無敵や空弾属性だけの無敵からは推定しない。' },
  { id: 'clash', label: '飛び道具相殺', description: '必殺技の備考に、自分の飛び道具相殺判定・能力が明記されている。弾属性からは推定しない。' },
]

const CONTROL_TYPES: readonly CharacterControlType[] = ['classic', 'modern']
const FIELD_BY_TRAIT: Record<CharacterTraitId, 'notes' | 'properties'> = {
  full: 'notes', air: 'notes', projectile: 'properties', armor: 'notes', projectileInv: 'notes', clash: 'notes',
}

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/[~〜−‐‑‒–—]/g, '-').trim()
}

function variant(move: CharacterMove): 'normal' | 'od' {
  return /OD/.test(move.name.normalize('NFKC')) ? 'od' : 'normal'
}

function evidence(move: CharacterMove, field: 'notes' | 'properties', excerpt: string): CharacterTraitEvidence {
  return { moveId: move.id, moveName: move.name, variant: variant(move), field, text: move[field], excerpt }
}

/** Only a statement about this move is accepted, rather than a reference to an opponent. */
function excludedStatement(line: string): boolean {
  return /(?:相手|敵)の.*(?:無敵|アーマー|相殺)|無敵の技に当たらない|無敵(?:を|は|状態を)?無視|無敵(?:ではない|ではなく|にならない|を持たない|なし|無し)|(?:相殺判定|アーマー判定)(?:あり)?(?:ではない|ではなく|なし|無し|がない|はない)|相殺(?:できない|しない|不可)|無敵(?:を|は)?(?:失う|解除)/.test(line)
}

interface FrameStatement { starts: number[]; statement: string }

function frameStatement(line: string, optionalF = false): FrameStatement | null {
  const frame = optionalF ? String.raw`\d+\s*(?:-\s*(?:\d+|持続終了))?\s*F?` : String.raw`\d+\s*(?:-\s*\d+)?\s*F`
  const match = new RegExp(`^(${frame}(?:\\s*[,、]\\s*${frame})*)\\s*(.+)$`, 'i').exec(line)
  if (!match) return null
  const starts: number[] = []
  for (const range of match[1].split(/[,、]/)) {
    const values = /^(\d+)\s*(?:-\s*(\d+|持続終了))?\s*F?$/i.exec(range.trim())
    if (!values) return null
    const start = Number(values[1])
    const end = values[2] === '持続終了' ? start : Number(values[2] ?? values[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null
    starts.push(start)
  }
  return { starts, statement: match[2].trim() }
}

function statementStarts(statement: string, expression: string): boolean {
  return new RegExp(`^(?:${expression})(?=$|[\\s(、,])`).test(statement)
}

interface MoveClassification { status: CharacterTraitStatus; excerpt: string | null }

function classifyNotes(move: CharacterMove, trait: Exclude<CharacterTraitId, 'projectile'>): MoveClassification {
  if (trait === 'air' && variant(move) === 'od') return { status: 'not-found', excerpt: null }
  let unresolved: string | null = null
  for (const rawLine of move.notes.split(/\r?\n/)) {
    const line = normalized(rawLine).replace(/^※\s*/, '')
    if (!line || excludedStatement(line)) continue
    // These describe the opponent's armor, not armor attached to this move.
    if (trait === 'armor' && /アーマー(?:ブレイク|ヒット)/.test(line) && !/アーマー判定/.test(line)) continue
    const relevant = trait === 'full' ? /完全無敵/.test(line)
      : trait === 'air' ? /空中判定の打撃|空弾属性.*無敵/.test(line)
      : trait === 'armor' ? /アーマー判定/.test(line)
      : trait === 'projectileInv' ? /飛び道具.*無敵|無敵.*飛び道具/.test(line)
      : /(?:飛び道具|弾).*相殺|相殺.*(?:飛び道具|弾)/.test(line)
    if (!relevant) continue
    const framed = frameStatement(line, trait === 'armor')
    if (trait === 'full' && framed && statementStarts(framed.statement, '完全無敵')) {
      if (framed.starts.includes(1)) return { status: 'confirmed', excerpt: rawLine }
      continue
    }
    if (trait === 'air' && framed && statementStarts(framed.statement, '(?:(?:上|下)半身のみ)?空中判定の打撃[・/、]空弾属性に対して無敵')) {
      if (!framed.starts.includes(1)) continue
      if (statementStarts(framed.statement, '空中判定の打撃[・/、]空弾属性に対して無敵')) return { status: 'confirmed', excerpt: rawLine }
      // A body-limited interval starting on 1F does not establish the unqualified trait.
    }
    if (trait === 'armor') {
      if (framed && statementStarts(framed.statement, '(?:上半身|下半身|全身)?アーマー判定')) return { status: 'confirmed', excerpt: rawLine }
      if (statementStarts(line, '(?:上半身|下半身|全身)?アーマー判定(?:あり|がある|を持つ)')) return { status: 'confirmed', excerpt: rawLine }
    }
    if (trait === 'projectileInv') {
      // The change of side is a condition within the same move, retained verbatim in evidence.
      const conditional = frameStatement(line.replace(/^裏回り時\s*/, ''))
      if (conditional && statementStarts(conditional.statement, '(?:(?:上|下)半(?:身|分)(?:のみ)?|全身)?(?:打撃[・/、])?飛び道具(?:[・/、]打撃)?(?:に対して)?無敵')) return { status: 'confirmed', excerpt: rawLine }
    }
    if (trait === 'clash') {
      const statement = framed?.statement ?? line
      if (statementStarts(statement, '(?:飛び道具|弾)(?:相殺判定あり|を相殺(?:する|できる|可能))')) return { status: 'confirmed', excerpt: rawLine }
    }
    unresolved ??= rawLine
  }
  return { status: unresolved !== null ? 'unknown' : 'not-found', excerpt: unresolved }
}

function classifyMove(move: CharacterMove, trait: CharacterTraitId): MoveClassification {
  if (trait !== 'projectile') return classifyNotes(move, trait)
  const properties = normalized(move.properties)
  if (/(?:^|[・/、,\s])(?:弾|空弾)(?=$|[・/、,\s])/.test(properties)) return { status: 'confirmed', excerpt: move.properties }
  // Blank cells and the known guard/throw symbols contain no projectile symbol.
  return /^[上中下投※・/、,\s]*$/.test(properties)
    ? { status: 'not-found', excerpt: null } : { status: 'unknown', excerpt: move.properties }
}

export function buildCharacterTraits(value: CharacterDataset, descriptor?: CharacterDescriptor): CharacterTraitsCharacter {
  const dataset = parseCharacterDataset(value, descriptor)
  const identity = descriptor ?? { id: dataset.id, name: dataset.name, englishName: dataset.englishName, file: `${dataset.id}.json` }
  const traits = {} as CharacterTraitsCharacter['traits']
  for (const controlType of CONTROL_TYPES) {
    const moves = dataset.moves.filter((move) => move.controlType === controlType && move.category === '必殺技')
    const results = {} as Record<CharacterTraitId, CharacterTraitResult>
    for (const { id: trait } of CHARACTER_TRAITS) {
      const confirmed: CharacterTraitEvidence[] = []
      const unresolved: CharacterTraitEvidence[] = []
      for (const move of moves) {
        const result = classifyMove(move, trait)
        if (result.status === 'confirmed') confirmed.push(evidence(move, FIELD_BY_TRAIT[trait], result.excerpt!))
        if (result.status === 'unknown') unresolved.push(evidence(move, FIELD_BY_TRAIT[trait], result.excerpt!))
      }
      const status: CharacterTraitStatus = confirmed.length ? 'confirmed' : !moves.length || unresolved.length ? 'unknown' : 'not-found'
      results[trait] = {
        status, evidence: confirmed, unresolved,
        reason: status !== 'unknown' ? null : !moves.length
          ? '対象操作タイプの必殺技データがありません。'
          : '関連する記載をこの判定ルールで解釈できません。原文の確認が必要です。',
      }
    }
    traits[controlType] = results
  }
  return { ...identity, capturedAt: dataset.capturedAt, gameVersion: dataset.gameVersion, source: dataset.source, traits }
}

type UnknownRecord = Record<string, unknown>

function invalid(field: string): never {
  throw new Error(`キャラクター分類データの形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as UnknownRecord
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(field)
  return value
}

function parseEvidence(value: unknown, field: string, trait: CharacterTraitId): CharacterTraitEvidence[] {
  if (!Array.isArray(value)) invalid(field)
  const result = value.map((entry) => {
    const input = record(entry, field)
    const moveId = text(input.moveId, `${field}.moveId`)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(moveId)) invalid(`${field}.moveId`)
    if (input.variant !== 'normal' && input.variant !== 'od') invalid(`${field}.variant`)
    if (trait === 'air' && input.variant !== 'normal') invalid(`${field}.variant`)
    if (input.field !== FIELD_BY_TRAIT[trait]) invalid(`${field}.field`)
    const original = text(input.text, `${field}.text`)
    const excerpt = text(input.excerpt, `${field}.excerpt`)
    if (!original.includes(excerpt)) invalid(`${field}.excerpt`)
    return {
      moveId, moveName: text(input.moveName, `${field}.moveName`), variant: input.variant,
      field: input.field, text: original, excerpt,
    } as CharacterTraitEvidence
  })
  if (new Set(result.map((entry) => entry.moveId)).size !== result.length) invalid(`${field}: duplicate`)
  return result
}

function parseResult(value: unknown, field: string, trait: CharacterTraitId): CharacterTraitResult {
  const input = record(value, field)
  if (input.status !== 'confirmed' && input.status !== 'not-found' && input.status !== 'unknown') invalid(`${field}.status`)
  const evidence = parseEvidence(input.evidence, `${field}.evidence`, trait)
  const unresolved = parseEvidence(input.unresolved, `${field}.unresolved`, trait)
  if (evidence.some((entry) => unresolved.some((other) => other.moveId === entry.moveId))) invalid(`${field}: conflicting evidence`)
  if (input.status === 'confirmed' && !evidence.length) invalid(`${field}: missing evidence`)
  if (input.status !== 'confirmed' && evidence.length) invalid(`${field}: unexpected evidence`)
  if (input.status === 'not-found' && unresolved.length) invalid(`${field}: unresolved evidence`)
  if (input.status === 'unknown') text(input.reason, `${field}.reason`)
  else if (input.reason !== null) invalid(`${field}.reason`)
  return { status: input.status, evidence, unresolved, reason: input.reason as string | null }
}

export function parseCharacterTraitsDataset(value: unknown): CharacterTraitsDataset {
  const input = record(value, 'dataset')
  if (input.schemaVersion !== 1) invalid('schemaVersion')
  if (input.rulesVersion !== CHARACTER_TRAIT_RULES_VERSION) invalid('rulesVersion')
  if (!Array.isArray(input.characters)) invalid('characters')
  // Reuse the existing manifest checks for identifiers, safe file paths, uniqueness and calendar dates.
  const manifest = parseCharacterManifest({ schemaVersion: 1, generatedAt: input.sourceManifestGeneratedAt, characters: input.characters })
  const generatedAt = parseCharacterManifest({ ...manifest, generatedAt: input.generatedAt }).generatedAt
  const characters = input.characters.map((value, index) => {
    const character = record(value, `characters[${index}]`)
    const identity = manifest.characters[index]
    const capturedAt = parseCharacterManifest({ schemaVersion: 1, generatedAt: character.capturedAt, characters: [identity] }).generatedAt
    if (character.gameVersion !== null) text(character.gameVersion, 'gameVersion')
    const source = record(character.source, 'source')
    const url = text(source.url, 'source.url')
    let parsed: URL
    try { parsed = new URL(url) } catch { return invalid('source.url') }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.streetfighter.com' || parsed.username || parsed.password || parsed.port
      || parsed.search || parsed.hash || parsed.pathname !== `/6/ja-jp/character/${identity.id}/frame`) invalid('source.url')
    const rawTraits = record(character.traits, 'traits')
    const traits = {} as CharacterTraitsCharacter['traits']
    for (const controlType of CONTROL_TYPES) {
      const rawResults = record(rawTraits[controlType], `traits.${controlType}`)
      const results = {} as Record<CharacterTraitId, CharacterTraitResult>
      for (const { id } of CHARACTER_TRAITS) results[id] = parseResult(rawResults[id], `traits.${controlType}.${id}`, id)
      traits[controlType] = results
    }
    return {
      ...identity, capturedAt, gameVersion: character.gameVersion as string | null,
      source: { title: text(source.title, 'source.title'), url }, traits,
    }
  })
  return { schemaVersion: 1, rulesVersion: CHARACTER_TRAIT_RULES_VERSION, generatedAt, sourceManifestGeneratedAt: manifest.generatedAt, characters }
}

const requests = new Map<string, Promise<CharacterTraitsDataset>>()

export function loadCharacterTraitsDataset(): Promise<CharacterTraitsDataset> {
  const base = import.meta.env?.BASE_URL ?? '/'
  const url = `${base.endsWith('/') ? base : `${base}/`}data/character-traits.json`
  const existing = requests.get(url)
  if (existing) return existing
  const request = Promise.resolve().then(() => fetch(url)).then(async (response) => {
    if (!response.ok) throw new Error('キャラクター分類データを読み込めませんでした。もう一度お試しください。')
    return parseCharacterTraitsDataset(await response.json())
  }).catch((cause) => {
    if (requests.get(url) === request) requests.delete(url)
    throw cause
  })
  requests.set(url, request)
  return request
}
