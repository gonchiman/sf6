import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS } from './legendAnalysis.ts'
import { createLegendPlayersDescriptor, parseLegendPlayersDataset, parseLegendPlayersDescriptor,
  parseLegendPlayersManifest, sortLegendPlayers } from './legendPlayers.ts'
import { createLegendPlayersFeed } from './legendPlayersFeed.ts'
import type { LegendPlayersDataset, LegendPlayersManifest } from '../types/legendPlayers.ts'

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

const remote = 'https://history.example/public/players/', local = '/sf6/data/legend-players/'
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

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
