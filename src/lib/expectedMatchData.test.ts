import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createExpectedMatchData, expectedMatchControls, expectedMatchMonths, loadExpectedMatchData,
} from './expectedMatchData.ts'
import { EXPECTED_MATCH_RANK_THRESHOLDS } from './expectedMatches.ts'
import { WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import type { ExpectedMatchSelection } from '../types/expectedMatchData.ts'
import type { HistoryDatasetResult } from '../types/winRateHistory.ts'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateEdition, WinRateManifest } from '../types/winRates.ts'

const capturedAt = '2026-10-08T00:00:00.000Z'
const selected: ExpectedMatchSelection = { month: '2026-01', controlType: 'combined' }

function descriptor(
  league: string, operationMode: 'combined' | 'separate' = 'combined', month = selected.month,
  edition?: WinRateEdition,
): WinRateDatasetDescriptor {
  const id = `${edition === 'master' ? 'master-' : ''}${month}-${league.toLowerCase()}-${operationMode}`
  return { ...(edition ? { edition } : {}), id, league, operationMode, month, path: `${id}.json`, capturedAt }
}

function manifest(datasets: WinRateDatasetDescriptor[]): WinRateManifest {
  return { schemaVersion: 1, generatedAt: capturedAt, source: WIN_RATE_EDITION_SOURCES.general, datasets }
}

function dataset(desc: WinRateDatasetDescriptor, characterIds = ['ryu', 'honda']): WinRateDataset {
  const fighters = characterIds.flatMap(characterId => {
    const controls = desc.operationMode === 'combined' ? [null] : ['classic', 'modern'] as const
    return controls.map(controlType => ({
      id: `${characterId}-${controlType ?? 'combined'}`, characterId, name: characterId.toUpperCase(), controlType,
    }))
  })
  return {
    ...(desc.edition ? { edition: desc.edition } : {}),
    schemaVersion: 1, id: desc.id, month: desc.month, league: desc.league,
    operationMode: desc.operationMode, capturedAt: desc.capturedAt, generatedAt: capturedAt,
    source: {
      ...WIN_RATE_EDITION_SOURCES[desc.edition ?? 'general'],
      population: 'ランクマッチ', metric: '公式Total', notes: ['元の試合数は未確認'],
    },
    fighters,
    // The Total join must use fighterId, independently of row order or matchup cells.
    rows: fighters.map(fighter => ({
      fighterId: fighter.id, total: { text: '5.058', lowSample: false },
      cells: fighters.map(() => ({ text: '1.000', lowSample: false })),
    })).reverse(),
  }
}

function ready(desc: WinRateDatasetDescriptor, value = dataset(desc)): HistoryDatasetResult {
  return { month: desc.month, descriptor: desc, status: 'ready', dataset: value }
}

function sevenRanks(mode: 'combined' | 'separate' = 'combined', month = selected.month) {
  const descriptors = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => descriptor(rank.id, mode, month))
  return { descriptors, manifest: manifest(descriptors), results: descriptors.map(desc => ready(desc)) }
}

function setTotal(data: WinRateDataset, fighterId: string, text: string, lowSample = false): void {
  data.rows.find(row => row.fighterId === fighterId)!.total = { text, lowSample }
}

test('latest separate roster retains all current characters in a historical combined table', () => {
  const fixture = sevenRanks('combined', '2023-06')
  const roster = dataset(descriptor('MASTER', 'separate', '2026-08'), ['ryu', 'honda', 'ingrid']).fighters
  const before = structuredClone({ fixture, roster })
  const data = createExpectedMatchData(fixture.manifest, { month: '2023-06', controlType: 'combined' }, roster, fixture.results)
  assert.deepEqual(data.characters.map(character => character.fighter.characterId), ['ryu', 'honda', 'ingrid'])
  assert.equal(data.characters[0].available, true)
  assert.equal(data.characters[1].available, true)
  const newer = data.characters[2]
  assert.equal(newer.available, false)
  assert.equal(newer.ranks.length, 7)
  assert.ok(newer.ranks.every(rank => rank.status === 'unlisted' && rank.probability === null))
  assert.equal(data.failedCount, 0)
  assert.deepEqual({ fixture, roster }, before)
})

