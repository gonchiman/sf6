import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { balanceAdjustmentCountAxis, buildBalanceAdjustmentCountRows } from './balanceAdjustmentCountChart.ts'
import { parseBalanceAdjustmentDetails } from './balanceAdjustmentDetails.ts'
import { parseBalanceAdjustmentCatalog } from './balanceAdjustments.ts'
import type { BalanceAdjustment } from '../types/balanceAdjustments.ts'
import type {
  BalanceAdjustmentChange, BalanceAdjustmentCharacterDetails, BalanceAdjustmentDetailsCatalog,
  BalanceAdjustmentPatchDetails,
} from '../types/balanceAdjustmentDetails.ts'

function event(overrides: Partial<BalanceAdjustment> = {}): BalanceAdjustment {
  return {
    id: 'battle-change-20260528', date: '2026-05-28', dateBasis: 'effective', kindLabel: 'キャラ調整・修正',
    title: 'バトル変更リスト', announcement: null,
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260528', title: 'バトル変更リスト' },
    ...overrides,
  }
}

function change(overrides: Partial<BalanceAdjustmentChange> = {}): BalanceAdjustmentChange {
  return { id: 'row-1', target: '波動拳', categoryLabel: '調整', description: '①発生を変更しました。\n②硬直を変更しました。', ...overrides }
}

function character(overrides: Partial<BalanceAdjustmentCharacterDetails> = {}): BalanceAdjustmentCharacterDetails {
  return {
    characterId: 'ryu', name: 'リュウ', status: 'ready',
    source: { url: `${event().source.url}/ryu`, title: 'リュウ' }, policy: '方針は項目数に含めません。',
    changes: [change(), change({ id: 'row-2', categoryLabel: '不具合修正' })], ...overrides,
  }
}

function patch(overrides: Partial<BalanceAdjustmentPatchDetails> = {}): BalanceAdjustmentPatchDetails {
  return {
    adjustmentId: event().id, date: event().date, source: event().source, capturedAt: '2026-10-14T00:00:00Z',
    common: { policy: '共通の方針', changes: [change({ id: 'common-1', categoryLabel: '' })] },
    characters: [character()], ...overrides,
  }
}

function details(patches: BalanceAdjustmentPatchDetails[] = [patch()]): BalanceAdjustmentDetailsCatalog {
  return { schemaVersion: 1, generatedAt: '2026-10-14T00:00:00Z', patches }
}

test('全キャラは共通とキャラ固有を合計し、同じ変更箇所の別行と複数番号のある公式1行を区別する', () => {
  const item = event()
  const input = details()
  const before = structuredClone(input)
  assert.deepEqual(buildBalanceAdjustmentCountRows([item], input), [{ event: item, itemCount: 3, status: 'ready' }])
  assert.equal(buildBalanceAdjustmentCountRows([item], input, 'ryu')[0].itemCount, 2)
  assert.equal(buildBalanceAdjustmentCountRows([item], input, 'missing-character')[0].itemCount, null)
  assert.deepEqual(input, before)
})

test('掲載済み0件・公式未掲載・キャラ未取込を区別し、キャラ指定に共通項目を加えない', () => {
  const input = details([patch({ characters: [
    character({ characterId: 'empty', changes: [] }),
    character({ characterId: 'unlisted', status: 'unlisted', source: null, policy: '', changes: [] }),
    character(),
  ] })])
  for (const [characterId, itemCount, status] of [
    ['ryu', 2, 'ready'], ['empty', 0, 'ready'], ['unlisted', null, 'unlisted'], ['missing', null, 'unimported'],
  ] as const) {
    const [row] = buildBalanceAdjustmentCountRows([event()], input, characterId)
    assert.equal(row.itemCount, itemCount)
    assert.equal(row.status, status)
  }
  const noChanges = details([patch({ common: { policy: '方針のみ', changes: [] }, characters: [character({ changes: [] })] })])
  assert.equal(buildBalanceAdjustmentCountRows([event()], noChanges)[0].itemCount, 0)
})

test('詳細なし・日付違い・出典違いは0件として描かず未取込を保持する', () => {
  for (const input of [null, details([]), details([patch({ date: '2026-05-29' })]),
    details([patch({ source: { ...event().source, url: `${event().source.url}/different` } })]),
  ]) {
    const [row] = buildBalanceAdjustmentCountRows([event()], input)
    assert.equal(row.status, 'unimported')
    assert.equal(row.itemCount, null)
  }
})

test('与えられたイベントのみを古い順・同日の安定ID順に並べ、原文・入力順・イベント参照を保持する', () => {
  const first = event({ id: 'same-b' })
  const second = event({ id: 'same-a' })
  const old = event({ id: 'old', date: '2025-01-01' })
  const events = [first, old, second]
  const catalog = details()
  const before = structuredClone({ events, catalog })
  const rows = buildBalanceAdjustmentCountRows(events, catalog)
  assert.deepEqual(rows.map((row) => row.event.id), ['old', 'same-a', 'same-b'])
  assert.strictEqual(rows[0].event, old)
  assert.strictEqual(rows[1].event, second)
  assert.deepEqual({ events, catalog }, before)
  assert.deepEqual(buildBalanceAdjustmentCountRows([], catalog), [])
})

test('件数軸は0始点の整数目盛で495件を覆い、少数件・全0・全欠測・空でも有効な幅を持つ', () => {
  const row = { event: event(), status: 'ready' as const, itemCount: 495 }
  assert.deepEqual(balanceAdjustmentCountAxis([row]), { maximum: 500, ticks: [0, 100, 200, 300, 400, 500] })
  assert.deepEqual(balanceAdjustmentCountAxis([{ ...row, itemCount: 3 }]), { maximum: 3, ticks: [0, 1, 2, 3] })
  for (const input of [[], [{ ...row, itemCount: 0 }], [{ ...row, status: 'unimported' as const, itemCount: null }]]) {
    assert.deepEqual(balanceAdjustmentCountAxis(input), { maximum: 1, ticks: [0, 1] })
  }
  for (const value of [1, 2, 4, 6, 17, 153, 1939]) {
    const axis = balanceAdjustmentCountAxis([{ ...row, itemCount: value }])
    assert.equal(axis.ticks[0], 0)
    assert.equal(axis.ticks.at(-1), axis.maximum)
    assert.ok(axis.maximum >= value)
    assert.ok(axis.ticks.every(Number.isInteger))
    assert.ok(axis.ticks.every((tick, index) => index === 0 || tick > axis.ticks[index - 1]))
  }
})

test('配信済み21版は合計1939公式行となり、2026/05/28の合計23とアレックス固有4を区別する', async () => {
  const history = parseBalanceAdjustmentCatalog(JSON.parse(await readFile(new URL('../../public/data/balance-adjustments.json', import.meta.url), 'utf8')))
  const catalog = parseBalanceAdjustmentDetails(JSON.parse(await readFile(new URL('../../public/data/balance-adjustment-details.json', import.meta.url), 'utf8')), history)
  const rows = buildBalanceAdjustmentCountRows(history.events, catalog)
  assert.equal(rows.length, 21)
  assert.ok(rows.every((row) => row.status === 'ready'))
  assert.equal(rows.reduce((sum, row) => sum + row.itemCount!, 0), 1939)
  assert.equal(rows.find((row) => row.event.id === 'battle-change-202405')?.itemCount, 495)
  assert.equal(rows.find((row) => row.event.id === 'battle-change-20260528')?.itemCount, 23)
  assert.equal(buildBalanceAdjustmentCountRows(history.events, catalog, 'alex').find((row) => row.event.id === 'battle-change-20260528')?.itemCount, 4)
})
