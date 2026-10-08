import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  characterMoveCategories, characterNumericValue, filterCharacterMoves,
  loadCharacterDataset, loadCharacterManifest, parseCharacterDataset,
  parseCharacterManifest, sortCharacterMoves,
} from './characters.ts'
import type { CharacterDataset, CharacterDescriptor, CharacterMove } from '../types/characters.ts'

const capturedAt = '2026-10-08T03:00:00.000Z'
const generatedAt = '2026-10-08T04:00:00.000Z'
const descriptor: CharacterDescriptor = { id: 'ryu', name: 'リュウ', englishName: 'RYU', file: 'ryu.json' }

function move(overrides: Partial<CharacterMove> = {}): CharacterMove {
  return {
    id: 'ryu-jab', controlType: 'classic', category: '通常技', name: '立ち弱P（ジャブ）', inputs: { classic: '弱P', modern: '' },
    startup: '4', active: '4-6', recovery: '7', onHit: '4', onBlock: '-1', cancel: 'C',
    damage: '300', comboScaling: '始動補正20%', driveGaugeGain: '250', driveGaugeLoss: '-500',
    punishCounterDriveLoss: '-2000', superGaugeGain: '300', properties: '上', notes: '連打キャンセル対応',
    ...overrides,
  }
}

function dataset(overrides: Partial<CharacterDataset> = {}): CharacterDataset {
  return {
    schemaVersion: 1, id: 'ryu', name: 'リュウ', englishName: 'RYU', health: 10000, capturedAt,
    gameVersion: null, source: { title: 'リュウ フレームデータ', url: 'https://www.streetfighter.com/6/ja-jp/character/ryu/frame' },
    moves: [move()], ...overrides,
  }
}

test('official blanks, range expressions, line breaks and unknown patch remain unchanged', () => {
  const input = dataset({ moves: [move({ startup: '4(6)', damage: '400×2', notes: '1行目\n2行目' })] })
  assert.deepEqual(parseCharacterDataset(input, descriptor), input)
  assert.deepEqual(parseCharacterManifest({ schemaVersion: 1, generatedAt, characters: [descriptor] }), { schemaVersion: 1, generatedAt, characters: [descriptor] })
  assert.equal(input.gameVersion, null)
  assert.equal(input.moves[0].inputs.modern, '')
})

test('manifest and dataset reject unsafe paths, duplicate identities and wrong characters', () => {
  for (const file of ['../ryu.json', '/ryu.json', 'https://example.com/ryu.json', 'index.json', 'other.json']) {
    assert.throws(() => parseCharacterManifest({ schemaVersion: 1, generatedAt, characters: [{ ...descriptor, file }] }), /形式/)
  }
  assert.throws(() => parseCharacterManifest({ schemaVersion: 1, generatedAt, characters: [descriptor, descriptor] }), /duplicate/)
  assert.throws(() => parseCharacterDataset(dataset({ moves: [move(), move()] })), /duplicate/)
  assert.throws(() => parseCharacterDataset(dataset(), { ...descriptor, name: 'ケン' }), /一致しません/)
  for (const url of ['https://example.com/6/ja-jp/character/ryu/frame', 'https://www.streetfighter.com/6/ja-jp/character/ken/frame', 'https://www.streetfighter.com/6/ja-jp/character/ryu/frame?redirect=evil']) {
    assert.throws(() => parseCharacterDataset(dataset({ source: { title: 'Source', url } })), /形式/)
  }
})

test('schema validation rejects absent raw cells, invalid health, calendar dates and empty datasets', () => {
  for (const change of [
    (input: CharacterDataset) => { delete (input.moves[0] as Partial<CharacterMove>).controlType },
    (input: CharacterDataset) => { delete (input.moves[0] as Partial<CharacterMove>).onBlock },
    (input: CharacterDataset) => { input.health = 0 },
    (input: CharacterDataset) => { input.health = NaN },
    (input: CharacterDataset) => { input.capturedAt = '2026-02-29T03:00:00Z' },
    (input: CharacterDataset) => { input.moves = [] },
  ]) {
    const input = dataset()
    change(input)
    assert.throws(() => parseCharacterDataset(input), /形式/)
  }
})

