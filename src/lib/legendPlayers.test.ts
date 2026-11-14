import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS } from './legendAnalysis.ts'
import { applyLegendRankedMatchSupplement, createLegendPlayersDescriptor, filterLegendPlayers, legendPlayerCharacterOptions,
  parseLegendPlayersDataset, parseLegendPlayersDescriptor, parseLegendPlayersManifest, parseLegendRankedMatchSupplement,
  sortLegendPlayers } from './legendPlayers.ts'
import { createLegendPlayersFeed } from './legendPlayersFeed.ts'
import type { LegendPlayersDataset, LegendPlayersManifest, LegendRankedMatchSupplement } from '../types/legendPlayers.ts'

function dataset(day = '28'): LegendPlayersDataset {
  return {
    schemaVersion: 1, id: `legend-2026-10-${day}T00-00-00-000Z`, captureStartedAt: `2026-10-${day}T00:00:00.000Z`,
    captureEndedAt: `2026-10-${day}T00:01:00.000Z`, generatedAt: `2026-10-${day}T00:02:00.000Z`,
    source: { ...LEGEND_ANALYSIS_SOURCE, population: '人工テスト', metric: '掲載プレイヤー一覧', unit: 'account-character', notes: ['人工テスト。'] },
    act: { id: 'act-13', label: 'Act 13' }, definitionVersion: 'legend-listed-v1', membershipRule: 'official-legend-badge',
    conditions: { region: 'all', platform: 'all', characters: 'all', users: 'source-default' }, totalCount: 3,
    players: [
      { id: 'entry-1', playerName: 'サンプルA', characterId: 'ryu', rank: 1, masterRating: 2500 },
      { id: 'entry-2', playerName: 'サンプルB', characterId: 'ken', rank: 2, masterRating: 2400 },
      { id: 'entry-3', playerName: 'サンプルA', characterId: 'chunli', rank: 2, masterRating: 2400 },
    ],
    validation: { status: 'verified', coverage: 'all-listed-legend-entries', checks: [...LEGEND_ANALYSIS_VALIDATION_CHECKS], notes: ['人工テスト。'] },
  }
}
function manifest(values = [dataset()]): LegendPlayersManifest {
  return { schemaVersion: 1, generatedAt: '2026-10-28T00:03:00.000Z', source: LEGEND_ANALYSIS_SOURCE,
    datasets: values.map(createLegendPlayersDescriptor) }
}

function enrichedDataset(day = '28'): LegendPlayersDataset {
  const value = dataset(day)
  return { ...value, schemaVersion: 2,
    rankedMatchScope: { actId: value.act.id, mode: 'ranked',
      collectionStartedAt: `2026-10-${day}T00:01:00.000Z`, collectionEndedAt: `2026-10-${day}T00:01:30.000Z` },
    players: value.players.map((row, index) => ({ ...row, playerId: index === 1 ? '0000000020' : '0000000001',
      region: index === 1 ? 'United States' : 'Japan', platform: index === 1 ? 'PlayStation 5' : 'Steam',
      rankedMatchCount: index === 0 ? 0 : 120 * index })),
  }
}

function rankingOnlyDataset(day = '28'): LegendPlayersDataset {
  const { rankedMatchScope: _scope, ...value } = enrichedDataset(day)
  return { ...value, schemaVersion: 3,
    rankedMatchAvailability: { status: 'unavailable', reason: 'access-unavailable', checkedAt: `2026-10-${day}T00:01:30.000Z` },
    players: value.players.map(({ rankedMatchCount: _count, ...row }) => row),
  }
}

function splitRankingDataset(): LegendPlayersDataset {
  const { rankedMatchAvailability: _availability, ...value } = rankingOnlyDataset()
  return { ...value, schemaVersion: 4 }
}

function matchSupplement(ranking: LegendPlayersDataset): LegendRankedMatchSupplement {
  return {
    schemaVersion: 1, datasetId: ranking.id, generatedAt: '2026-10-28T01:15:00.000Z',
    rankedMatchScope: { actId: ranking.act.id, mode: 'ranked', collectionStartedAt: '2026-10-28T00:05:00.000Z',
      collectionEndedAt: '2026-10-28T01:14:00.000Z' },
    counts: ranking.players.map(({ id, playerId, characterId }, index) => ({ id, playerId: playerId!, characterId,
      rankedMatchCount: index * 120 })).reverse(),
  }
}

