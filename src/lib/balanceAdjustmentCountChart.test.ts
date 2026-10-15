import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { balanceAdjustmentCountAxis, balanceAdjustmentCountStateLabel, buildBalanceAdjustmentCountRows } from './balanceAdjustmentCountChart.ts'
import { parseBalanceAdjustmentDetails } from './balanceAdjustmentDetails.ts'
import { parseBalanceAdjustmentCatalog } from './balanceAdjustments.ts'
import {
  balanceAdjustmentCategoryOptions, countBalanceAdjustmentChanges, filterBalanceAdjustmentChanges,
} from './balanceAdjustmentCategories.ts'
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

test('分類は原文完全一致のORとし、複合・強調・取消線を分割せず重複選択でも二重に数えない', () => {
  const input = [
    change(), change({ id: '2', categoryLabel: '不具合修正' }), change({ id: '3', categoryLabel: '調整・不具合修正' }),
    change({ id: '4', categoryLabel: '調整（強調）' }), change({ id: '5', categoryLabel: '共通調整（取消線）' }),
  ]
  const before = structuredClone(input)
  const filter = { mode: 'selected' as const, keys: ['調整', '不具合修正', '調整'] }
  assert.deepEqual(countBalanceAdjustmentChanges(input, filter), { itemCount: 2, status: 'ready' })
  const selected = filterBalanceAdjustmentChanges(input, filter)
  assert.deepEqual(selected, input.slice(0, 2))
  assert.strictEqual(selected[0], input[0])
  assert.deepEqual(countBalanceAdjustmentChanges(input, { mode: 'selected', keys: ['調整・不具合修正'] }), { itemCount: 1, status: 'ready' })
  assert.deepEqual(countBalanceAdjustmentChanges(input, { mode: 'selected', keys: ['調整（強調）', '共通調整（取消線）'] }), { itemCount: 2, status: 'ready' })
  assert.deepEqual(input, before)
})

test('分類記載なしを名前付き分類の0にせず、空欄を明示選択すればその原文行を数える', () => {
  const mixed = [change(), change({ id: 'blank', categoryLabel: '' })]
  assert.deepEqual(countBalanceAdjustmentChanges(mixed, { mode: 'selected', keys: ['調整'] }), { itemCount: null, status: 'category-unlisted' })
  assert.deepEqual(countBalanceAdjustmentChanges(mixed), { itemCount: 2, status: 'ready' })
  assert.deepEqual(countBalanceAdjustmentChanges(mixed, { mode: 'selected', keys: [''] }), { itemCount: 1, status: 'ready' })
  assert.deepEqual(countBalanceAdjustmentChanges(mixed, { mode: 'selected', keys: ['調整', ''] }), { itemCount: 2, status: 'ready' })
  assert.deepEqual(countBalanceAdjustmentChanges([change()], { mode: 'selected', keys: ['不具合修正'] }), { itemCount: 0, status: 'ready' })
  assert.deepEqual(countBalanceAdjustmentChanges([], { mode: 'selected', keys: ['調整'] }), { itemCount: 0, status: 'ready' })
})

test('空選択は未選択として保持し、未取込・未掲載状態を上書きしない', () => {
  const empty = { mode: 'selected' as const, keys: [] }
  assert.deepEqual(countBalanceAdjustmentChanges([], empty), { itemCount: null, status: 'no-category-selected' })
  assert.deepEqual(countBalanceAdjustmentChanges([change()], empty), { itemCount: null, status: 'no-category-selected' })
  assert.equal(buildBalanceAdjustmentCountRows([event()], details(), 'all', empty)[0].status, 'no-category-selected')
  assert.equal(buildBalanceAdjustmentCountRows([event()], null, 'all', empty)[0].status, 'unimported')
  const input = details([patch({ characters: [character({ status: 'unlisted', source: null, changes: [], policy: '' })] })])
  assert.equal(buildBalanceAdjustmentCountRows([event()], input, 'ryu', empty)[0].status, 'unlisted')
  assert.equal(buildBalanceAdjustmentCountRows([event()], input, 'missing', empty)[0].status, 'unimported')
  assert.deepEqual(['ready', 'unimported', 'unlisted', 'category-unlisted', 'no-category-selected'].map((status) =>
    balanceAdjustmentCountStateLabel(status as Parameters<typeof balanceAdjustmentCountStateLabel>[0])),
  ['', '未取込', '未掲載', '分類記載なし', '分類未選択'])
})

