import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildBalanceAdjustmentOverview } from './balanceAdjustmentOverview.ts'
import { parseBalanceAdjustmentDetails } from './balanceAdjustmentDetails.ts'
import type {
  BalanceAdjustmentChange, BalanceAdjustmentCharacterDetails, BalanceAdjustmentPatchDetails,
} from '../types/balanceAdjustmentDetails.ts'

function change(categoryLabel = '調整', overrides: Partial<BalanceAdjustmentChange> = {}): BalanceAdjustmentChange {
  return { id: 'change-1', target: '波動拳', categoryLabel, description: '変更しました。', ...overrides }
}

function character(overrides: Partial<BalanceAdjustmentCharacterDetails> = {}): BalanceAdjustmentCharacterDetails {
  return {
    characterId: 'ryu', name: 'リュウ', status: 'ready',
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260528/ryu', title: 'リュウ' },
    policy: '', changes: [change()], ...overrides,
  }
}

function patch(overrides: Partial<BalanceAdjustmentPatchDetails> = {}): BalanceAdjustmentPatchDetails {
  return {
    adjustmentId: 'battle-change-20260528', date: '2026-05-28', capturedAt: '2026-10-14T00:00:00Z',
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260528', title: 'バトル変更リスト' },
    common: { policy: '', changes: [] }, characters: [], ...overrides,
  }
}

async function publishedPatches(): Promise<BalanceAdjustmentPatchDetails[]> {
  const contents = await readFile(new URL('../../public/data/balance-adjustment-details.json', import.meta.url), 'utf8')
  return parseBalanceAdjustmentDetails(JSON.parse(contents)).patches
}

test('公式の複合・空・未知分類を分割も意味変換もせず、既知分類を先頭に出現順で列にする', () => {
  const result = buildBalanceAdjustmentOverview(patch({
    common: { policy: '', changes: [
      change('共通調整'), change(''), change('調整・不具合修正'), change('不具合修正'),
    ] },
    characters: [character({ changes: [change('その他'), change('調整'), change(' 調整 '), change('共通調整')] })],
  }))
  assert.deepEqual(result.categories, [
    { key: '調整', label: '調整' }, { key: '不具合修正', label: '不具合修正' },
    { key: '調整・不具合修正', label: '調整・不具合修正' }, { key: '共通調整', label: '共通調整' },
    { key: '', label: '—' }, { key: 'その他', label: 'その他' }, { key: ' 調整 ', label: ' 調整 ' },
  ])
  assert.deepEqual(result.rows, [
    { characterId: null, name: '共通', counts: [0, 1, 1, 1, 1, 0, 0], total: 4 },
    { characterId: 'ryu', name: 'リュウ', counts: [1, 0, 0, 1, 0, 1, 1], total: 4 },
  ])
  assert.deepEqual(result.totals, [1, 1, 1, 2, 1, 1, 1])
  assert.equal(result.total, 8)
})

test('共通を先頭、変更のある掲載済みキャラを元順で並べ、方針だけ・未掲載・空の変更を除外する', () => {
  const result = buildBalanceAdjustmentOverview(patch({
    common: { policy: '共通の方針', changes: [change()] },
    characters: [
      character({ characterId: 'ken', name: 'ケン', changes: [change(), change('不具合修正')] }),
      character({ characterId: 'empty', name: '変更なし', policy: '方針のみ', changes: [] }),
      character({ characterId: 'unlisted', name: '未掲載', status: 'unlisted', source: null, changes: [] }),
      character(),
    ],
  }))
  assert.deepEqual(result.rows.map(({ characterId, name, total }) => ({ characterId, name, total })), [
    { characterId: null, name: '共通', total: 1 },
    { characterId: 'ken', name: 'ケン', total: 2 },
    { characterId: 'ryu', name: 'リュウ', total: 1 },
  ])
  assert.equal(result.commonCount, 1)
  assert.equal(result.characterCount, 2)
  assert.equal(result.characterItemCount, 3)
  assert.equal(result.total, 4)
  assert.deepEqual(buildBalanceAdjustmentOverview(patch({ common: { policy: '方針だけ', changes: [] }, characters: [character()] })).rows.map((row) => row.characterId), ['ryu'])
})