test('player rows round-trip independently of aggregates, preserving duplicate names and tied ranks', () => {
  const value = dataset()
  assert.deepEqual(parseLegendPlayersDataset(JSON.parse(JSON.stringify(value)), createLegendPlayersDescriptor(value)), value)
  assert.deepEqual(parseLegendPlayersManifest(manifest()), manifest())
  assert.equal(value.players.filter(row => row.playerName === 'サンプルA').length, 2)
})

test('uncollected and a verified empty capture remain different states', () => {
  const uncollected = { ...manifest([]), availability: { status: 'not-collected', checkedAt: '2026-10-28T00:00:00.000Z', message: '未取得' } }
  assert.deepEqual(parseLegendPlayersManifest(uncollected), uncollected)
  const empty = { ...dataset(), players: [], totalCount: 0 }
  assert.deepEqual(parseLegendPlayersDataset(empty), empty)
  assert.throws(() => parseLegendPlayersManifest({ ...uncollected, datasets: manifest().datasets }))
})

test('unknown fields cannot carry account identities, profiles, or session state', () => {
  const value = dataset()
  for (const field of ['accountKey', 'playerId', 'profileUrl', 'storageState', 'cookies']) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, [field]: 'must-not-persist' }), /unknown field/)
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: value.players.map(row => ({ ...row, [field]: 'must-not-persist' })) }), /unknown field/)
    assert.throws(() => parseLegendPlayersDataset({ ...value, source: { ...value.source, [field]: 'must-not-persist' } }), /unknown field/)
    assert.throws(() => parseLegendPlayersDataset({ ...value, validation: { ...value.validation, [field]: 'must-not-persist' } }), /unknown field/)
    assert.throws(() => parseLegendPlayersManifest({ ...manifest(), [field]: 'must-not-persist' }), /unknown field/)
  }
})

test('names remain text including markup-like punctuation, while missing/control-heavy labels are rejected', () => {
  const value = dataset()
  value.players[0].playerName = '<img src=x onerror=alert(1)>'
  assert.equal(parseLegendPlayersDataset(value).players[0].playerName, '<img src=x onerror=alert(1)>')
  for (const name of ['', ' ', ' trailing ', 'line\nbreak', 'null\0byte', 'a'.repeat(129), null, { name: 'nested' }]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: value.players.map(row => ({ ...row, playerName: name })) }))
  }
})

test('counts, ordinals, rank/MR values and source ordering must be valid', () => {
  const value = dataset()
  assert.throws(() => parseLegendPlayersDataset({ ...value, totalCount: 2 }), /count mismatch/)
  for (const id of ['account-123', 'entry-2', 'entry-0', 'entry-01']) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...value.players[0], id }, ...value.players.slice(1)] }), /ordinal/)
  }
  for (const rank of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...value.players[0], rank }, ...value.players.slice(1)] }))
  }
  for (const masterRating of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...value.players[0], masterRating }, ...value.players.slice(1)] }))
  }
  assert.throws(() => parseLegendPlayersDataset({ ...value, players: value.players.map((row, i) => ({ ...row, rank: 3 - i })) }), /ordering/)
  assert.throws(() => parseLegendPlayersDataset({ ...value, players: value.players.map((row, i) => ({ ...row, masterRating: 2000 + i })) }), /ordering/)
  const zeroMr = { ...value, totalCount: 1, players: [{ ...value.players[0], masterRating: 0 }] }
  assert.equal(parseLegendPlayersDataset(zeroMr).players[0].masterRating, 0)
})

