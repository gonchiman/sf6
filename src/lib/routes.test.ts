import assert from 'node:assert/strict'
import { test } from 'node:test'
import { characterHash, parseHashRoute } from './routes.ts'

test('既存の勝率URLとキャラ一覧・キャラ直接URLを読み取る', () => {
  for (const hash of ['', '#', '#win-rates', '#unknown']) {
    assert.deepEqual(parseHashRoute(hash), { page: 'win-rates' })
  }
  assert.deepEqual(parseHashRoute('#characters'), { page: 'characters', characterId: null })
  assert.deepEqual(parseHashRoute('#characters/'), { page: 'characters', characterId: null })
  assert.deepEqual(parseHashRoute(characterHash('gouki_akuma')), { page: 'characters', characterId: 'gouki_akuma' })
})

test('不明・壊れたキャラIDも選択ページで扱い、URL解析で落ちない', () => {
  assert.deepEqual(parseHashRoute('#characters/%'), { page: 'characters', characterId: '%' })
  assert.deepEqual(parseHashRoute('#characters/no-such-character'), { page: 'characters', characterId: 'no-such-character' })
  const id = '名前/複合'
  assert.deepEqual(parseHashRoute(characterHash(id)), { page: 'characters', characterId: id })
})

test('勝率推移の直接URLは既存ページと区別して読み取る', () => {
  assert.deepEqual(parseHashRoute('#win-rate-history'), { page: 'win-rate-history' })
  assert.deepEqual(parseHashRoute('#win-rate-history/'), { page: 'win-rate-history' })
  assert.deepEqual(parseHashRoute('#win-rate-history-invalid'), { page: 'win-rates' })
})

test('キャラ分類の直接URLを独立したページとして読み取る', () => {
  assert.deepEqual(parseHashRoute('#character-traits'), { page: 'character-traits' })
  assert.deepEqual(parseHashRoute('#character-traits/'), { page: 'character-traits' })
  assert.deepEqual(parseHashRoute('#character-traits/unknown'), { page: 'win-rates' })
})
