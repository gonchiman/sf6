import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { normalizeUsageRateSnapshots } from './usage-rate-snapshot.ts'
import { normalizeUsageRateSnapshotFile } from '../normalize-usage-rate-snapshots.ts'
import { USAGE_RATE_EDITION_LEAGUES, USAGE_RATE_EDITION_SOURCES } from '../../src/lib/usageRates.ts'
import type { UsageRateEdition } from '../../src/types/usageRates.ts'

const generatedAt = '2026-10-14T09:00:00Z'
const capturedAt = '2026-10-14T08:00:00Z'
const characters = { schemaVersion: 1, generatedAt, characters: [
  { id: 'ryu', name: 'リュウ', englishName: 'RYU', file: 'ryu.json' },
  { id: 'ken', name: 'ケン', englishName: 'KEN', file: 'ken.json' },
  { id: 'gouki_akuma', name: '豪鬼', englishName: 'AKUMA', file: 'gouki_akuma.json' },
  { id: 'vega_mbison', name: 'ベガ', englishName: 'M. BISON', file: 'vega_mbison.json' },
] }
function coverage(edition: UsageRateEdition, months = ['2026-09']) {
  return { edition, months, sourceUrl: USAGE_RATE_EDITION_SOURCES[edition].url }
}
function snapshot(edition: UsageRateEdition, controlType = 'all', month = '2026-09') {
  return {
    edition, month, controlType, capturedAt, sourceUrl: USAGE_RATE_EDITION_SOURCES[edition].url,
    leagues: USAGE_RATE_EDITION_LEAGUES[edition].map((league) => ({
      league: league.replaceAll('_', ' '), entries: [{ name: 'RYU', text: '50.000%' }, { name: 'KEN', text: '50.000' }],
    })),
  }
}
function fixture() {
  return { schemaVersion: 1, kind: 'buckler-usage-rate-snapshots', editions: [coverage('general'), coverage('master')],
    snapshots: [snapshot('general'), snapshot('general', 'classic'), snapshot('general', 'modern'), snapshot('master')] }
}

test('normalizes a complete mixed-edition bundle while preserving raw percent precision and distinct MASTER conditions', () => {
  const result = normalizeUsageRateSnapshots(fixture(), characters, generatedAt)
  assert.equal(result.datasets.length, 13)
  assert.equal(result.datasets.reduce((sum, item) => sum + item.distributions.length, 0), 31)
  const general = result.datasets.find((item) => item.id === '2026-09-master')!
  const master = result.datasets.find((item) => item.id === '2026-09-master-edition-master')!
  assert.equal(general.edition, undefined)
  assert.equal(master.edition, 'master')
  assert.equal(master.source.url, USAGE_RATE_EDITION_SOURCES.master.url)
  assert.equal(master.distributions.length, 1)
  assert.deepEqual(general.distributions[0].entries[0], { characterId: 'ryu', name: 'リュウ', text: '50.000', percentThousandths: 50000 })
})

test('keeps unlisted characters absent instead of inventing zero in differing control-type rosters', () => {
  const input = fixture()
  input.snapshots[2].leagues[8].entries = [{ name: 'RYU', text: '100.000' }]
  const general = normalizeUsageRateSnapshots(input, characters, generatedAt).datasets.find((item) => item.id === '2026-09-master')!
  assert.equal(general.distributions[0].entries.length, 2)
  assert.equal(general.distributions[2].entries.length, 1)
  assert.equal(general.distributions[2].entries.some((entry) => entry.characterId === 'ken'), false)
})

test('rejects missing months, views, ranks, duplicate conditions and out-of-coverage data', () => {
  const missingMonth = fixture(); missingMonth.editions[0].months.push('2026-08')
  const missingView = fixture(); missingView.snapshots.splice(2, 1)
  const missingRank = fixture(); missingRank.snapshots[0].leagues.pop()
  const duplicate = fixture(); duplicate.snapshots.push(snapshot('general'))
  const unknownCondition = fixture(); unknownCondition.snapshots[0].month = '2026-08'
  for (const input of [missingMonth, missingView, missingRank, duplicate, unknownCondition]) {
    assert.throws(() => normalizeUsageRateSnapshots(input, characters, generatedAt), /coverage|incomplete|duplicate/)
  }
})

test('rejects wrong sources, unsupported master controls, partial positive distributions and loading placeholders', () => {
  const wrongSource = fixture(); wrongSource.snapshots[3].sourceUrl = USAGE_RATE_EDITION_SOURCES.general.url
  const masterControl = fixture(); masterControl.snapshots[3].controlType = 'modern'
  const partial = fixture(); partial.snapshots[0].leagues[0].entries[0].text = '40.000'
  const loading = fixture(); loading.snapshots[0].leagues[0].entries.forEach((entry) => { entry.text = '-' })
  for (const input of [wrongSource, masterControl, partial, loading]) assert.throws(() => normalizeUsageRateSnapshots(input, characters, generatedAt))
})

