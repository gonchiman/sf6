import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS,
  parseLegendAnalysisDescriptor, parseLegendAnalysisManifest } from './legendAnalysis.ts'
import type { LegendPlayerRow, LegendPlayerSortDirection, LegendPlayerSortKey,
  LegendPlayersDataset, LegendPlayersDescriptor, LegendPlayersManifest, LegendRankedMatchAvailability,
  LegendRankedMatchScope, LegendRankedMatchSupplement } from '../types/legendPlayers.ts'

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
function timestamp(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(field)
  return result
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

function parseRankedMatchScope(value: unknown, actId: string, earliest: string, generatedAt: string): LegendRankedMatchScope {
  const scope = record(value, 'rankedMatchScope', ['actId', 'mode', 'collectionStartedAt', 'collectionEndedAt'])
  if (scope.actId !== actId) invalid('rankedMatchScope.actId: different Act')
  if (scope.mode !== 'ranked') invalid('rankedMatchScope.mode')
  const collectionStartedAt = timestamp(scope.collectionStartedAt, 'rankedMatchScope.collectionStartedAt')
  const collectionEndedAt = timestamp(scope.collectionEndedAt, 'rankedMatchScope.collectionEndedAt')
  if (collectionStartedAt < earliest || collectionEndedAt < collectionStartedAt
    || collectionEndedAt > generatedAt) invalid('rankedMatchScope: invalid collection interval')
  return { actId, mode: 'ranked', collectionStartedAt, collectionEndedAt }
}

function parseRankedMatchAvailability(value: unknown, earliest: string, generatedAt: string): LegendRankedMatchAvailability {
  const availability = record(value, 'rankedMatchAvailability', ['status', 'reason', 'checkedAt'])
  if (availability.status !== 'unavailable') invalid('rankedMatchAvailability.status')
  if (!['authentication-unavailable', 'source-unconfirmed', 'source-changed', 'access-unavailable',
    'cancelled', 'request-limit', 'collection-failed'].includes(availability.reason as string)) invalid('rankedMatchAvailability.reason')
  const checkedAt = timestamp(availability.checkedAt, 'rankedMatchAvailability.checkedAt')
  if (checkedAt < earliest || checkedAt > generatedAt) invalid('rankedMatchAvailability: invalid check time')
  return { status: 'unavailable', reason: availability.reason as LegendRankedMatchAvailability['reason'], checkedAt }
}

export function parseLegendPlayersDataset(value: unknown, expected?: LegendPlayersDescriptor): LegendPlayersDataset {
  const input = record(value, 'dataset', ['schemaVersion', 'id', 'captureStartedAt', 'captureEndedAt', 'generatedAt',
    'source', 'act', 'definitionVersion', 'membershipRule', 'conditions', 'totalCount', 'validation', 'players', 'rankedMatchScope', 'rankedMatchAvailability'])
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== 3 && input.schemaVersion !== 4) invalid('schemaVersion')
  if (input.schemaVersion !== 2 && Object.hasOwn(input, 'rankedMatchScope')) invalid(`rankedMatchScope: unavailable in schemaVersion ${input.schemaVersion}`)
  if (input.schemaVersion !== 3 && Object.hasOwn(input, 'rankedMatchAvailability')) invalid(`rankedMatchAvailability: unavailable in schemaVersion ${input.schemaVersion}`)
  const source = record(input.source, 'source', ['url', 'title', 'population', 'metric', 'unit', 'notes'])
  if (source.unit !== 'account-character') invalid('source.unit')
  const act = record(input.act, 'act', ['id', 'label'])
  const descriptor = parseLegendPlayersDescriptor({ id: input.id, path: `${String(input.id)}.json`, actId: act.id,
    definitionVersion: input.definitionVersion, membershipRule: input.membershipRule, conditions: input.conditions,
    captureStartedAt: input.captureStartedAt, captureEndedAt: input.captureEndedAt, totalCount: input.totalCount })
  const metadata = parseLegendPlayersManifest({ schemaVersion: 1, generatedAt: input.generatedAt,
    source: { url: source.url, title: source.title }, datasets: [descriptor] })
  const rankedMatchScope = input.schemaVersion === 2
    ? parseRankedMatchScope(input.rankedMatchScope, descriptor.actId, descriptor.captureStartedAt, metadata.generatedAt) : undefined
  const rankedMatchAvailability = input.schemaVersion === 3
    ? parseRankedMatchAvailability(input.rankedMatchAvailability, descriptor.captureEndedAt, metadata.generatedAt) : undefined
  if (!Array.isArray(input.players) || input.players.length !== descriptor.totalCount) invalid('players: count mismatch')
  const players: LegendPlayerRow[] = input.players.map((value, index) => {
    const row = record(value, 'player', ['id', 'playerName', 'characterId', 'rank', 'masterRating',
      ...(input.schemaVersion !== 1 ? ['playerId', 'region', 'platform'] : []),
      ...(input.schemaVersion === 2 ? ['rankedMatchCount'] : [])])
    if (row.id !== `entry-${index + 1}`) invalid('player.id: capture-local ordinal required')
    const characterId = text(row.characterId, 'player.characterId', 40)
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(characterId)) invalid('player.characterId')
    const result: LegendPlayerRow = { id: row.id, playerName: text(row.playerName, 'player.playerName', 128), characterId,
      rank: integer(row.rank, 'player.rank', 1), masterRating: integer(row.masterRating, 'player.masterRating', 0) }
    if (input.schemaVersion !== 1) {
      const playerId = text(row.playerId, 'player.playerId', 20)
      if (!/^\d{1,20}$/.test(playerId)) invalid('player.playerId')
      result.playerId = playerId
      result.region = text(row.region, 'player.region', 128)
      result.platform = text(row.platform, 'player.platform', 128)
      if (input.schemaVersion === 2) result.rankedMatchCount = integer(row.rankedMatchCount, 'player.rankedMatchCount', 0)
    }
    return result
  })
  if (input.schemaVersion !== 1 && new Set(players.map(row => `${row.playerId}:${row.characterId}`)).size !== players.length) {
    invalid('players: duplicate account-character entry')
  }
  if (players.some((row, index) => index > 0 && (row.rank < players[index - 1].rank
    || row.masterRating > players[index - 1].masterRating))) invalid('players: source ordering')
  const validation = record(input.validation, 'validation', ['status', 'coverage', 'checks', 'notes'])
  if (validation.status !== 'verified' || validation.coverage !== 'all-listed-legend-entries') invalid('validation: incomplete')
  const checks = texts(validation.checks, 'validation.checks'), notes = texts(validation.notes, 'validation.notes')
  if (checks.length !== LEGEND_ANALYSIS_VALIDATION_CHECKS.length || new Set(checks).size !== checks.length
    || LEGEND_ANALYSIS_VALIDATION_CHECKS.some(check => !checks.includes(check)) || !notes.length) invalid('validation: incomplete evidence')
  const dataset: LegendPlayersDataset = {
    schemaVersion: input.schemaVersion, id: descriptor.id, captureStartedAt: descriptor.captureStartedAt, captureEndedAt: descriptor.captureEndedAt,
    generatedAt: metadata.generatedAt,
    source: { ...metadata.source, population: text(source.population, 'source.population'), metric: text(source.metric, 'source.metric'),
      unit: 'account-character', notes: texts(source.notes, 'source.notes') },
    act: { id: descriptor.actId, label: text(act.label, 'act.label') }, definitionVersion: descriptor.definitionVersion,
    membershipRule: descriptor.membershipRule, conditions: descriptor.conditions, totalCount: descriptor.totalCount, players,
    validation: { status: 'verified', coverage: 'all-listed-legend-entries', checks, notes },
    ...(rankedMatchScope ? { rankedMatchScope } : {}),
    ...(rankedMatchAvailability ? { rankedMatchAvailability } : {}),
  }
  if (expected && JSON.stringify(descriptorFor(dataset)) !== JSON.stringify(parseLegendPlayersDescriptor(expected))) {
    throw new Error('選択した取得日とプレイヤー一覧が一致しません。')
  }
  return dataset
}