test('capture metadata, expected descriptors and complete verification evidence are enforced', () => {
  const value = dataset(), descriptor = createLegendPlayersDescriptor(value)
  for (const path of ['../private.json', '/private.json', 'https://other.example/data.json', 'other.json']) {
    assert.throws(() => parseLegendPlayersDescriptor({ ...descriptor, path }))
  }
  assert.throws(() => parseLegendPlayersDataset({ ...value, id: 'legend-2026-10-27T00-00-00-000Z' }), /id\/path/)
  assert.throws(() => parseLegendPlayersDataset({ ...value, generatedAt: '2026-10-28T00:00:00.000Z' }))
  assert.throws(() => parseLegendPlayersDataset({ ...value, captureEndedAt: '2026-10-27T00:00:00.000Z' }))
  assert.throws(() => parseLegendPlayersDataset({ ...value, source: { ...value.source, url: 'https://other.example/' } }))
  assert.throws(() => parseLegendPlayersDataset({ ...value, source: { ...value.source, unit: 'account' } }))
  assert.throws(() => parseLegendPlayersDataset(value, { ...descriptor, totalCount: 4 }), /一致しません/)
  assert.throws(() => parseLegendPlayersDataset(value, { ...descriptor, conditions: { ...descriptor.conditions, platform: 'pc' } }), /一致しません/)
  assert.throws(() => parseLegendPlayersDataset({ ...value, validation: { ...value.validation, status: 'pending' } }))
  assert.throws(() => parseLegendPlayersDataset({ ...value, validation: { ...value.validation, checks: [] } }))
  assert.throws(() => parseLegendPlayersDataset({ ...value, validation: { ...value.validation, checks: value.validation.checks.map(() => value.validation.checks[0]) } }))
})

test('sorting uses Japanese display names, preserves ties, and never mutates the capture', () => {
  const rows = dataset().players, original = structuredClone(rows)
  assert.deepEqual(sortLegendPlayers(rows, 'masterRating', 'asc').map(row => row.id), ['entry-2', 'entry-3', 'entry-1'])
  assert.deepEqual(sortLegendPlayers(rows, 'playerName', 'desc').map(row => row.id), ['entry-2', 'entry-1', 'entry-3'])
  const names = new Map([['ryu', 'あ'], ['ken', 'い'], ['chunli', 'う']])
  assert.deepEqual(sortLegendPlayers(rows, 'characterId', 'asc', names).map(row => row.id), ['entry-1', 'entry-2', 'entry-3'])
  assert.deepEqual(sortLegendPlayers(rows, 'rank', 'desc').map(row => row.id), ['entry-2', 'entry-3', 'entry-1'])
  assert.deepEqual(rows, original)
})

test('name filtering normalizes case and width, combines the character condition, and preserves source identities', () => {
  const rows = dataset().players.map((row, index) => ({ ...row, playerName: index === 1 ? 'Other' : '＠Sycom | ｻﾝﾌﾟﾙ', playerId: '987654321' }))
  const original = structuredClone(rows)
  assert.deepEqual(filterLegendPlayers(rows, { query: '  ＳＹＣＯＭ  ', characterId: '' }), [rows[0], rows[2]])
  assert.deepEqual(filterLegendPlayers(rows, { query: 'サンプル', characterId: 'chunli' }), [rows[2]])
  assert.deepEqual(filterLegendPlayers(rows, { query: 'sycom', characterId: 'ken' }), [])
  assert.deepEqual(filterLegendPlayers(rows, { query: '　 ', characterId: 'ken' }), [rows[1]])
  assert.deepEqual(filterLegendPlayers(rows, { query: '', characterId: '' }), rows)
  assert.equal(filterLegendPlayers(rows, { query: 'sycom', characterId: '' })[0], rows[0])
  assert.deepEqual(rows, original)
})

test('name filtering is literal and does not search account IDs or character IDs', () => {
  const rows = [{ ...dataset().players[0], playerName: 'Name [A].*', playerId: '987654321' }]
  for (const query of ['987654321', 'ryu', 'リュウ', 'missing', '^Name']) {
    assert.deepEqual(filterLegendPlayers(rows, { query, characterId: '' }), [])
  }
  assert.deepEqual(filterLegendPlayers(rows, { query: '[a].*', characterId: '' }), rows)
  assert.deepEqual(filterLegendPlayers([], { query: '', characterId: '' }), [])
})

