import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeBucklerSnapshot } from './buckler-snapshot.ts'

const capturedAt = '2026-10-08T03:07:41.477Z'
const generatedAt = '2026-10-08T04:00:00.000Z'
type ControlType = 'classic' | 'modern' | null
type Cell = { text: string; lowSample: boolean }
type Identity = { characterId: string; controlType: ControlType }
type Snapshot = {
  edition?: string
  snapshotVersion: number; sourceUrl: string; month: string; league: string; operationMode: string
  order: string; readyCharacterCount: number; capturedAt: string; columns: Identity[]
  rows: (Identity & { name: string; total: Cell; cells: Cell[] })[]
}
const cell = (text: string, lowSample = false): Cell => ({ text, lowSample })

function snapshot(): Snapshot {
  return {
    snapshotVersion: 1,
    sourceUrl: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/dia',
    month: '2026-08', league: 'MASTER', operationMode: 'combined', order: 'character',
    readyCharacterCount: 2, capturedAt,
    columns: [{ characterId: 'ryu', controlType: null }, { characterId: 'ken', controlType: null }],
    rows: [
      { characterId: 'ryu', controlType: null, name: 'RYU', total: cell('5.058'), cells: [cell('-'), cell('0.000', true)] },
      { characterId: 'ken', controlType: null, name: 'KEN', total: cell('10.000', true), cells: [cell('10.000'), cell('-.---')] },
    ],
  }
}

function separateSnapshot(): Snapshot {
  const input = snapshot()
  input.operationMode = 'separate'
  input.columns = [{ characterId: 'ryu', controlType: 'modern' }, { characterId: 'ryu', controlType: 'classic' }]
  input.rows[0] = { ...input.rows[0], characterId: 'ryu', controlType: 'classic' }
  input.rows[1] = { ...input.rows[1], characterId: 'ryu', controlType: 'modern', name: 'RYU' }
  return input
}

test('published Total, missing markers, true zero and sample flags are preserved without recomputation', () => {
  const input = snapshot()
  const original = structuredClone(input)
  const result = normalizeBucklerSnapshot(input, '2026-08', generatedAt)
  assert.equal(result.id, '2026-08-master-combined')
  assert.equal(result.capturedAt, capturedAt)
  assert.equal(result.generatedAt, generatedAt)
  assert.equal(result.source.url, input.sourceUrl)
  assert.deepEqual(result.rows.map(({ total, cells }) => ({ total, cells })), input.rows.map(({ total, cells }) => ({ total, cells })))
  assert.deepEqual(input, original)
  result.rows[0].cells[1].text = '5.000'
  assert.equal(input.rows[0].cells[1].text, '0.000')
})

test('column order is retained and row names and values follow stable identities', () => {
  const input = snapshot()
  input.columns.reverse()
  for (const row of input.rows) row.cells.reverse()
  const result = normalizeBucklerSnapshot(input)
  assert.deepEqual(result.fighters.map(({ id, name }) => ({ id, name })), [{ id: 'ken', name: 'KEN' }, { id: 'ryu', name: 'RYU' }])
  assert.deepEqual(result.rows.map((row) => row.fighterId), ['ken', 'ryu'])
  assert.deepEqual(result.rows[0].cells, [cell('-.---'), cell('10.000')])
  assert.equal(result.rows[0].total.text, '10.000')
})

test('separate controls are distinct identities, require both controls, and use the official column order', () => {
  const result = normalizeBucklerSnapshot(separateSnapshot())
  assert.equal(result.operationMode, 'separate')
  assert.deepEqual(result.fighters.map((fighter) => fighter.id), ['ryu-modern', 'ryu-classic'])
  assert.deepEqual(result.rows.map((row) => row.total.text), ['10.000', '5.058'])
  const missingControl = separateSnapshot()
  missingControl.columns[1].characterId = 'ken'
  missingControl.rows[0].characterId = 'ken'
  assert.throws(() => normalizeBucklerSnapshot(missingControl), /both control types/)
  for (const input of [snapshot(), separateSnapshot()]) {
    input.operationMode = input.operationMode === 'combined' ? 'separate' : 'combined'
    assert.throws(() => normalizeBucklerSnapshot(input), /controlType/)
  }
})