export function createLegendPlayersDescriptor(value: LegendPlayersDataset): LegendPlayersDescriptor {
  return descriptorFor(parseLegendPlayersDataset(value))
}

export function parseLegendRankedMatchSupplement(value: unknown, ranking: LegendPlayersDataset): LegendRankedMatchSupplement {
  if (ranking.schemaVersion !== 4) invalid('ranked match supplement requires schemaVersion 4')
  const input = record(value, 'ranked match supplement', ['schemaVersion', 'datasetId', 'generatedAt',
    'rankedMatchScope', 'rankedMatchAvailability', 'counts'])
  if (input.schemaVersion !== 1 || input.datasetId !== ranking.id) invalid('ranked match supplement: capture mismatch')
  const generatedAt = timestamp(input.generatedAt, 'ranked match supplement.generatedAt')
  if (generatedAt < ranking.generatedAt) invalid('ranked match supplement: invalid generation time')
  const identity = { schemaVersion: 1 as const, datasetId: ranking.id, generatedAt }
  if (Object.hasOwn(input, 'rankedMatchAvailability')) {
    if (Object.hasOwn(input, 'rankedMatchScope') || Object.hasOwn(input, 'counts')) invalid('ranked match supplement: conflicting results')
    return { ...identity, rankedMatchAvailability: parseRankedMatchAvailability(input.rankedMatchAvailability, ranking.captureEndedAt, generatedAt) }
  }

  const rankedMatchScope = parseRankedMatchScope(input.rankedMatchScope, ranking.act.id, ranking.captureEndedAt, generatedAt)
  if (!Array.isArray(input.counts) || input.counts.length !== ranking.players.length) invalid('ranked match supplement: count mismatch')
  const expectedRows = new Map(ranking.players.map(row => [row.id, row]))
  const counts = input.counts.map(value => {
    const row = record(value, 'ranked match count', ['id', 'playerId', 'characterId', 'rankedMatchCount'])
    const id = text(row.id, 'ranked match count.id', 40)
    const expected = expectedRows.get(id)
    if (!expected?.playerId || row.playerId !== expected.playerId || row.characterId !== expected.characterId) {
      invalid('ranked match supplement: account-character mismatch')
    }
    expectedRows.delete(id)
    return { id, playerId: expected.playerId, characterId: expected.characterId,
      rankedMatchCount: integer(row.rankedMatchCount, 'rankedMatchCount', 0) }
  })
  return { ...identity, rankedMatchScope, counts }
}

