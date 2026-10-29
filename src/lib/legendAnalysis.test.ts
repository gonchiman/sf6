import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LegendAnalysisDataset, LegendAnalysisDescriptor, LegendAnalysisManifest } from '../types/legendAnalysis.ts'
import {
  createLegendCharacterRows, findPreviousLegendAnalysisDescriptor, legendAnalysisCanCompare,
  LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS,
  parseLegendAnalysisDataset, parseLegendAnalysisDescriptor,
  parseLegendAnalysisManifest, summarizeLegendMr,
} from './legendAnalysis.ts'

function dataset(day = '16', values: Record<string, number[]> = { ryu: [2000, 2100], ken: [2050], dhalsim: [] }): LegendAnalysisDataset {
  const characters = Object.entries(values).map(([characterId, mr]) => ({ characterId, name: characterId.toUpperCase(), count: mr.length, mr: summarizeLegendMr(mr) }))
  return {
    schemaVersion: 1, id: `legend-2026-10-${day}`, captureStartedAt: `2026-10-${day}T01:00:00.000Z`,
    captureEndedAt: `2026-10-${day}T01:01:00.000Z`, generatedAt: `2026-10-${day}T01:02:00.000Z`,
    source: { ...LEGEND_ANALYSIS_SOURCE, population: '公式のレジェンド掲載エントリー', metric: '掲載構成とMR分布',
      unit: 'account-character', notes: ['取得区間中の観測。対戦回数ベースの使用率ではない。'] },
    act: { id: '13', label: 'Act 13' }, definitionVersion: 'legend-listed-v1', membershipRule: 'official-legend-badge',
    conditions: { region: 'all', platform: 'all', characters: 'all', users: 'buckler-user-status-1' },
    totalCount: characters.reduce((total, item) => total + item.count, 0), characterIds: Object.keys(values),
    characters, mr: summarizeLegendMr(Object.values(values).flat()),
    validation: { status: 'verified', coverage: 'all-listed-legend-entries', checks: [...LEGEND_ANALYSIS_VALIDATION_CHECKS],
      notes: ['対象末尾の同順位行と次の非対象行を確認した。'] },
  }
}
function descriptor(input = dataset(), overrides: Partial<LegendAnalysisDescriptor> = {}): LegendAnalysisDescriptor {
  return { id: input.id, path: `${input.id}.json`, actId: input.act.id, definitionVersion: input.definitionVersion,
    membershipRule: input.membershipRule, conditions: { ...input.conditions }, captureStartedAt: input.captureStartedAt,
    captureEndedAt: input.captureEndedAt, totalCount: input.totalCount, ...overrides }
}
function manifest(datasets: LegendAnalysisDescriptor[] = [descriptor()]): LegendAnalysisManifest {
  return { schemaVersion: 1, generatedAt: '2026-10-21T00:00:00.000Z', source: LEGEND_ANALYSIS_SOURCE, datasets }
}

test('raw MR uses 50-point aligned half-open bins and R7 quantiles, retaining internal zero bins', () => {
  const mr = summarizeLegendMr([2100, 2000, 2200, 2050])
  assert.deepEqual(mr, { count: 4, min: 2000, p25: 2037.5, median: 2075, p75: 2125, max: 2200,
    mean: 2087.5, bins: [
      { lower: 2000, upper: 2050, count: 1 }, { lower: 2050, upper: 2100, count: 1 },
      { lower: 2100, upper: 2150, count: 1 }, { lower: 2150, upper: 2200, count: 0 },
      { lower: 2200, upper: 2250, count: 1 },
    ] })
  assert.deepEqual(summarizeLegendMr([0]), { count: 1, min: 0, p25: 0, median: 0, p75: 0, max: 0, mean: 0,
    bins: [{ lower: 0, upper: 50, count: 1 }] })
  assert.equal(summarizeLegendMr(Array(504).fill(2183)).mean, 2183)
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => summarizeLegendMr([value]))
})