test('only unqualified numbers sort numerically; conditional and missing cells remain last and stable', () => {
  assert.equal(characterNumericValue('＋４Ｆ'), 4)
  assert.equal(characterNumericValue(' -1 F '), -1)
  assert.equal(characterNumericValue('0'), 0)
  for (const text of ['', '-', '—', '4-6', '4(6)', 'KD +22', '400×2', '3+2', 'until land', 'Infinity']) {
    assert.equal(characterNumericValue(text), null)
  }
  const moves = [move({ id: 'a', startup: '4' }), move({ id: 'b', startup: '0' }), move({ id: 'c', startup: '4' }), move({ id: 'd', startup: '4(6)' }), move({ id: 'e', startup: '' })]
  moves.forEach((entry) => { Object.freeze(entry.inputs); Object.freeze(entry) })
  Object.freeze(moves)
  assert.deepEqual(sortCharacterMoves(moves, { key: 'startup', direction: 'asc' }).map((entry) => entry.id), ['b', 'a', 'c', 'd', 'e'])
  assert.deepEqual(sortCharacterMoves(moves, { key: 'startup', direction: 'desc' }).map((entry) => entry.id), ['a', 'c', 'b', 'd', 'e'])
  assert.deepEqual(sortCharacterMoves(moves, null).map((entry) => entry.id), ['a', 'b', 'c', 'd', 'e'])
})

test('search normalizes width/case and combines category with command, property and notes', () => {
  const moves = [move(), move({ id: 'ryu-wave', category: '必殺技', name: '波動拳', inputs: { classic: '↓ ↘ → P', modern: 'SP' }, properties: '飛び道具', notes: 'OD版のみ' })]
  assert.equal(filterCharacterMoves(moves, { query: '弱ｐ', category: 'ALL' })[0].id, 'ryu-jab')
  assert.equal(filterCharacterMoves(moves, { query: 'ｓｐ', category: '必殺技' })[0].id, 'ryu-wave')
  assert.equal(filterCharacterMoves(moves, { query: '飛び道具', category: '' }).length, 1)
  assert.equal(filterCharacterMoves(moves, { query: 'od', category: '通常技' }).length, 0)
  assert.equal(filterCharacterMoves(moves, { query: '↓↘→', category: '必殺技' })[0].id, 'ryu-wave')
  assert.equal(filterCharacterMoves([move({ inputs: { classic: '弱P + 弱K', modern: '弱 + 中' } })], { query: '弱Ｐ+弱Ｋ', category: '' }).length, 1)
  assert.equal(filterCharacterMoves([move({ inputs: { classic: '', modern: '弱 + 中' }, controlType: 'modern' })], { query: '弱+中', category: '', controlType: 'modern' }).length, 1)
  assert.deepEqual(characterMoveCategories(moves), ['通常技', '必殺技'])
  assert.equal(moves.length, 2)
  assert.equal(filterCharacterMoves([move(), move({ id: 'modern-jab', controlType: 'modern' })], { query: '', category: '', controlType: 'modern' })[0].id, 'modern-jab')
})

test('loaders share successful requests, retry failures and evict mismatched descriptors', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  let failDataset = true
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('index.json')) return new Response(JSON.stringify({ schemaVersion: 1, generatedAt, characters: [descriptor] }))
    if (failDataset) return new Response('', { status: 503 })
    return new Response(JSON.stringify(dataset()))
  }
  try {
    const manifests = await Promise.all([loadCharacterManifest(), loadCharacterManifest()])
    assert.deepEqual(manifests[0], manifests[1])
    assert.equal(calls.filter((url) => url.includes('index.json')).length, 1)
    await assert.rejects(loadCharacterDataset(descriptor, generatedAt), /読み込めません/)
    failDataset = false
    const results = await Promise.all([loadCharacterDataset(descriptor, generatedAt), loadCharacterDataset(descriptor, generatedAt)])
    assert.deepEqual(results[0], dataset())
    assert.equal(calls.filter((url) => url.includes('ryu.json')).length, 2)
    assert.match(calls.at(-1) ?? '', /\?v=2026-10-08T04%3A00%3A00.000Z$/)
    await assert.rejects(loadCharacterDataset({ ...descriptor, name: 'ケン' }, generatedAt), /一致しません/)
    assert.deepEqual(await loadCharacterDataset(descriptor, generatedAt), dataset())
    assert.equal(calls.filter((url) => url.includes('ryu.json')).length, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})