/** Add a previously validated supplement for display while retaining the ranking's observation time. */
export function applyLegendRankedMatchSupplement(ranking: LegendPlayersDataset, supplement: LegendRankedMatchSupplement): LegendPlayersDataset {
  if (supplement.rankedMatchAvailability) return { ...ranking, rankedMatchAvailability: supplement.rankedMatchAvailability }
  const counts = new Map(supplement.counts.map(row => [row.id, row.rankedMatchCount]))
  return { ...ranking, rankedMatchScope: supplement.rankedMatchScope,
    players: ranking.players.map(row => ({ ...row, rankedMatchCount: counts.get(row.id) })) }
}

/** Match displayed names using the same text normalization as the character move search. */
export function filterLegendPlayers(rows: readonly LegendPlayerRow[], filters: { query: string; characterId: string }): LegendPlayerRow[] {
  const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('ja')
  const query = normalize(filters.query)
  return rows.filter(row => (!filters.characterId || row.characterId === filters.characterId)
    && (!query || normalize(row.playerName).includes(query)))
}

/** Keep an unlisted selection available when switching capture dates. */
export function legendPlayerCharacterOptions(rows: readonly LegendPlayerRow[], names: ReadonlyMap<string, string> | null,
  selectedId: string): { id: string; name: string }[] {
  const ids = new Set(rows.map(row => row.characterId))
  if (selectedId) ids.add(selectedId)
  return [...ids].map(id => ({ id, name: names?.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id))
}

/** Equal values retain source order; player names are labels, not unique identities. */
export function sortLegendPlayers(rows: readonly LegendPlayerRow[], key: LegendPlayerSortKey,
  direction: LegendPlayerSortDirection, names?: ReadonlyMap<string, string>): LegendPlayerRow[] {
  const sign = direction === 'asc' ? 1 : -1
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const left = key === 'characterId' ? names?.get(a.row.characterId) ?? a.row.characterId : a.row[key]
    const right = key === 'characterId' ? names?.get(b.row.characterId) ?? b.row.characterId : b.row[key]
    if (left === undefined || right === undefined) return left === right ? a.index - b.index : left === undefined ? 1 : -1
    const compared = typeof left === 'number' && typeof right === 'number' ? left - right
      : String(left).localeCompare(String(right), 'ja')
    return compared * sign || a.index - b.index
  }).map(item => item.row)
}

export const LEGEND_PLAYERS_SOURCE = LEGEND_ANALYSIS_SOURCE