test('uses exact registry names and explicit GOUKI/VEGA aliases, refusing guessed identities or delta text', () => {
  const input = fixture()
  input.snapshots[0].leagues[0].entries = [{ name: 'GOUKI', text: '50.000' }, { name: 'VEGA', text: '50.000' }]
  const entries = normalizeUsageRateSnapshots(input, characters, generatedAt).datasets.find((item) => item.id === '2026-09-all')!.distributions[0].entries
  assert.deepEqual(entries.map((item) => item.characterId), ['gouki_akuma', 'vega_mbison'])
  input.snapshots[0].leagues[0].entries[0].name = 'GOUKI?'
  assert.throws(() => normalizeUsageRateSnapshots(input, characters, generatedAt), /unknown official/)
  input.snapshots[0].leagues[0].entries[0] = { name: 'GOUKI', text: '50.000%1.0%' }
  assert.throws(() => normalizeUsageRateSnapshots(input, characters, generatedAt), /entry.text/)
})

test('rejects captures later than generation and records per-control capture times', () => {
  const input = fixture()
  input.snapshots[2].capturedAt = '2026-10-14T08:30:00Z'
  const result = normalizeUsageRateSnapshots(input, characters, generatedAt)
  assert.equal(result.datasets.find((item) => item.id === '2026-09-all')!.capturedAt, '2026-10-14T08:30:00Z')
  assert.ok(result.datasets[0].source.notes.some((note) => note.includes('MODERN: 2026-10-14T08:30:00Z')))
  input.snapshots[2].capturedAt = '2026-10-14T09:30:00Z'
  assert.throws(() => normalizeUsageRateSnapshots(input, characters, generatedAt), /capturedAt/)
})

test('validates dated acquisition URLs against the captured month and retains provenance', () => {
  const input = fixture()
  Object.assign(input.snapshots[0], { capturedPageUrl: `${USAGE_RATE_EDITION_SOURCES.general.url}/202609` })
  const result = normalizeUsageRateSnapshots(input, characters, generatedAt)
  assert.ok(result.datasets[0].source.notes.some((note) => note.includes('/usagerate/202609')))
  Object.assign(input.snapshots[0], { capturedPageUrl: `${USAGE_RATE_EDITION_SOURCES.general.url}/202608` })
  assert.throws(() => normalizeUsageRateSnapshots(input, characters, generatedAt), /selected month mismatch/)
})

test('preserves a separately verified 100.135% official sum and rejects the same mismatch without annotation', () => {
  const input = fixture()
  input.snapshots[0].leagues[8].entries[0].text = '50.135'
  assert.throws(() => normalizeUsageRateSnapshots(input, characters, generatedAt), /distribution.total/)
  const annotation = { observedPercentThousandths: 100135, verifiedAt: '2026-10-14T08:30:00Z',
    sourceUrl: `${USAGE_RATE_EDITION_SOURCES.general.url}/202609`, reason: '公式ページで同一条件を再表示し、全掲載値と合計を個別に確認。' }
  Object.assign(input.snapshots[0].leagues[8], { totalMismatch: annotation })
  const result = normalizeUsageRateSnapshots(input, characters, generatedAt)
  const value = result.datasets.find((item) => item.id === '2026-09-master')!
  assert.equal(value.distributions[0].entries[0].percentThousandths, 50135)
  assert.equal(value.distributions[0].entries[1].percentThousandths, 50000)
  assert.deepEqual(value.distributions[0].totalMismatch, annotation)
  assert.ok(value.source.notes.some((note) => note.includes('100.135%') && note.includes(annotation.reason)))
  Object.assign(input.snapshots[0].leagues[8], { totalMismatch: { ...annotation, observedPercentThousandths: 100134 } })
  assert.throws(() => normalizeUsageRateSnapshots(input, characters, generatedAt), /totalMismatch/)
})

test('combines separate edition exports in the CLI pipeline and rejects duplicate editions before writing', async (t) => {
  const parent = resolve('.cache', 'usage-snapshot-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'case-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixtureValue = fixture()
  const paths = []
  for (const edition of ['general', 'master']) {
    const path = join(root, `${edition}.json`)
    paths.push(path)
    await writeFile(path, JSON.stringify({ ...fixtureValue,
      editions: fixtureValue.editions.filter((item) => item.edition === edition),
      snapshots: fixtureValue.snapshots.filter((item) => item.edition === edition) }))
  }
  const output = join(root, 'normalized.json')
  assert.deepEqual(await normalizeUsageRateSnapshotFile(paths, output, generatedAt), { datasets: 13, distributions: 31, entries: 62 })
  assert.equal(JSON.parse(await readFile(output, 'utf8')).datasets.length, 13)
  const duplicateOutput = join(root, 'duplicate.json')
  await assert.rejects(normalizeUsageRateSnapshotFile([paths[0], paths[0]], duplicateOutput, generatedAt), /editions: duplicate/)
  await assert.rejects(readFile(duplicateOutput), { code: 'ENOENT' })
})