test('empty availability differs from a verified zero capture, and real zero characters retain 0%', () => {
  const pending: LegendAnalysisManifest = { ...manifest([]), availability: {
    status: 'not-collected', checkedAt: '2026-10-20T00:00:00.000Z', message: '未取得',
  } }
  assert.deepEqual(parseLegendAnalysisManifest(pending), pending)
  assert.throws(() => parseLegendAnalysisManifest({ ...pending, datasets: [descriptor()] }), /already collected/)
  const failed = { ...manifest(), availability: { ...pending.availability!, status: 'collection-failed' as const } }
  assert.equal(parseLegendAnalysisManifest(failed).datasets.length, 1)
  const empty = dataset('16', { ryu: [], ken: [], dhalsim: [] })
  assert.deepEqual(parseLegendAnalysisDataset(empty), empty)
  assert.ok(createLegendCharacterRows(empty).every(row => row.count === 0 && row.percent === null && row.mr.min === null))
  const rows = createLegendCharacterRows(dataset())
  assert.equal(rows.find(row => row.characterId === 'dhalsim')!.percent, 0)
})

test('all aggregates round-trip with explicit roster and consistent overall MR summaries', () => {
  const input = dataset()
  assert.deepEqual(parseLegendAnalysisDataset(JSON.parse(JSON.stringify(input)), descriptor(input)), input)
  assert.deepEqual(parseLegendAnalysisManifest(manifest()), manifest())
  const many = dataset('16', { ryu: Array(504).fill(2183), ken: [], dhalsim: [] })
  assert.deepEqual(parseLegendAnalysisDataset(many), many)
  assert.equal(createLegendCharacterRows(input)[0].percent, 2 / 3 * 100)
  assert.ok(createLegendCharacterRows(input).every(row => row.previousCount === null && row.percentagePointDelta === null))
})

test('rejects unknown identity fields at every public object boundary', () => {
  const input = dataset()
  for (const key of ['name', 'playerId', 'cfnId', 'profile', 'accountKey', 'hash', 'storageState', 'entries']) {
    assert.throws(() => parseLegendAnalysisDataset({ ...input, [key]: 'private' }), /unknown field/)
    assert.throws(() => parseLegendAnalysisDataset({ ...input, source: { ...input.source, [key]: 'private' } }), /unknown field/)
    if (key !== 'name') assert.throws(() => parseLegendAnalysisDataset({ ...input, characters: input.characters.map(item => ({ ...item, [key]: 'private' })) }), /unknown field/)
  }
  assert.throws(() => parseLegendAnalysisDataset({ ...input, mr: { ...input.mr, rawMr: [2000] } }), /unknown field/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, mr: { ...input.mr, bins: input.mr.bins.map(bin => ({ ...bin, accountKey: 'hash' })) } }), /unknown field/)
  assert.throws(() => parseLegendAnalysisManifest({ ...manifest(), playerIds: [] }), /unknown field/)
  assert.throws(() => parseLegendAnalysisManifest(manifest([{ ...descriptor(), name: 'private' } as LegendAnalysisDescriptor])), /unknown field/)
})

test('metadata containers reject raw rows and nested identity objects rather than silently scrubbing them', () => {
  const input = dataset()
  assert.throws(() => parseLegendAnalysisDataset({ ...input, source: { ...input.source, notes: [{ cfnId: '123456' }] } }), /source.notes/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, validation: { ...input.validation, notes: [{ accountKey: 'private' }] } }), /validation.notes/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, validation: { ...input.validation, rows: [{ rank: 1, playerName: 'private' }] } }), /unknown field/)
  assert.throws(() => parseLegendAnalysisManifest({ ...manifest([]), availability: {
    status: 'collection-failed', checkedAt: '2026-10-20T00:00:00.000Z', message: { profileUrl: 'private' },
  } }), /availability.message/)
  assert.throws(() => parseLegendAnalysisManifest({ ...manifest([]), availability: {
    status: 'collection-failed', checkedAt: '2026-10-20T00:00:00.000Z', message: '取得失敗', error: { cookies: [] },
  } }), /unknown field/)
})

