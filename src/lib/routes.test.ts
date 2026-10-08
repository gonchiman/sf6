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