test('the selected month, known conditions, source and completed table state are required', () => {
  assert.throws(() => normalizeBucklerSnapshot(snapshot(), '2026-07'), /month/)
  assert.throws(() => normalizeBucklerSnapshot(snapshot(), '2026-13'), /expectedMonth/)
  const changes: ((input: Snapshot) => void)[] = [
    (input) => { input.snapshotVersion = 2 },
    (input) => { input.sourceUrl = 'https://example.com/stats/dia' },
    (input) => { input.month = '2026-13' },
    (input) => { input.league = 'UNKNOWN' },
    (input) => { input.operationMode = 'unknown' },
    (input) => { input.order = 'win-rate' },
    (input) => { input.readyCharacterCount = 0 },
    (input) => { input.readyCharacterCount = 2.5 },
    (input) => { input.readyCharacterCount = 3 },
    (input) => { input.capturedAt = '2026-02-30T00:00:00Z' },
  ]
  for (const change of changes) {
    const input = snapshot()
    change(input)
    assert.throws(() => normalizeBucklerSnapshot(input), /形式/)
  }
  assert.throws(() => normalizeBucklerSnapshot(snapshot(), undefined, 'invalid date'), /generatedAt/)
})

test('duplicate or unknown identities and incomplete matrices are rejected', () => {
  const changes: ((input: Snapshot) => void)[] = [
    (input) => { input.columns[1] = { ...input.columns[0] } },
    (input) => { input.rows[1] = structuredClone(input.rows[0]) },
    (input) => { input.rows[0].characterId = 'unknown' },
    (input) => { input.rows.pop() },
    (input) => { input.rows[0].cells.pop() },
    (input) => { input.rows[0].cells.push(cell('5.000')) },
    (input) => { input.rows[0].name = '' },
  ]
  for (const change of changes) {
    const input = snapshot()
    change(input)
    assert.throws(() => normalizeBucklerSnapshot(input), /形式/)
  }
})

test('all-missing loading tables are rejected while numeric zero is sufficient evidence', () => {
  const input = snapshot()
  for (const row of input.rows) {
    row.total = cell('-.---')
    row.cells = row.cells.map(() => cell('-'))
  }
  assert.throws(() => normalizeBucklerSnapshot(input), /no numeric values/)
  input.rows[0].total = cell('0.000')
  assert.equal(normalizeBucklerSnapshot(input).rows[0].total.text, '0.000')
})

test('invalid numbers and absent low-sample flags are rejected rather than repaired', () => {
  for (const text of ['', '0', '5.00', '10.001', '50.000', 'NaN', ' 5.000']) {
    const input = snapshot()
    input.rows[0].total.text = text
    assert.throws(() => normalizeBucklerSnapshot(input), /text/)
  }
  const input = snapshot() as unknown as { rows: { cells: Record<string, unknown>[] }[] }
  delete input.rows[0].cells[0].lowSample
  assert.throws(() => normalizeBucklerSnapshot(input), /lowSample/)
})

test('マスター版は出典から判別し、4リーグの合算を別IDで保持する', () => {
  for (const league of ['MASTER', 'HIGH_MASTER', 'GRAND_MASTER', 'ULTIMATE_MASTER']) {
    const input = snapshot()
    input.sourceUrl += '_master'
    input.league = league
    const result = normalizeBucklerSnapshot(input, input.month, generatedAt)
    assert.equal(result.edition, 'master')
    assert.equal(result.id, `2026-08-master-edition-${league.toLowerCase()}-combined`)
    assert.equal(result.source.url, input.sourceUrl)
    assert.match(result.source.title, /マスター版/)
    assert.deepEqual(result.rows.map(({ total, cells }) => ({ total, cells })), input.rows.map(({ total, cells }) => ({ total, cells })))
  }
  assert.equal(Object.hasOwn(normalizeBucklerSnapshot(snapshot()), 'edition'), false)
})

test('マスター版の別操作タイプ・提供前月・版と出典の不一致を拒否する', () => {
  const wrongMode = separateSnapshot()
  wrongMode.sourceUrl += '_master'
  assert.throws(() => normalizeBucklerSnapshot(wrongMode), /operationMode/)
  const wrongLeague = snapshot()
  wrongLeague.sourceUrl += '_master'
  wrongLeague.league = 'DIAMOND'
  assert.throws(() => normalizeBucklerSnapshot(wrongLeague), /league/)
  const tooEarly = snapshot()
  tooEarly.sourceUrl += '_master'
  tooEarly.month = '2025-01'
  assert.throws(() => normalizeBucklerSnapshot(tooEarly), /month/)
  for (const edition of ['master', 'unknown']) {
    const mismatch = snapshot()
    mismatch.edition = edition
    assert.throws(() => normalizeBucklerSnapshot(mismatch), /edition/)
  }
  const mismatch = snapshot()
  mismatch.sourceUrl += '_master'
  mismatch.edition = 'general'
  assert.throws(() => normalizeBucklerSnapshot(mismatch), /edition/)
})