test('character options deduplicate original rows, sort display names, and retain unlisted selections', () => {
  const rows = [...dataset().players, dataset().players[0]]
  const original = structuredClone(rows)
  const names = new Map([['ryu', 'う'], ['ken', 'あ'], ['chunli', 'い'], ['ed', 'え']])
  assert.deepEqual(legendPlayerCharacterOptions(rows, names, 'ken'), [
    { id: 'ken', name: 'あ' }, { id: 'chunli', name: 'い' }, { id: 'ryu', name: 'う' },
  ])
  assert.deepEqual(legendPlayerCharacterOptions(rows, names, 'ed').at(-1), { id: 'ed', name: 'え' })
  assert.deepEqual(legendPlayerCharacterOptions([], names, 'ken'), [{ id: 'ken', name: 'あ' }])
  assert.deepEqual(legendPlayerCharacterOptions([], null, 'future_fighter'), [{ id: 'future_fighter', name: 'future_fighter' }])
  assert.deepEqual(legendPlayerCharacterOptions([], names, ''), [])
  assert.deepEqual(rows, original)
})

test('schema 2 preserves public source labels and confirmed zero with a separate current-Act collection scope', () => {
  const value = enrichedDataset()
  assert.deepEqual(parseLegendPlayersDataset(value, createLegendPlayersDescriptor(value)), value)
  assert.equal(parseLegendPlayersDataset(value).players[0].rankedMatchCount, 0)
  assert.equal(parseLegendPlayersDataset(value).players[0].playerId, '0000000001')
  const mixed = manifest([value, dataset('27')])
  assert.deepEqual(parseLegendPlayersManifest(mixed), mixed)
  assert.deepEqual(createLegendPlayersDescriptor(value), createLegendPlayersDescriptor(dataset()))
  assert.equal(Object.hasOwn(parseLegendPlayersDataset(dataset()), 'rankedMatchScope'), false)
  assert.equal(Object.hasOwn(parseLegendPlayersDataset(dataset()).players[0], 'rankedMatchCount'), false)
})

test('schema 2 requires every new field, safe integer match counts and bounded source labels', () => {
  const value = enrichedDataset()
  const first = value.players[0]
  for (const field of ['playerId', 'region', 'platform', 'rankedMatchCount'] as const) {
    const { [field]: _missing, ...incomplete } = first
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [incomplete, ...value.players.slice(1)] }), new RegExp(field))
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...first, [field]: null }, ...value.players.slice(1)] }), new RegExp(field))
  }
  for (const rankedMatchCount of [-1, .1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10']) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...first, rankedMatchCount }, ...value.players.slice(1)] }), /rankedMatchCount/)
  }
  for (const playerId of ['', '123abc', '1.1', ' 123', '1'.repeat(21), 123]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...first, playerId }, ...value.players.slice(1)] }), /playerId/)
  }
  for (const field of ['region', 'platform'] as const) for (const label of ['', ' trailing ', 'line\nbreak', 'x'.repeat(129)]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...first, [field]: label }, ...value.players.slice(1)] }), new RegExp(field))
  }
  const duplicate = { ...value.players[1], playerId: first.playerId, characterId: first.characterId }
  assert.throws(() => parseLegendPlayersDataset({ ...value, players: [first, duplicate, value.players[2]] }), /duplicate account-character/)
})

test('schema 2 rejects another Act, non-ranked modes and invalid profile collection intervals', () => {
  const value = enrichedDataset(), scope = value.rankedMatchScope!
  assert.throws(() => parseLegendPlayersDataset({ ...value, rankedMatchScope: undefined }), /rankedMatchScope/)
  assert.throws(() => parseLegendPlayersDataset({ ...value, rankedMatchScope: { ...scope, actId: 'act-12' } }), /different Act/)
  for (const mode of ['all', 'casual', 'battle-hub', null]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, rankedMatchScope: { ...scope, mode } }), /mode/)
  }
  for (const scopePatch of [
    { collectionStartedAt: '2026-10-27T23:59:59.999Z' },
    { collectionEndedAt: '2026-10-28T00:00:59.999Z' },
    { collectionEndedAt: '2026-10-28T00:02:00.001Z' },
    { collectionStartedAt: '2026-02-30T00:01:00.000Z' },
    { collectionStartedAt: '2026-10-28' },
    { collectionEndedAt: '2026-10-28T00:01:30Z' },
  ]) assert.throws(() => parseLegendPlayersDataset({ ...value, rankedMatchScope: { ...scope, ...scopePatch } }), /rankedMatchScope/)
  assert.throws(() => parseLegendPlayersDataset({ ...dataset(), rankedMatchScope: scope }), /schemaVersion 1/)
})

