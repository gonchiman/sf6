import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createTotalWinRateRows,
  formatTotalPercent,
  totalPercentHundredths,
  type TotalWinRateSort,
} from './totalWinRates.ts'
import type { WinRateDataset, WinRateFighter } from '../types/winRates.ts'

function dataset(): WinRateDataset {
  const fighters: WinRateFighter[] = [
    { id: 'ryu-classic', characterId: 'ryu', name: 'RYU', controlType: 'classic' },
    { id: 'ken-classic', characterId: 'ken', name: 'KEN', controlType: 'classic' },
    { id: 'ryu-modern', characterId: 'ryu', name: 'RYU', controlType: 'modern' },
    { id: 'luke-classic', characterId: 'luke', name: 'LUKE', controlType: 'classic' },
    { id: 'jamie-modern', characterId: 'jamie', name: 'JAMIE', controlType: 'modern' },
    { id: 'chunli-classic', characterId: 'chunli', name: 'CHUN-LI', controlType: 'classic' },
  ]
  const totals = ['-', '5.058', '5.058', '0.000', '-.---', '10.000']
  return {
    schemaVersion: 1,
    id: '2026-08-master-separate', month: '2026-08', league: 'MASTER', operationMode: 'separate',
    capturedAt: '2026-10-07T05:38:08.073Z', generatedAt: '2026-10-07T05:38:08.073Z',
    source: {
      url: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/dia',
      title: 'Buckler 総合版 対戦ダイアグラム', population: 'ランクマッチ', metric: '公式掲載値', notes: [],
    },
    fighters,
    rows: fighters.map((fighter, row) => ({
      fighterId: fighter.id,
      total: { text: totals[row], lowSample: row === 1 },
      cells: fighters.map((_, column) => ({ text: `${row}.${column}00`, lowSample: false })),
    })).reverse(),
  }
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
}

test('Total converts to exact two-decimal percentages at zero, the limits and the published precision', () => {
  for (const [text, hundredths, formatted] of [
    ['0.000', 0, '0.00%'],
    ['0.001', 1, '0.01%'],
    ['0.010', 10, '0.10%'],
    ['1.001', 1001, '10.01%'],
    ['4.928', 4928, '49.28%'],
    ['5.000', 5000, '50.00%'],
    ['5.058', 5058, '50.58%'],
    ['9.999', 9999, '99.99%'],
    ['10.000', 10000, '100.00%'],
  ] as const) {
    assert.equal(totalPercentHundredths(text), hundredths)
    assert.equal(formatTotalPercent(text), formatted)
  }
})

test('both official missing markers stay missing and preserve their original display', () => {
  for (const text of ['-', '-.---']) {
    assert.equal(totalPercentHundredths(text), null)
    assert.equal(formatTotalPercent(text), text)
  }
  assert.notEqual(totalPercentHundredths('0.000'), null)
})

test('unsupported precision and invalid values cannot silently become zero or missing', () => {
  for (const text of ['', 'NaN', '0', '5.05', '5.0581', '10.001', '-1.000', '50.000', ' 5.058', '5.058%']) {
    assert.throws(() => totalPercentHundredths(text), /数値形式/)
    assert.throws(() => formatTotalPercent(text), /数値形式/)
  }
})

test('official order uses fighters and joins Total by fighter ID even when rows are reversed', () => {
  const input = dataset()
  const result = createTotalWinRateRows(input, 'official')
  assert.deepEqual(result.map(({ fighter }) => fighter.id), input.fighters.map((fighter) => fighter.id))
  assert.deepEqual(result.map(({ total }) => total.text), ['-', '5.058', '5.058', '0.000', '-.---', '10.000'])
  assert.equal(result[0].fighter.controlType, 'classic')
  assert.equal(result[2].fighter.controlType, 'modern')
  for (const entry of result) {
    assert.strictEqual(entry.total, input.rows.find((row) => row.fighterId === entry.fighter.id)!.total)
  }
})

test('numeric sorting keeps ties in official order and both missing markers last in either direction', () => {
  const input = dataset()
  assert.deepEqual(createTotalWinRateRows(input, 'ascending').map(({ fighter }) => fighter.id), [
    'luke-classic', 'ken-classic', 'ryu-modern', 'chunli-classic', 'ryu-classic', 'jamie-modern',
  ])
  assert.deepEqual(createTotalWinRateRows(input, 'descending').map(({ fighter }) => fighter.id), [
    'chunli-classic', 'ken-classic', 'ryu-modern', 'luke-classic', 'ryu-classic', 'jamie-modern',
  ])
})

test('changing Total order never mutates fighter order, row order, matchup cells or metadata', () => {
  const input = dataset()
  const snapshot = structuredClone(input)
  deepFreeze(input)
  for (const sort of ['ascending', 'descending', 'official'] as TotalWinRateSort[]) {
    const rows = createTotalWinRateRows(input, sort)
    rows.reverse()
    assert.deepEqual(input, snapshot)
  }
})
