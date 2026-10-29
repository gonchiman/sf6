import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS,
  parseLegendAnalysisDescriptor, parseLegendAnalysisManifest } from './legendAnalysis.ts'
import type { LegendPlayerRow, LegendPlayerSortDirection, LegendPlayerSortKey,
  LegendPlayersDataset, LegendPlayersDescriptor, LegendPlayersManifest } from '../types/legendPlayers.ts'

function invalid(field: string): never { throw new Error(`レジェンドのプレイヤー一覧の形式が正しくありません（${field}）。`) }
function record(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) invalid(`${field}: unknown field or invalid object`)
  return value as Record<string, unknown>
}
function text(value: unknown, field: string, maxLength = 2000): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength
    || /[\p{Cc}]/u.test(value)) invalid(field)
  return value
}
function texts(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) invalid(field)
  return value.map(item => text(item, field))
}
function integer(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(field)
  return value
}

export function parseLegendPlayersDescriptor(value: unknown): LegendPlayersDescriptor {
  const descriptor = parseLegendAnalysisDescriptor(value)
  const expectedId = `legend-${descriptor.captureStartedAt.replace(/[:.]/g, '-')}`
  if (descriptor.id !== expectedId || descriptor.path !== `${expectedId}.json`) invalid('descriptor.id/path')
  return descriptor
}

export function parseLegendPlayersManifest(value: unknown): LegendPlayersManifest {
  const manifest = parseLegendAnalysisManifest(value)
  return { ...manifest, datasets: manifest.datasets.map(parseLegendPlayersDescriptor) }
}

function descriptorFor(value: LegendPlayersDataset): LegendPlayersDescriptor {
  return { id: value.id, path: `${value.id}.json`, actId: value.act.id, definitionVersion: value.definitionVersion,
    membershipRule: value.membershipRule, conditions: value.conditions, captureStartedAt: value.captureStartedAt,
    captureEndedAt: value.captureEndedAt, totalCount: value.totalCount }
}

export function parseLegendPlayersDataset(value: unknown, expected?: LegendPlayersDescriptor): LegendPlayersDataset {
  const input = record(value, 'dataset', ['schemaVersion', 'id', 'captureStartedAt', 'captureEndedAt', 'generatedAt',
    'source', 'act', 'definitionVersion', 'membershipRule', 'conditions', 'totalCount', 'validation', 'players'])
  if (input.schemaVersion !== 1) invalid('schemaVersion')
  const source = record(input.source, 'source', ['url', 'title', 'population', 'metric', 'unit', 'notes'])
  if (source.unit !== 'account-character') invalid('source.unit')
  const act = record(input.act, 'act', ['id', 'label'])
  const descriptor = parseLegendPlayersDescriptor({ id: input.id, path: `${String(input.id)}.json`, actId: act.id,
    definitionVersion: input.definitionVersion, membershipRule: input.membershipRule, conditions: input.conditions,
    captureStartedAt: input.captureStartedAt, captureEndedAt: input.captureEndedAt, totalCount: input.totalCount })
  const metadata = parseLegendPlayersManifest({ schemaVersion: 1, generatedAt: input.generatedAt,
    source: { url: source.url, title: source.title }, datasets: [descriptor] })
  if (!Array.isArray(input.players) || input.players.length !== descriptor.totalCount) invalid('players: count mismatch')
  const players: LegendPlayerRow[] = input.players.map((value, index) => {
    const row = record(value, 'player', ['id', 'playerName', 'characterId', 'rank', 'masterRating'])
    if (row.id !== `entry-${index + 1}`) invalid('player.id: capture-local ordinal required')
    const characterId = text(row.characterId, 'player.characterId', 40)
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(characterId)) invalid('player.characterId')
    return { id: row.id, playerName: text(row.playerName, 'player.playerName', 128), characterId,
      rank: integer(row.rank, 'player.rank', 1), masterRating: integer(row.masterRating, 'player.masterRating', 0) }
  })
  if (players.some((row, index) => index > 0 && (row.rank < players[index - 1].rank
    || row.masterRating > players[index - 1].masterRating))) invalid('players: source ordering')
  const validation = record(input.validation, 'validation', ['status', 'coverage', 'checks', 'notes'])
  if (validation.status !== 'verified' || validation.coverage !== 'all-listed-legend-entries') invalid('validation: incomplete')
  const checks = texts(validation.checks, 'validation.checks'), notes = texts(validation.notes, 'validation.notes')
  if (checks.length !== LEGEND_ANALYSIS_VALIDATION_CHECKS.length || new Set(checks).size !== checks.length
    || LEGEND_ANALYSIS_VALIDATION_CHECKS.some(check => !checks.includes(check)) || !notes.length) invalid('validation: incomplete evidence')
  const dataset: LegendPlayersDataset = {
    schemaVersion: 1, id: descriptor.id, captureStartedAt: descriptor.captureStartedAt, captureEndedAt: descriptor.captureEndedAt,
    generatedAt: metadata.generatedAt,
    source: { ...metadata.source, population: text(source.population, 'source.population'), metric: text(source.metric, 'source.metric'),
      unit: 'account-character', notes: texts(source.notes, 'source.notes') },
    act: { id: descriptor.actId, label: text(act.label, 'act.label') }, definitionVersion: descriptor.definitionVersion,
    membershipRule: descriptor.membershipRule, conditions: descriptor.conditions, totalCount: descriptor.totalCount, players,
    validation: { status: 'verified', coverage: 'all-listed-legend-entries', checks, notes },
  }
  if (expected && JSON.stringify(descriptorFor(dataset)) !== JSON.stringify(parseLegendPlayersDescriptor(expected))) {
    throw new Error('選択した取得日とプレイヤー一覧が一致しません。')
  }
  return dataset
}

export function createLegendPlayersDescriptor(value: LegendPlayersDataset): LegendPlayersDescriptor {
  return descriptorFor(parseLegendPlayersDataset(value))
}

/** Equal values retain source order; player names are labels, not unique identities. */
export function sortLegendPlayers(rows: readonly LegendPlayerRow[], key: LegendPlayerSortKey,
  direction: LegendPlayerSortDirection, names?: ReadonlyMap<string, string>): LegendPlayerRow[] {
  const sign = direction === 'asc' ? 1 : -1
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const left = key === 'characterId' ? names?.get(a.row.characterId) ?? a.row.characterId : a.row[key]
    const right = key === 'characterId' ? names?.get(b.row.characterId) ?? b.row.characterId : b.row[key]
    const compared = typeof left === 'number' && typeof right === 'number' ? left - right
      : String(left).localeCompare(String(right), 'ja')
    return compared * sign || a.index - b.index
  }).map(item => item.row)
}

export const LEGEND_PLAYERS_SOURCE = LEGEND_ANALYSIS_SOURCE