test('分類判定は選択キャラの行だけに行い、対象外の共通・他キャラの空欄を混ぜない', () => {
  const selected = { mode: 'selected' as const, keys: ['調整'] }
  const input = details([patch({ characters: [character(), character({ characterId: 'ken', changes: [change({ categoryLabel: '' })] })] })])
  assert.equal(buildBalanceAdjustmentCountRows([event()], input, 'all', selected)[0].status, 'category-unlisted')
  assert.equal(buildBalanceAdjustmentCountRows([event()], input, 'ryu', selected)[0].itemCount, 1)
  assert.equal(buildBalanceAdjustmentCountRows([event()], input, 'ken', selected)[0].status, 'category-unlisted')
})

test('全詳細から9原文分類を基本・派生・空欄の固定順で作り、既存全件集計と明示全選択が一致する', async () => {
  const history = parseBalanceAdjustmentCatalog(JSON.parse(await readFile(new URL('../../public/data/balance-adjustments.json', import.meta.url), 'utf8')))
  const catalog = parseBalanceAdjustmentDetails(JSON.parse(await readFile(new URL('../../public/data/balance-adjustment-details.json', import.meta.url), 'utf8')), history)
  const options = balanceAdjustmentCategoryOptions(catalog)
  assert.deepEqual(options.map((option) => option.key), [
    '調整', '不具合修正', '調整・不具合修正', '共通調整', '調整（強調）', '不具合修正（強調）',
    '調整・不具合修正（強調）', '共通調整（取消線）', '',
  ])
  assert.equal(options.at(-1)?.label, '分類記載なし')
  assert.deepEqual(balanceAdjustmentCategoryOptions(null), [])
  assert.deepEqual(buildBalanceAdjustmentCountRows(history.events, catalog, 'all', { mode: 'selected', keys: options.map((option) => option.key) }),
    buildBalanceAdjustmentCountRows(history.events, catalog))
  const august = history.events.filter((item) => item.id === 'battle-change-20260803')
  for (const [filter, expected] of [
    [{ mode: 'all' }, 242], [{ mode: 'selected', keys: ['調整'] }, 234],
    [{ mode: 'selected', keys: ['調整', '調整・不具合修正'] }, 236],
    [{ mode: 'selected', keys: ['不具合修正'] }, 6],
  ] as const) {
    assert.equal(buildBalanceAdjustmentCountRows(august, catalog, 'all', filter)[0].itemCount, expected)
  }
  const uncategorized = history.events.filter((item) => item.id === 'battle-change-20230724')
  assert.equal(buildBalanceAdjustmentCountRows(uncategorized, catalog)[0].itemCount, 41)
  assert.equal(buildBalanceAdjustmentCountRows(uncategorized, catalog, 'all', { mode: 'selected', keys: [''] })[0].itemCount, 41)
  const row = buildBalanceAdjustmentCountRows(uncategorized, catalog, 'all', { mode: 'selected', keys: ['調整'] })[0]
  assert.equal(row.itemCount, null)
  assert.equal(row.status, 'category-unlisted')
  assert.deepEqual(balanceAdjustmentCountAxis([row]), { maximum: 1, ticks: [0, 1] })
})

test('未経験の公式分類も独立選択肢として保持し、選択肢順を入力版の順序で変えない', () => {
  const first = patch({ common: { policy: '', changes: [change({ categoryLabel: '未知の分類B' })] }, characters: [] })
  const second = patch({ adjustmentId: 'second', common: { policy: '', changes: [change({ categoryLabel: '未知の分類A' }), change({ categoryLabel: '' })] }, characters: [] })
  const options = balanceAdjustmentCategoryOptions(details([first, second]))
  assert.deepEqual(options, [
    { key: '未知の分類A', label: '未知の分類A' }, { key: '未知の分類B', label: '未知の分類B' }, { key: '', label: '分類記載なし' },
  ])
  assert.deepEqual(balanceAdjustmentCategoryOptions(details([second, first])), options)
})
