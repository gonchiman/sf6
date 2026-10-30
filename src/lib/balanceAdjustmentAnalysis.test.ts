import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ADJUSTMENT_ANALYSIS_CATEGORIES, analyzeBalanceAdjustmentPatch, filterAdjustmentAnalysisRows } from './balanceAdjustmentAnalysis.ts'
import type { BalanceAdjustmentDetailsCatalog, BalanceAdjustmentPatchDetails } from '../types/balanceAdjustmentDetails.ts'

const source = { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260803', title: '公式' }

function patch(descriptions: string[]): BalanceAdjustmentPatchDetails {
  return {
    adjustmentId: 'test-patch', date: '2026-08-03', capturedAt: '2026-10-14T00:00:00Z', source,
    common: { policy: '', changes: [] },
    characters: [{ characterId: 'luke', name: 'ルーク', status: 'ready', source, policy: '',
      changes: descriptions.map((description, index) => ({ id: `change-${index}`, target: '技', categoryLabel: '調整', description })) }],
  }
}

function rows(description: string) { return analyzeBalanceAdjustmentPatch(patch([description])).rows }
function values(description: string) {
  return rows(description).map(row => ({ category: row.categoryId, direction: row.direction,
    before: row.beforeValue, after: row.afterValue, delta: row.deltaValue }))
}

test('明示された前後のスカラー値から同じ単位の差分を求める', () => {
  assert.deepEqual(values('攻撃発生を9F⇒8Fに変更しました。'), [
    { category: 'startup', direction: '減少', before: '9F', after: '8F', delta: '-1F' },
  ])
  assert.deepEqual(values('ガード時の硬直差を-5F⇒-4Fに変更しました。'), [
    { category: 'frame-advantage', direction: '増加', before: '-5F', after: '-4F', delta: '+1F' },
  ])
  assert.deepEqual(values('ダメージを800⇒900に変更しました。'), [
    { category: 'damage', direction: '増加', before: '800', after: '900', delta: '+100' },
  ])
})

test('増減量だけの記述から絶対的な変更前後を復元しない', () => {
  assert.deepEqual(values('攻撃持続を1F増加しました。'), [
    { category: 'active', direction: '増加', before: null, after: null, delta: '+1F' },
  ])
  assert.deepEqual(values('硬直を3F減少しました。'), [
    { category: 'recovery', direction: '減少', before: null, after: null, delta: '-3F' },
  ])
})

test('範囲値は範囲のまま保持し単一の数値へ短絡しない', () => {
  assert.deepEqual(values('空中攻撃無敵を5F～8F⇒3F～11Fに変更しました。'), [
    { category: 'invincibility', direction: '変更', before: '5F～8F', after: '3F～11F', delta: null },
  ])
})

test('変更後だけが明示された場合と割合の差を区別する', () => {
  assert.deepEqual(values('硬直を15Fに変更しました。'), [
    { category: 'recovery', direction: '変更', before: null, after: '15F', delta: null },
  ])
  assert.deepEqual(values('コンボ補正を80%⇒90%に変更しました。'), [
    { category: 'damage', direction: '増加', before: '80%', after: '90%', delta: '+10pt' },
  ])
})

test('単位が異なる値や複数の前後値から一つの差分を作らない', () => {
  assert.equal(rows('硬直を10F⇒1秒に変更しました。')[0].deltaValue, null)
  const multiple = rows('ダメージを800⇒900、削りダメージを100⇒110に変更しました。')
  assert.equal(multiple[0].beforeValue, null)
  assert.equal(multiple[0].afterValue, null)
  assert.equal(multiple[0].deltaValue, null)
})

test('合計・多段ヒット・括弧付きの式から一部の数値だけを取り出さない', () => {
  for (const description of [
    'ダメージを200+25⇒100+100に変更しました。',
    'ダメージを1250×2⇒1000×2に変更しました。',
    'ダメージを200(100+100)⇒300(100+200)に変更しました。',
    'ダメージを200-25⇒100-10に変更しました。',
  ]) {
    const result = rows(description)[0]
    assert.equal(result.beforeValue, null, description)
    assert.equal(result.afterValue, null, description)
    assert.equal(result.deltaValue, null, description)
  }
})

test('非番号の並列句を分解し増減量と定性的な変更を保持する', () => {
  const description = '攻撃持続を1F増加し、リーチを拡大しました。'
  const result = rows(description)
  assert.deepEqual(result.map(row => [row.categoryId, row.elementLabel, row.direction, row.deltaValue]), [
    ['active', '攻撃持続', '増加', '+1F'], ['hitbox', 'リーチ', '拡大', null],
  ])
  assert.deepEqual(result.map(row => description.slice(row.evidence.start, row.evidence.end)), [
    '攻撃持続を1F増加し、', 'リーチを拡大しました。',
  ])
  assert.equal(analyzeBalanceAdjustmentPatch(patch([description])).sourceRowCount, 1)
})

test('同じ述語に接続されたヒットバックとガードバックを各要素として分解する', () => {
  for (const description of ['ヒットバック/ガードバックを縮小しました。', 'ヒット/ガードバックを縮小しました。']) {
    const result = rows(description)
    assert.deepEqual(result.map(row => row.elementLabel), ['ヒットバック', 'ガードバック'])
    assert.ok(result.every(row => row.categoryId === 'pushback' && row.direction === '縮小'))
    assert.equal(new Set(result.map(row => row.id)).size, 2)
  }
})

test('番号付きの複数記述を分け条件を隣の変更へ引き継がない', () => {
  const description = '1. ガード時の硬直差を-4F⇒-3Fに変更しました。\n2. ガードバックを縮小しました。\n3. バーンアウト時のガードバックを拡大しました。\n4. 攻撃持続終了から硬直終了まで移動量を縮小しました。'
  const result = rows(description)
  assert.deepEqual(result.map(row => row.categoryId), ['frame-advantage', 'pushback', 'pushback', 'movement'])
  assert.equal(result[0].condition, 'ガード時')
  assert.equal(result[1].condition, null)
  assert.equal(result[2].condition, 'バーンアウト時')
  assert.ok(result[3].elementLabel === '移動量')
  const circled = rows('①攻撃発生を8F⇒7Fに変更しました。②ダメージを800⇒900に変更しました。')
  assert.deepEqual(circled.map(row => row.categoryId), ['startup', 'damage'])
})

test('条件や比較で登場する別の要素を追加の変更にしない', () => {
  assert.deepEqual(rows('ガード待機判定を攻撃判定と同じ長さに拡大しました。').map(row => row.elementLabel), ['ガード待機判定'])
  assert.deepEqual(rows('攻撃持続3F目以降の、コンボ中の相手にのみヒットする攻撃判定を内側に拡大しました。').map(row => row.elementLabel), ['攻撃判定'])
  assert.deepEqual(rows('ガード待機判定の発生を18F⇒13Fに変更しました。').map(row => row.elementLabel), ['ガード待機判定の発生'])
})

test('修正前の不具合の状態を減少や削除という変更と誤認しない', () => {
  const descriptions = [
    'ホールド版に派生時、通常時よりも硬直が1F短くなっていたのを修正しました。',
    'ガード待機判定が攻撃判定よりも短くなっていた現象を修正しました。',
    '空中での硬直時間が増加していた不具合を修正しました。',
    'ダメージが入らないことがある不具合を修正しました。',
  ]
  for (const description of descriptions) {
    assert.ok(rows(description).every(row => row.status === 'unclassified' && row.direction === '不明' && row.deltaValue === null))
  }
  const compound = rows('①ホールド版に派生時、通常時よりも硬直が1F短くなっていたのを修正しました。\n②暗転解除後1Fのやられ判定を後方に拡大しました。')
  assert.deepEqual(compound.map(row => row.status), ['unclassified', 'candidate'])
  assert.equal(compound[1].categoryId, 'hurtbox')
})

test('未変更・意図しない状態・次回の修正を確定した変更候補にしない', () => {
  for (const description of [
    '前前入力、及びパリィドライブラッシュには変更ありません。',
    'ガード時の硬直差が-5F⇒-4Fに意図せず変更されてしまっております。',
    '次回アップデートでダメージを変更します。',
  ]) assert.ok(rows(description).every(row => row.status === 'unclassified'))
})

test('明確に分類できた句の後にある未解析の内容も残す', () => {
  const result = rows('攻撃発生を9F⇒8Fに変更し、独自の挙動を変更しました。')
  assert.deepEqual(result.map(row => row.status), ['candidate', 'unclassified'])
  assert.match(result[1].description.slice(result[1].evidence.start, result[1].evidence.end), /独自の挙動/)
})

test('原文の取消線が文境界をまたいでも旧記述を変更候補にしない', () => {
  const description = '【取消線】体部分のやられ判定を前方に拡大しました。\n足元のやられ判定を縮小しました。【/取消線】\n【強調】訂正：攻撃発生を9F⇒8Fに変更しました。【/強調】'
  const result = rows(description)
  assert.ok(result.filter(row => row.categoryId === 'hurtbox').length === 0)
  assert.ok(result.some(row => row.status === 'candidate' && row.categoryId === 'startup'))
  assert.ok(result.filter(row => row.description.slice(row.evidence.start, row.evidence.end).includes('やられ判定')).every(row => row.status === 'unclassified'))
  const cancelled = patch(['キャンセルを追加しました。'])
  cancelled.characters[0].changes[0].categoryLabel = '共通調整（取消線）'
  assert.ok(analyzeBalanceAdjustmentPatch(cancelled).rows.every(row => row.status === 'unclassified'))
})

test('明示的な条件は原文の文字列で保持し、条件未抽出を無条件としない', () => {
  const result = rows('1～3段目がパニッシュカウンターした場合、最終段の吹き飛び時間を増加しました。')
  assert.equal(result[0].condition, '1～3段目がパニッシュカウンターした場合')
  assert.equal(rows('動作3F～8F目までのやられ判定を後方に縮小しました。')[0].condition, '動作3F～8F目まで')
  assert.equal(rows('ガードバックを縮小しました。')[0].condition, null)
})

test('空欄・未分類・公式分類と出典をそのまま保持する', () => {
  const fixture = patch(['', '未知の独自挙動を変更しました。', '攻撃発生を9F⇒8Fに変更しました。'])
  fixture.characters[0].changes[2].target = ''
  fixture.characters[0].changes[2].categoryLabel = ''
  fixture.characters[0].source = null
  const result = analyzeBalanceAdjustmentPatch(fixture)
  assert.equal(result.sourceRowCount, 3)
  assert.deepEqual(result.rows.map(row => row.status), ['unclassified', 'unclassified', 'candidate'])
  assert.equal(result.rows[0].evidence.start, 0)
  assert.equal(result.rows[0].evidence.end, 0)
  assert.equal(result.rows[2].target, '')
  assert.equal(result.rows[2].officialCategoryLabel, '')
  assert.deepEqual(result.rows[2].source, source)
})

test('共通と掲載済みキャラを対象にし、空・未掲載を変更のある状態へ補完しない', () => {
  const fixture = patch(['ガードバックを縮小しました。'])
  fixture.common.changes = [{ id: 'common-1', target: '共通', categoryLabel: '', description: '独自仕様を変更しました。' }]
  fixture.characters.push({ ...fixture.characters[0], characterId: 'ken', name: 'ケン', changes: [] })
  fixture.characters.push({ ...fixture.characters[0], characterId: 'unlisted', status: 'unlisted', changes: [] })
  const result = analyzeBalanceAdjustmentPatch(fixture)
  assert.equal(result.sourceRowCount, 2)
  assert.deepEqual(result.rows.map(row => row.subjectId), ['common', 'luke'])
  assert.equal(result.rows[0].subjectName, '共通')
  assert.deepEqual(analyzeBalanceAdjustmentPatch({ ...fixture, common: { policy: '', changes: [] }, characters: [] }), { rows: [], sourceRowCount: 0 })
})

test('キャラ・変更要素・分類状況の積集合で絞り込み、元の配列を変更しない', () => {
  const fixture = patch(['ガードバックを縮小しました。', '未知の内容です。'])
  fixture.common.changes = [{ id: 'common-1', target: '', categoryLabel: '', description: '攻撃発生を9F⇒8Fに変更しました。' }]
  const result = analyzeBalanceAdjustmentPatch(fixture)
  const original = [...result.rows]
  assert.equal(filterAdjustmentAnalysisRows(result.rows, { subjectId: 'all', categoryId: 'all', status: 'all' }).length, 3)
  assert.equal(filterAdjustmentAnalysisRows(result.rows, { subjectId: 'luke', categoryId: 'pushback', status: 'candidate' }).length, 1)
  assert.equal(filterAdjustmentAnalysisRows(result.rows, { subjectId: 'all', categoryId: 'unclassified', status: 'unclassified' }).length, 1)
  assert.equal(filterAdjustmentAnalysisRows(result.rows, { subjectId: 'luke', categoryId: 'startup', status: 'all' }).length, 0)
  assert.deepEqual(result.rows, original)
})

test('公開された全パッチの公式行を保持し、IDと根拠範囲を検証する', async () => {
  const data = JSON.parse(await readFile(new URL('../../public/data/balance-adjustment-details.json', import.meta.url), 'utf8')) as BalanceAdjustmentDetailsCatalog
  const before = JSON.stringify(data)
  const ids = new Set<string>()
  const validCategories = new Set(ADJUSTMENT_ANALYSIS_CATEGORIES.map(category => category.id))
  let sourceTotal = 0
  let candidateTotal = 0
  for (const fixture of data.patches) {
    const result = analyzeBalanceAdjustmentPatch(fixture)
    const sourceRows = [...fixture.common.changes, ...fixture.characters.filter(character => character.status === 'ready').flatMap(character => character.changes)]
    assert.equal(result.sourceRowCount, sourceRows.length)
    assert.equal(new Set(result.rows.map(row => row.sourceChangeId)).size, new Set(sourceRows.map(row => row.id)).size)
    for (const row of result.rows) {
      assert.ok(!ids.has(row.id), `duplicate ${row.id}`)
      ids.add(row.id)
      assert.ok(validCategories.has(row.categoryId))
      assert.ok(row.evidence.start >= 0 && row.evidence.end >= row.evidence.start && row.evidence.end <= row.description.length, row.id)
      if (row.status === 'candidate') {
        candidateTotal += 1
        assert.ok(row.description.slice(row.evidence.start, row.evidence.end).length > 0, row.id)
      }
      assert.ok(sourceRows.some(sourceRow => sourceRow.id === row.sourceChangeId && sourceRow.description === row.description), row.id)
    }
    for (const sourceRow of sourceRows) assert.ok(result.rows.some(row => row.sourceChangeId === sourceRow.id), sourceRow.id)
    sourceTotal += result.sourceRowCount
  }
  assert.ok(sourceTotal > 0)
  assert.ok(candidateTotal > 0)
  assert.equal(JSON.stringify(data), before)
  assert.equal(new Set(ADJUSTMENT_ANALYSIS_CATEGORIES.map(category => category.id)).size, ADJUSTMENT_ANALYSIS_CATEGORIES.length)
})