test('rejects incomplete rosters, unknown characters, missing MR, count disagreement and partial verification', () => {
  const input = dataset()
  assert.throws(() => parseLegendAnalysisDataset({ ...input, characters: input.characters.slice(1) }), /incomplete roster/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, characterIds: ['unknown'] }), /incomplete roster/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, characterIds: ['ehonda'] }), /incomplete roster/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, characterIds: [...input.characterIds, 'ryu'] }), /duplicate/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, totalCount: 2 }), /mismatch/)
  for (const mutate of [
    (value: LegendAnalysisDataset) => { value.characters[0].count++ },
    (value: LegendAnalysisDataset) => { value.characters[0].mr.min = null },
    (value: LegendAnalysisDataset) => { value.characters[2].mr.min = 0 },
    (value: LegendAnalysisDataset) => { value.mr.count++ },
    (value: LegendAnalysisDataset) => { value.validation.checks.pop() },
    (value: LegendAnalysisDataset) => { value.validation.notes = [] },
  ]) {
    const malformed = structuredClone(input)
    mutate(malformed)
    assert.throws(() => parseLegendAnalysisDataset(malformed))
  }
  assert.throws(() => parseLegendAnalysisDataset({ ...input, validation: { ...input.validation, coverage: 'partial' } }), /incomplete/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, source: { ...input.source, unit: 'person' } }), /source.unit/)
})

test('accepts a newly confirmed source character while rejecting unsafe labels, IDs and rows outside that roster', () => {
  const input = dataset('16', { arjun: [2183], ryu: [] })
  assert.deepEqual(parseLegendAnalysisDataset(input), input)
  for (const name of ['', 'https://example.com/profile', '<img src=x>', 'private@user', 'x'.repeat(65)]) {
    const malformed = structuredClone(input)
    malformed.characters[0].name = name
    assert.throws(() => parseLegendAnalysisDataset(malformed), /character.name/)
  }
  for (const characterId of ['../profile', 'player-id', '01234', 'UPPER', 'x'.repeat(41)]) {
    assert.throws(() => parseLegendAnalysisDataset({ ...input, characterIds: [characterId, 'ryu'] }), /characterId/)
  }
  assert.throws(() => parseLegendAnalysisDataset({ ...input, characterIds: ['ken', 'ryu'] }), /incomplete roster/)
})

test('rejects malformed or misleading MR histograms and summaries instead of inferring raw quantiles', () => {
  for (const mutate of [
    (value: LegendAnalysisDataset) => { value.mr.bins[0].upper++ },
    (value: LegendAnalysisDataset) => { value.mr.bins[0].count++ },
    (value: LegendAnalysisDataset) => { value.mr.bins.reverse() },
    (value: LegendAnalysisDataset) => { value.mr.median = 2100 },
    (value: LegendAnalysisDataset) => { value.mr.mean = 2090 },
    (value: LegendAnalysisDataset) => { value.mr.min = 1999 },
    (value: LegendAnalysisDataset) => { value.mr.bins[0].count = 0; value.mr.bins[1].count++ },
  ]) {
    const malformed = dataset()
    mutate(malformed)
    assert.throws(() => parseLegendAnalysisDataset(malformed))
  }
  const input = dataset('16', { ryu: [2000], ken: [2200], dhalsim: [] })
  input.mr = summarizeLegendMr([2000, 2250])
  assert.throws(() => parseLegendAnalysisDataset(input), /character histogram mismatch/)
})