test('schema 2 still rejects private IDs, profile links and authentication material outside approved fields', () => {
  const value = enrichedDataset()
  for (const field of ['accountKey', 'profilePath', 'profileUrl', 'storageState', 'cookies']) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, [field]: 'must-not-persist' }), /unknown field/)
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: value.players.map(row => ({ ...row, [field]: 'must-not-persist' })) }), /unknown field/)
    assert.throws(() => parseLegendPlayersDataset({ ...value, rankedMatchScope: { ...value.rankedMatchScope, [field]: 'must-not-persist' } }), /unknown field/)
  }
})

test('schema 3 preserves every verified ranking row and explicitly unavailable profile counts', () => {
  const value = rankingOnlyDataset(), descriptor = createLegendPlayersDescriptor(value)
  const parsed = parseLegendPlayersDataset(JSON.parse(JSON.stringify(value)), descriptor)
  assert.deepEqual(parsed, value)
  assert.deepEqual(descriptor, createLegendPlayersDescriptor(enrichedDataset()))
  assert.deepEqual(descriptor, createLegendPlayersDescriptor(dataset()))
  assert.equal(parsed.players[0].playerId, '0000000001')
  assert.equal(parsed.players.filter(row => row.playerId === '0000000001').length, 2)
  assert.equal(parsed.players.every(row => !Object.hasOwn(row, 'rankedMatchCount')), true)
  assert.equal(Object.hasOwn(parsed, 'rankedMatchScope'), false)
  assert.notEqual(parsed.rankedMatchAvailability, value.rankedMatchAvailability)
  const mixed = manifest([value, enrichedDataset('27'), dataset('26')])
  assert.deepEqual(parseLegendPlayersManifest(mixed), mixed)
  for (const reason of ['authentication-unavailable', 'source-unconfirmed', 'source-changed', 'access-unavailable',
    'cancelled', 'request-limit', 'collection-failed']) {
    const expected = { ...value, rankedMatchAvailability: { ...value.rankedMatchAvailability, reason } }
    assert.deepEqual(parseLegendPlayersDataset(expected), expected)
  }
})

test('schema 3 never accepts partial, zero-filled or stale match counts and does not weaken schemas 1 or 2', () => {
  const value = rankingOnlyDataset()
  for (const rankedMatchCount of [undefined, null, 0, 123]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value,
      players: [{ ...value.players[0], rankedMatchCount }, ...value.players.slice(1)] }), /unknown field/)
  }
  for (const rankedMatchScope of [undefined, null, enrichedDataset().rankedMatchScope]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, rankedMatchScope }), /rankedMatchScope/)
  }
  for (const legacy of [dataset(), enrichedDataset()]) {
    for (const rankedMatchAvailability of [undefined, null, value.rankedMatchAvailability]) {
      assert.throws(() => parseLegendPlayersDataset({ ...legacy, rankedMatchAvailability }), /rankedMatchAvailability/)
    }
    assert.deepEqual(parseLegendPlayersDataset(legacy), legacy)
    assert.equal(Object.hasOwn(parseLegendPlayersDataset(legacy), 'rankedMatchAvailability'), false)
  }
  const v2 = enrichedDataset()
  assert.throws(() => parseLegendPlayersDataset({ ...v2, players: value.players }), /rankedMatchCount/)
  assert.throws(() => parseLegendPlayersDataset({ ...value, schemaVersion: 2,
    rankedMatchScope: v2.rankedMatchScope }), /rankedMatchAvailability/)
})

