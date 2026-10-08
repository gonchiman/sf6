import { createHash } from 'node:crypto'
import { parseCharacterDataset } from '../../src/lib/characters.ts'
import type { CharacterControlType, CharacterDataset, CharacterMove } from '../../src/types/characters.ts'

export interface CharacterSnapshotRow {
  cells: string[]
  name: string | null
  classicInputTokens: string[]
  modernInputTokens: string[]
}

export interface CharacterSnapshot {
  id: string
  controlType?: CharacterControlType
  url: string
  title: string
  healthText: string
  englishName: string
  capturedAt: string
  rows: CharacterSnapshotRow[]
}

const ICON_TEXT: Record<string, string> = {
  'icon_punch.png': 'P', 'icon_kick.png': 'K',
  'icon_punch_l.png': '弱P', 'icon_punch_m.png': '中P', 'icon_punch_h.png': '強P',
  'icon_kick_l.png': '弱K', 'icon_kick_m.png': '中K', 'icon_kick_h.png': '強K',
  'key-d.png': '↓', 'key-dl.png': '↙', 'key-dr.png': '↘',
  'key-l.png': '←', 'key-r.png': '→', 'key-u.png': '↑',
  'key-ul.png': '↖', 'key-ur.png': '↗', 'key-nutral.png': 'N',
  'key-plus.png': '+', 'key-or.png': 'or',
  'key-lc.png': '←溜め', 'key-dc.png': '↓溜め', 'key-rc.png': '→溜め',
  'key-circle.png': '一回転', 'key-barrage.png': '連打', 'icon_throw.png': '投げ',
  'arrow_3.png': '▶', 'key-all.png': '攻撃',
  'modern_l.png': '弱', 'modern_m.png': '中', 'modern_h.png': '強',
  'modern_auto.png': 'AUTO', 'modern_sp.png': 'SP', 'modern_dl.png': 'DI', 'modern_dp.png': 'DP',
}

/** Icon tokens are captured from visible command elements, never executable HTML. */
export function decodeCharacterInput(tokens: readonly string[]): string {
  const decoded: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('@')) {
      decoded.push(token)
      continue
    }
    const filename = token.slice(1)
    const value = ICON_TEXT[filename] ?? `［${filename}］`
    decoded.push(value)
    // The official element prints strength next to an icon that already conveys it.
    const following = tokens[index + 1]
    if (/^(?:icon_(?:punch|kick)_[lmh]|modern_[lmh])\.png$/.test(filename)
      && following?.startsWith(value.slice(0, 1))
      && /^[弱中強](?=$|[\s)）\]］}｝】」』,，、;；/／|｜])/.test(following)) {
      // The strength text may share its token with a closing parenthesis or separator.
      const remaining = following.slice(1)
      if (remaining) decoded.push(remaining)
      index += 1
    }
  }
  return decoded.join(' ').replace(/\s*\+\s*/g, ' + ').replace(/\s+([)）\]］}｝】」』])/g, '$1').trim()
}

const CELL_FIELDS = [
  'startup', 'active', 'recovery', 'onHit', 'onBlock', 'cancel', 'damage',
  'comboScaling', 'driveGaugeGain', 'driveGaugeLoss', 'punishCounterDriveLoss',
  'superGaugeGain', 'properties', 'notes',
] as const

function rawRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`取得記録の形式が不正です: ${field}`)
  return value as Record<string, unknown>
}

function rawString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`取得記録の文字列が不正です: ${field}`)
  return value
}

function rawStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`取得記録の配列が不正です: ${field}`)
  return value.map((entry) => rawString(entry, field))
}

export function parseCharacterSnapshot(value: unknown): CharacterSnapshot {
  const input = rawRecord(value, 'snapshot')
  if (!Array.isArray(input.rows)) throw new Error('取得記録の行がありません。')
  if (input.controlType !== undefined && input.controlType !== 'classic' && input.controlType !== 'modern') throw new Error('取得記録の操作タイプが不正です。')
  return {
    id: rawString(input.id, 'id'), controlType: input.controlType as CharacterControlType | undefined,
    url: rawString(input.url, 'url'), title: rawString(input.title, 'title'),
    healthText: rawString(input.healthText, 'healthText'), englishName: rawString(input.englishName, 'englishName'),
    capturedAt: rawString(input.capturedAt, 'capturedAt'),
    rows: input.rows.map((value, index) => {
      const row = rawRecord(value, `rows[${index}]`)
      return {
        cells: rawStrings(row.cells, `rows[${index}].cells`),
        name: row.name === null ? null : rawString(row.name, `rows[${index}].name`),
        classicInputTokens: rawStrings(row.classicInputTokens, `rows[${index}].classicInputTokens`),
        modernInputTokens: rawStrings(row.modernInputTokens, `rows[${index}].modernInputTokens`),
      }
    }),
  }
}

function healthFromText(text: string): number | null {
  const match = /^(?:体力\s*)?((?:\d{1,3}(?:,\d{3})+|\d+))$/.exec(text.trim())
  if (!match) return null
  const value = Number(match[1].replaceAll(',', ''))
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function characterDatasetFromSnapshot(value: unknown): CharacterDataset {
  const snapshot = parseCharacterSnapshot(value)
  const controlType = snapshot.controlType ?? 'classic'
  const name = /^(.+?)\s+フレームデータ(?:[｜|]|$)/.exec(snapshot.title)?.[1]
  if (!name) throw new Error(`公式ページのキャラクター名を確認できません: ${snapshot.id}`)
  let category = ''
  const moves: CharacterMove[] = []
  const occurrences = new Map<string, number>()
  for (const row of snapshot.rows) {
    if (row.cells.length === 1) {
      category = row.cells[0].trim()
      if (!category) throw new Error(`空の技カテゴリがあります: ${snapshot.id}`)
      continue
    }
    // The table's grouped header has fewer cells than its fifteen data columns.
    if (row.name === null && row.cells[0] === '技名') continue
    if (row.cells.length !== 15 || !row.name?.trim() || !category) {
      throw new Error(`技の列数・名称・カテゴリが不正です: ${snapshot.id} / ${row.name ?? '名称なし'}`)
    }
    const inputs = { classic: decodeCharacterInput(row.classicInputTokens), modern: decodeCharacterInput(row.modernInputTokens) }
    const identity = JSON.stringify([controlType, category, row.name, inputs.classic, inputs.modern])
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 20)
    const occurrence = (occurrences.get(hash) ?? 0) + 1
    occurrences.set(hash, occurrence)
    const move = {
      id: `${snapshot.id}-${hash}${occurrence === 1 ? '' : `-${occurrence}`}`,
      controlType, category, name: row.name, inputs,
    } as CharacterMove
    CELL_FIELDS.forEach((field, index) => { move[field] = row.cells[index + 1] })
    moves.push(move)
  }
  return parseCharacterDataset({
    schemaVersion: 1, id: snapshot.id, name, englishName: snapshot.englishName,
    health: healthFromText(snapshot.healthText), capturedAt: snapshot.capturedAt, gameVersion: null,
    source: { title: snapshot.title, url: snapshot.url }, moves,
  })
}