test('official precision, zero, both dash markers, and low-sample metadata remain distinct', () => {
  const fixture = sevenRanks()
  const texts = ['0.000', '5.058', '-.---', '-', '4.234', '5.058', '10.000']
  fixture.results.forEach((result, index) => {
    assert.equal(result.status, 'ready')
    if (result.status === 'ready') setTotal(result.dataset, 'ryu-combined', texts[index], index === 4)
  })
  const roster = dataset(descriptor('MASTER')).fighters
  const data = createExpectedMatchData(fixture.manifest, selected, roster, fixture.results)
  const ryu = data.characters.find(character => character.fighter.characterId === 'ryu')!
  assert.deepEqual(ryu.ranks.map(rank => rank.status), ['value', 'value', 'missing', 'missing', 'value', 'value', 'value'])
  assert.deepEqual(ryu.ranks.map(rank => rank.probability), [0, 5058 / 10000, null, null, 4234 / 10000, 5058 / 10000, 1])
  assert.deepEqual(ryu.ranks.map(rank => rank.text), texts)
  assert.equal(ryu.ranks[4].lowSample, true)
  assert.equal(ryu.available, false)
  assert.equal(data.characters.find(character => character.fighter.characterId === 'honda')!.available, true)
  assert.equal(data.failedCount, 0)
})

test('stable fighter IDs and selected controls determine Total instead of names, row order, or cell averages', () => {
  const fixture = sevenRanks('separate')
  for (const result of fixture.results) {
    if (result.status !== 'ready') assert.fail('ready fixture required')
    result.dataset.fighters.forEach(fighter => { fighter.name = 'SHARED DISPLAY NAME' })
    for (const [id, text] of [
      ['ryu-classic', '4.321'], ['ryu-modern', '6.789'],
      ['honda-classic', '1.234'], ['honda-modern', '9.876'],
    ]) setTotal(result.dataset, id, text)
  }
  const roster = dataset(descriptor('MASTER', 'separate')).fighters
  const before = structuredClone(fixture)
  for (const [controlType, expected] of [
    ['classic', [0.4321, 0.1234]], ['modern', [0.6789, 0.9876]],
  ] as const) {
    const data = createExpectedMatchData(fixture.manifest, { ...selected, controlType }, roster, fixture.results)
    assert.deepEqual(data.characters.map(character => character.fighter.characterId), ['ryu', 'honda'])
    data.characters.forEach((character, index) => {
      assert.equal(character.available, true)
      assert.deepEqual(character.ranks.map(rank => rank.probability), Array(7).fill(expected[index]))
    })
  }
  assert.deepEqual(fixture, before)
})

test('all seven rank inputs are necessary and unregistered ranks never use another rank', () => {
  const fixture = sevenRanks()
  const roster = dataset(descriptor('MASTER')).fighters
  for (let omitted = 0; omitted < fixture.descriptors.length; omitted++) {
    const input = manifest(fixture.descriptors.filter((_, index) => index !== omitted))
    const results = fixture.results.filter((_, index) => index !== omitted)
    const data = createExpectedMatchData(input, selected, roster, results)
    assert.equal(data.failedCount, 0)
    for (const character of data.characters) {
      assert.equal(character.available, false)
      assert.equal(character.ranks[omitted].status, 'unavailable')
      assert.equal(character.ranks[omitted].probability, null)
      assert.equal(character.ranks.filter(rank => rank.status === 'value').length, 6)
    }
  }
})

test('unlisted fighters and rank read failures remain separate from missing cells', () => {
  const fixture = sevenRanks()
  const roster = dataset(descriptor('MASTER')).fighters
  const results = [...fixture.results]
  results[1] = ready(fixture.descriptors[1], dataset(fixture.descriptors[1], ['honda']))
  results[2] = { month: selected.month, descriptor: fixture.descriptors[2], status: 'error' }
  const data = createExpectedMatchData(fixture.manifest, selected, roster, results)
  const ryu = data.characters.find(character => character.fighter.characterId === 'ryu')!
  assert.equal(ryu.ranks[1].status, 'unlisted')
  assert.equal(ryu.ranks[2].status, 'error')
  assert.equal(ryu.available, false)
  assert.equal(data.failedCount, 1)
  assert.equal(data.datasets.length, 6)
})