test('schema 3 validates the bounded failure reason and check time without carrying private diagnostics', () => {
  const value = rankingOnlyDataset(), availability = value.rankedMatchAvailability!
  for (const rankedMatchAvailability of [undefined, null, {}, { ...availability, status: 'available' },
    { ...availability, reason: 'private-site-response' }, { ...availability, reason: null },
    { ...availability, checkedAt: '2026-10-28T00:00:59.999Z' },
    { ...availability, checkedAt: '2026-10-28T00:02:00.001Z' },
    { ...availability, checkedAt: '2026-10-28T00:01:30Z' },
    { ...availability, checkedAt: '2026-02-30T00:01:30.000Z' },
    { ...availability, checkedAt: null }]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, rankedMatchAvailability }), /rankedMatchAvailability/)
  }
  for (const field of ['status', 'reason', 'checkedAt'] as const) {
    const { [field]: _missing, ...incomplete } = availability
    assert.throws(() => parseLegendPlayersDataset({ ...value, rankedMatchAvailability: incomplete }), /rankedMatchAvailability/)
  }
  for (const checkedAt of [value.captureEndedAt, value.generatedAt]) {
    assert.equal(parseLegendPlayersDataset({ ...value, rankedMatchAvailability: { ...availability, checkedAt } }).rankedMatchAvailability!.checkedAt, checkedAt)
  }
  for (const field of ['accountKey', 'profileUrl', 'storageState', 'cookies', 'error', 'rawHtml']) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, rankedMatchAvailability: { ...availability, [field]: 'must-not-persist' } }), /unknown field/)
    assert.throws(() => parseLegendPlayersDataset({ ...value, [field]: 'must-not-persist' }), /unknown field/)
    assert.throws(() => parseLegendPlayersDataset({ ...value,
      players: value.players.map(row => ({ ...row, [field]: 'must-not-persist' })) }), /unknown field/)
  }
})

test('schema 3 still requires complete identity fields, unique account-character rows and verified ordered coverage', () => {
  const value = rankingOnlyDataset(), first = value.players[0]
  for (const field of ['playerId', 'region', 'platform'] as const) {
    const { [field]: _missing, ...incomplete } = first
    for (const row of [incomplete, { ...first, [field]: null }, { ...first, [field]: '' }]) {
      assert.throws(() => parseLegendPlayersDataset({ ...value, players: [row, ...value.players.slice(1)] }), new RegExp(field))
    }
  }
  for (const playerId of [123, '123abc', ' 123', '1'.repeat(21)]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...first, playerId }, ...value.players.slice(1)] }), /playerId/)
  }
  for (const field of ['region', 'platform'] as const) for (const label of [' trailing ', 'line\nbreak', 'x'.repeat(129)]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...first, [field]: label }, ...value.players.slice(1)] }), new RegExp(field))
  }
  assert.throws(() => parseLegendPlayersDataset({ ...value, players: value.players.slice(0, 2) }), /count mismatch/)
  assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...first, id: 'entry-2' }, ...value.players.slice(1)] }), /ordinal/)
  assert.throws(() => parseLegendPlayersDataset({ ...value, players: [first,
    { ...value.players[1], playerId: first.playerId, characterId: first.characterId }, value.players[2]] }), /duplicate account-character/)
  for (const patch of [{ rank: 3 }, { masterRating: 2000 }]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, players: [{ ...first, ...patch }, ...value.players.slice(1)] }), /ordering/)
  }
  for (const patch of [{ status: 'pending' }, { coverage: 'partial' }, { checks: [] }]) {
    assert.throws(() => parseLegendPlayersDataset({ ...value, validation: { ...value.validation, ...patch } }), /validation/)
  }
  assert.throws(() => parseLegendPlayersDataset(value, { ...createLegendPlayersDescriptor(value), totalCount: 4 }), /一致しません/)
})