test('同じ変更箇所の別行は各1件、本文中の①②など複数の変更は公式1行で1件に数える', () => {
  const result = buildBalanceAdjustmentOverview(patch({ characters: [character({ changes: [
    change('調整', { id: 'row-1', target: 'しゃがみ中P', description: '①攻撃持続を3F⇒4Fに変更しました。\n②硬直を14F⇒13Fに変更しました。' }),
    change('不具合修正', { id: 'row-2', target: 'しゃがみ中P', description: '特定条件での不具合を修正しました。' }),
  ] })] }))
  assert.deepEqual(result.rows[0].counts, [1, 1])
  assert.equal(result.rows[0].total, 2)
  assert.equal(result.total, 2)
})

test('変更がない場合は空の集計、単独分類の場合は存在する列だけを返す', () => {
  assert.deepEqual(buildBalanceAdjustmentOverview(patch({
    common: { policy: '方針のみ', changes: [] }, characters: [character({ changes: [], policy: '方針のみ' })],
  })), {
    categories: [], rows: [], totals: [], total: 0, commonCount: 0, characterCount: 0, characterItemCount: 0,
  })
  assert.deepEqual(buildBalanceAdjustmentOverview(patch({ characters: [character({ changes: [change('不具合修正')] })] })).categories, [
    { key: '不具合修正', label: '不具合修正' },
  ])
})

test('入力の配列・原文・分類を変更せず、結果の数値配列とも共有しない', () => {
  const input = patch({ common: { policy: '方針', changes: [change('不具合修正')] }, characters: [character()] })
  const before = structuredClone(input)
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') {
      Object.freeze(value)
      Object.values(value).forEach(freeze)
    }
  }
  freeze(input)
  const result = buildBalanceAdjustmentOverview(input)
  result.rows[0].counts[0] = 100
  result.categories[0].label = '変更後'
  assert.deepEqual(input, before)
  assert.deepEqual(buildBalanceAdjustmentOverview(input).totals, [1, 1])
})

test('2026/05/28の配信データは共通5項目・14キャラ18項目・合計23項目に一致する', async () => {
  const input = (await publishedPatches()).find((item) => item.adjustmentId === 'battle-change-20260528')
  assert.ok(input)
  const result = buildBalanceAdjustmentOverview(input)
  assert.deepEqual(result.categories.map(({ key }) => key), ['調整', '不具合修正', '調整・不具合修正'])
  assert.equal(result.commonCount, 5)
  assert.equal(result.characterCount, 14)
  assert.equal(result.characterItemCount, 18)
  assert.equal(result.total, 23)
  assert.deepEqual(result.totals, [7, 15, 1])
  assert.deepEqual(result.rows[0], { characterId: null, name: '共通', counts: [3, 1, 1], total: 5 })
  assert.deepEqual(result.rows.find((row) => row.characterId === 'ed')?.counts, [1, 1, 0])
  assert.deepEqual(result.rows.find((row) => row.characterId === 'alex')?.counts, [0, 4, 0])
})

test('配信済みの全調整で各セルが原文分類と対応し、行・列・全体の合計が一致する', async () => {
  for (const input of await publishedPatches()) {
    const result = buildBalanceAdjustmentOverview(input)
    for (const row of result.rows) {
      const changes = row.characterId === null ? input.common.changes
        : input.characters.find((item) => item.characterId === row.characterId)!.changes
      for (const [index, category] of result.categories.entries()) {
        assert.equal(row.counts[index], changes.filter((change) => change.categoryLabel === category.key).length, `${input.adjustmentId}/${row.name}/${category.label}`)
      }
      assert.equal(row.counts.reduce((sum, count) => sum + count, 0), row.total)
    }
    assert.deepEqual(result.totals, result.categories.map((_, index) => result.rows.reduce((sum, row) => sum + row.counts[index], 0)))
    assert.equal(result.rows.reduce((sum, row) => sum + row.total, 0), result.total)
    assert.equal(result.totals.reduce((sum, count) => sum + count, 0), result.total)
    assert.equal(result.commonCount + result.characterItemCount, result.total)
  }
})