test('stale, mismatched, or duplicate results are rejected by the selected rank projection', () => {
  const fixture = sevenRanks()
  const desc = fixture.descriptors[0]
  const roster = dataset(descriptor('MASTER')).fighters
  const failures: HistoryDatasetResult[][] = [
    [ready({ ...desc, path: 'old-path.json' })],
    [ready({ ...desc, capturedAt: '2026-10-09T00:00:00.000Z' })],
    [ready({ ...desc, id: 'old-rookie-dataset' })],
    [ready({ ...desc, edition: 'master' })],
    [ready(desc, { ...dataset(desc), month: '2026-02' })],
    [ready(desc, { ...dataset(desc), league: 'IRON' })],
    [ready(desc, { ...dataset(desc), operationMode: 'separate' })],
    [ready(desc, { ...dataset(desc), capturedAt: '2026-10-09T00:00:00.000Z' })],
    [{ ...ready(desc), month: '2026-02' }],
    [ready(desc), ready(desc)],
  ]
  for (const stale of failures) {
    const data = createExpectedMatchData(fixture.manifest, selected, roster, [...stale, ...fixture.results.slice(1)])
    assert.equal(data.failedCount, 1)
    assert.equal(data.datasets.length, 6)
    for (const character of data.characters) {
      assert.equal(character.available, false)
      assert.equal(character.ranks[0].status, 'error')
      assert.equal(character.ranks[0].probability, null)
      assert.equal(character.ranks[0].text, null)
    }
  }
})

test('empty roster preserves seven error statuses and load rejects a silent empty result', async () => {
  const fixture = sevenRanks()
  const errors: HistoryDatasetResult[] = fixture.descriptors.map(desc => ({
    month: desc.month, descriptor: desc, status: 'error',
  }))
  const projected = createExpectedMatchData(fixture.manifest, selected, [], errors)
  assert.deepEqual(projected.characters, [])
  assert.deepEqual(projected.datasets, [])
  assert.equal(projected.failedCount, 7)
  const requested: string[] = []
  await assert.rejects(loadExpectedMatchData(fixture.manifest, selected, [], async desc => {
    requested.push(desc.id)
    throw new Error('fixture read failure')
  }), Error)
  assert.deepEqual(requested.sort(), fixture.descriptors.map(desc => desc.id).sort())
})

test('loading uses only the selected general month and mode for the seven pre-MASTER ranks', async () => {
  const fixture = sevenRanks('separate')
  const otherMode = sevenRanks('combined')
  const otherMonth = sevenRanks('separate', '2025-12')
  const input = manifest([
    ...fixture.descriptors, ...otherMode.descriptors, ...otherMonth.descriptors,
    descriptor('MASTER', 'combined'), descriptor('MASTER', 'combined', '2026-02', 'master'),
  ])
  assert.deepEqual(expectedMatchMonths(input), ['2026-01', '2025-12'])
  assert.deepEqual(expectedMatchControls(input, selected.month), ['combined', 'classic', 'modern'])
  assert.deepEqual(expectedMatchControls(input, '2025-12'), ['classic', 'modern'])
  const calls: WinRateDatasetDescriptor[] = []
  const data = await loadExpectedMatchData(input, { ...selected, controlType: 'modern' }, [], async desc => {
    calls.push(desc)
    return dataset(desc)
  })
  assert.deepEqual(calls.map(desc => desc.id).sort(), fixture.descriptors.map(desc => desc.id).sort())
  assert.equal(data.failedCount, 0)
  assert.equal(data.datasets.length, 7)
  assert.equal(data.characters.length, 2)
  assert.ok(data.characters.every(character => character.available))
})