test('new-field sorting keeps missing legacy fields last in both directions and distinguishes zero', () => {
  const rows = [dataset().players[0], ...enrichedDataset().players.slice(1),
    { ...enrichedDataset().players[0], id: 'zero' }, { ...dataset().players[0], id: 'missing-2' }]
  const original = structuredClone(rows)
  for (const key of ['playerId', 'region', 'platform', 'rankedMatchCount'] as const) {
    for (const direction of ['asc', 'desc'] as const) {
      assert.deepEqual(sortLegendPlayers(rows, key, direction).slice(-2).map(row => row.id), ['entry-1', 'missing-2'])
    }
  }
  assert.deepEqual(sortLegendPlayers(rows, 'rankedMatchCount', 'asc').slice(0, 3).map(row => row.id), ['zero', 'entry-2', 'entry-3'])
  assert.deepEqual(sortLegendPlayers(rows, 'rankedMatchCount', 'desc').slice(0, 3).map(row => row.id), ['entry-3', 'entry-2', 'zero'])
  assert.deepEqual(rows, original)
})

const remote = 'https://history.example/public/players/', local = '/sf6/data/legend-players/'
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

test('split ranking accepts only complete ranking rows and no embedded profile result', () => {
  const ranking = splitRankingDataset(), supplement = matchSupplement(ranking)
  assert.deepEqual(parseLegendPlayersDataset(ranking, createLegendPlayersDescriptor(ranking)), ranking)
  assert.throws(() => parseLegendPlayersDataset({ ...ranking, rankedMatchScope: supplement.rankedMatchScope }), /schemaVersion 4/)
  assert.throws(() => parseLegendPlayersDataset({ ...ranking, rankedMatchAvailability: rankingOnlyDataset().rankedMatchAvailability }), /schemaVersion 4/)
  assert.throws(() => parseLegendPlayersDataset({ ...ranking, players: enrichedDataset().players }), /unknown field/)
})

test('a supplement matches capture, Act, time and every account-character before applying any counts', () => {
  const ranking = splitRankingDataset(), supplement = matchSupplement(ranking)
  const merged = applyLegendRankedMatchSupplement(ranking, parseLegendRankedMatchSupplement(supplement, ranking))
  assert.equal(merged.captureEndedAt, ranking.captureEndedAt)
  assert.equal(merged.rankedMatchScope?.collectionEndedAt, '2026-10-28T01:14:00.000Z')
  assert.deepEqual(merged.players.map(row => row.rankedMatchCount), [0, 120, 240])
  assert.ok(ranking.players.every(row => row.rankedMatchCount === undefined))

  const { counts, rankedMatchScope } = supplement
  for (const invalid of [
    { ...supplement, datasetId: dataset('27').id },
    { ...supplement, generatedAt: ranking.captureEndedAt },
    { ...supplement, rankedMatchScope: { ...rankedMatchScope, actId: 'act-14' } },
    { ...supplement, rankedMatchScope: { ...rankedMatchScope, collectionStartedAt: ranking.captureStartedAt } },
    { ...supplement, counts: counts!.slice(1) },
    { ...supplement, counts: [counts![1], ...counts!.slice(1)] },
    { ...supplement, counts: [{ ...counts![0], playerId: '0000000020' }, ...counts!.slice(1)] },
    { ...supplement, counts: [{ ...counts![0], characterId: 'ryu' }, ...counts!.slice(1)] },
    { ...supplement, counts: [{ ...counts![0], rankedMatchCount: -1 }, ...counts!.slice(1)] },
  ]) assert.throws(() => parseLegendRankedMatchSupplement(invalid, ranking))

  const failed = { schemaVersion: 1, datasetId: ranking.id, generatedAt: supplement.generatedAt,
    rankedMatchAvailability: rankingOnlyDataset().rankedMatchAvailability }
  assert.deepEqual(parseLegendRankedMatchSupplement(failed, ranking), failed)
  assert.throws(() => parseLegendRankedMatchSupplement({ ...failed, counts }, ranking), /conflicting/)
  assert.throws(() => parseLegendRankedMatchSupplement(failed, rankingOnlyDataset()), /schemaVersion 4/)
})