test('validates source, canonical timestamps, safe paths and descriptor identity before use', () => {
  const input = dataset()
  for (const url of ['https://example.com/ranking/master', `${LEGEND_ANALYSIS_SOURCE.url}?page=1`, LEGEND_ANALYSIS_SOURCE.url.replace('master', 'league')]) {
    assert.throws(() => parseLegendAnalysisDataset({ ...input, source: { ...input.source, url } }), /source.url/)
  }
  for (const path of ['../capture.json', '/capture.json', 'nested/capture.json', 'Index.json', 'C:\\capture.json', 'https://example.com/a.json']) {
    assert.throws(() => parseLegendAnalysisDescriptor(descriptor(input, { path })), /path/)
  }
  assert.throws(() => parseLegendAnalysisDataset({ ...input, captureStartedAt: '2026-02-30T01:00:00.000Z' }), /captureStartedAt/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, captureStartedAt: input.generatedAt }), /reversed/)
  assert.throws(() => parseLegendAnalysisDataset({ ...input, generatedAt: input.captureStartedAt }), /before capture/)
  assert.throws(() => parseLegendAnalysisDataset(input, descriptor(input, { actId: '12' })), /一致しません/)
  assert.throws(() => parseLegendAnalysisManifest(manifest([descriptor(), descriptor()])), /duplicate/)
  assert.throws(() => parseLegendAnalysisManifest({ ...manifest(), generatedAt: input.captureStartedAt }), /before capture/)
})

test('previous selection finds the nearest earlier nonoverlapping capture with the same Act, conditions and definition', () => {
  const current = descriptor(dataset('19'))
  const valid = descriptor(dataset('17'))
  const candidates = [
    descriptor(dataset('18'), { actId: '12' }), descriptor(dataset('15')),
    descriptor(dataset('18'), { id: 'changed-users', path: 'changed-users.json', conditions: { ...current.conditions, users: 'other' },
      captureStartedAt: '2026-10-18T02:00:00.000Z', captureEndedAt: '2026-10-18T02:01:00.000Z' }),
    descriptor(dataset('18'), { id: 'changed-definition', path: 'changed-definition.json', definitionVersion: 'v2',
      captureStartedAt: '2026-10-18T03:00:00.000Z', captureEndedAt: '2026-10-18T03:01:00.000Z' }),
    valid, current, descriptor(dataset('20')),
  ]
  assert.deepEqual(findPreviousLegendAnalysisDescriptor(manifest(candidates), current), valid)
  assert.equal(findPreviousLegendAnalysisDescriptor(manifest([current]), current), null)
  const overlapping = descriptor(dataset('18'), { captureEndedAt: current.captureStartedAt })
  assert.equal(findPreviousLegendAnalysisDescriptor(manifest([overlapping, current]), current), null)
})

test('comparisons use each capture denominator and percentage-point differences, with absent roster rows left unknown', () => {
  const current = dataset('16', { ryu: [2000, 2050], ken: [2100], dhalsim: [] })
  const previous = dataset('15', { ryu: [2000], ken: [2050, 2100, 2200] })
  const rows = createLegendCharacterRows(current, previous)
  const ryu = rows.find(row => row.characterId === 'ryu')!
  assert.equal(ryu.countDelta, 1)
  assert.equal(ryu.previousPercent, 25)
  assert.equal(ryu.percentagePointDelta, 2 / 3 * 100 - 25)
  assert.equal(rows.find(row => row.characterId === 'dhalsim')!.previousCount, null)
  assert.equal(rows.find(row => row.characterId === 'dhalsim')!.percentagePointDelta, null)
  const empty = dataset('15', { ryu: [], ken: [], dhalsim: [] })
  assert.equal(createLegendCharacterRows(current, empty)[0].previousPercent, null)
  for (const prior of [
    { ...previous, act: { id: '12', label: 'Act 12' } },
    { ...previous, definitionVersion: 'v2' },
    { ...previous, membershipRule: 'official-ranking-cutoff' as const },
    { ...previous, conditions: { ...previous.conditions, platform: 'steam' } },
    { ...previous, captureEndedAt: current.captureStartedAt, generatedAt: current.generatedAt },
  ]) {
    assert.equal(legendAnalysisCanCompare(current, prior), false)
    assert.ok(createLegendCharacterRows(current, prior).every(row => row.previousCount === null && row.percentagePointDelta === null))
  }
})