test('ranking loads without waiting for matches; a missing supplement can appear and is cached only after validation', async () => {
  const ranking = splitRankingDataset(), supplement = matchSupplement(ranking), requests: string[] = []
  let outcome: unknown = null
  const feed = createLegendPlayersFeed({ historyBaseUrl: remote, localBaseUrl: local, fetch: async (input, init) => {
    const url = String(input)
    requests.push(url)
    if (url === `${remote}index.json`) return json(manifest([ranking]))
    if (url.startsWith(remote)) return json(ranking)
    assert.equal(url, `https://history.example/match-counts/${ranking.id}.json`)
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.cache, 'no-store')
    return outcome ? json(outcome) : new Response(null, { status: 404 })
  } })
  const publication = await feed.loadPublication(), descriptor = createLegendPlayersDescriptor(ranking)
  assert.deepEqual(await feed.loadDataset(publication, descriptor), ranking)
  assert.equal(requests.length, 2)
  const loadSupplement = () => feed.loadRankedMatchSupplement(publication, descriptor, new AbortController().signal)
  assert.equal(await loadSupplement(), null)
  outcome = { ...supplement, datasetId: dataset('27').id }
  await assert.rejects(loadSupplement, /capture mismatch/)
  outcome = supplement
  assert.deepEqual(await loadSupplement(), supplement)
  assert.deepEqual(await loadSupplement(), supplement)
  assert.equal(requests.length, 5)
})

test('feed loads a complete player publication, omits credentials, and caches the verified body', async () => {
  const capture = dataset(), requests: string[] = []
  const feed = createLegendPlayersFeed({ historyBaseUrl: remote, localBaseUrl: local, fetch: async (input, init) => {
    const url = String(input); requests.push(url)
    assert.ok(url.startsWith(remote))
    assert.equal(init?.credentials, 'omit')
    return json(url.endsWith('index.json') ? manifest([capture]) : capture)
  } })
  const publication = await feed.loadPublication()
  assert.equal(publication.source, 'history')
  assert.deepEqual(await feed.loadDataset(publication, createLegendPlayersDescriptor(capture)), capture)
  assert.equal(requests.length, 2)
})

test('feed accepts complete schema 3 ranking rows without inventing unavailable profile counts', async () => {
  const capture = rankingOnlyDataset(), requests: string[] = []
  const feed = createLegendPlayersFeed({ historyBaseUrl: remote, localBaseUrl: local, fetch: async input => {
    const url = String(input); requests.push(url)
    return json(url.endsWith('index.json') ? manifest([capture]) : capture)
  } })
  const publication = await feed.loadPublication()
  assert.equal(publication.source, 'history')
  const loaded = await feed.loadDataset(publication, createLegendPlayersDescriptor(capture))
  assert.deepEqual(loaded, capture)
  assert.deepEqual(sortLegendPlayers(loaded.players, 'rankedMatchCount', 'asc'), loaded.players)
  assert.deepEqual(sortLegendPlayers(loaded.players, 'rankedMatchCount', 'desc'), loaded.players)
  assert.equal(loaded.players.every(row => row.rankedMatchCount === undefined), true)
  assert.equal(requests.length, 2)
})

test('invalid remote rows fall back to one complete bundled capture rather than mixing sources', async () => {
  const latest = dataset(), earlier = dataset('27'), requests: string[] = []
  const feed = createLegendPlayersFeed({ historyBaseUrl: remote, localBaseUrl: local, fetch: async input => {
    const url = String(input); requests.push(url)
    const capture = url.startsWith(remote) ? latest : earlier
    if (url.endsWith('index.json')) return json(manifest([capture]))
    return json(url.startsWith(remote) ? { ...capture, players: [] } : capture)
  } })
  const publication = await feed.loadPublication()
  assert.equal(publication.source, 'bundled')
  assert.deepEqual(await feed.loadDataset(publication, createLegendPlayersDescriptor(earlier)), earlier)
  assert.equal(requests.length, 4)
})

test('unavailable history falls back to honest uncollected local state without fake rows', async () => {
  const empty = { ...manifest([]), availability: { status: 'not-collected', checkedAt: '2026-10-28T00:00:00.000Z', message: '未取得' } }
  const feed = createLegendPlayersFeed({ historyBaseUrl: remote, localBaseUrl: local, fetch: async input =>
    String(input).startsWith(remote) ? new Response('', { status: 404 }) : json(empty) })
  const publication = await feed.loadPublication()
  assert.equal(publication.manifest.availability?.status, 'not-collected')
  assert.deepEqual(publication.manifest.datasets, [])
})
