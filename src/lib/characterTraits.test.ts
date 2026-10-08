import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildCharacterTraits, CHARACTER_TRAITS, loadCharacterTraitsDataset, parseCharacterTraitsDataset } from './characterTraits.ts'
import { parseCharacterDataset, parseCharacterManifest } from './characters.ts'
import type { CharacterDataset, CharacterMove } from '../types/characters.ts'
import type { CharacterTraitsDataset } from '../types/characterTraits.ts'

const capturedAt = '2026-10-08T03:00:00.000Z'
const generatedAt = '2026-10-08T04:00:00.000Z'
const SPECIAL_TRAIT_IDS = ['full', 'air', 'projectile', 'armor', 'projectileInv', 'clash'] as const

function move(overrides: Partial<CharacterMove> = {}): CharacterMove {
  return {
    id: 'ryu-special', controlType: 'classic', category: '必殺技', name: '必殺技', inputs: { classic: '', modern: '' },
    startup: '', active: '', recovery: '', onHit: '', onBlock: '', cancel: '', damage: '', comboScaling: '',
    driveGaugeGain: '', driveGaugeLoss: '', punishCounterDriveLoss: '', superGaugeGain: '', properties: '上', notes: '',
    ...overrides,
  }
}

function dataset(moves: CharacterMove[]): CharacterDataset {
  return {
    schemaVersion: 1, id: 'ryu', name: 'リュウ', englishName: 'RYU', health: 10000, capturedAt, gameVersion: null,
    source: { title: 'リュウ フレームデータ', url: 'https://www.streetfighter.com/6/ja-jp/character/ryu/frame' }, moves,
  }
}

function published(moves: CharacterMove[] = [move()]): CharacterTraitsDataset {
  return { schemaVersion: 2, rulesVersion: 2, generatedAt, sourceManifestGeneratedAt: capturedAt, characters: [buildCharacterTraits(dataset(moves))] }
}

function crouchingMK(overrides: Partial<CharacterMove> = {}): CharacterMove {
  return move({
    id: 'ryu-crouching-mk', category: '通常技', name: 'しゃがみ中K（くるぶしキック）',
    inputs: { classic: '↓ + 中K', modern: '' }, properties: '下', cancel: 'C', ...overrides,
  })
}

function savedCharacters() {
  const manifest = parseCharacterManifest(JSON.parse(readFileSync(new URL('../../public/data/characters/index.json', import.meta.url), 'utf8')))
  return manifest.characters.map((descriptor) => {
    const raw = parseCharacterDataset(JSON.parse(readFileSync(new URL(`../../public/data/characters/${descriptor.file}`, import.meta.url), 'utf8')), descriptor)
    return { raw, classified: buildCharacterTraits(raw, descriptor) }
  })
}

test('1F classification handles width, wave separators and multiple intervals without matching 11F or 21F', () => {
  for (const notes of ['１～７Ｆ　完全無敵', '1-8F 完全無敵', '1F 完全無敵', '1-3F,8-10F 完全無敵']) {
    const result = buildCharacterTraits(dataset([move({ notes })])).traits.classic.full
    assert.equal(result.status, 'confirmed', notes)
    assert.equal(result.evidence[0].text, notes)
  }
  for (const notes of ['11-15F 完全無敵', '21-28F 完全無敵', '18-23F 完全無敵']) {
    assert.equal(buildCharacterTraits(dataset([move({ notes })])).traits.classic.full.status, 'not-found', notes)
  }
})

test('normal-only air trait includes state/hold conditions, excludes OD and does not infer from complete invincibility', () => {
  const notes = '酔いLv2以上で発動可能\n1-9F,28-38F　空中判定の打撃・空弾属性に対して無敵'
  const result = buildCharacterTraits(dataset([
    move({ id: 'conditional', name: '[強化版]必殺技（ホールド）', notes }),
    move({ id: 'od', name: '[強化版]OD必殺技', notes }),
  ])).traits.classic.air
  assert.equal(result.status, 'confirmed')
  assert.deepEqual(result.evidence, [{ moveId: 'conditional', moveName: '[強化版]必殺技（ホールド）', variant: 'normal', field: 'notes', text: notes, excerpt: notes.split('\n')[1] }])
  const odOnly = buildCharacterTraits(dataset([move({ name: 'OD必殺技', notes })])).traits.classic
  assert.equal(odOnly.air.status, 'not-found')
  assert.equal(buildCharacterTraits(dataset([move({ notes: '1-8F 完全無敵' })])).traits.classic.air.status, 'not-found')
  assert.equal(buildCharacterTraits(dataset([move({ notes: '5-15F 上半身のみ空中判定の打撃・空弾属性に対して無敵' })])).traits.classic.air.status, 'not-found')
})

test('projectile uses official symbols, while clash and projectile invincibility remain separate features', () => {
  assert.equal(buildCharacterTraits(dataset([move({ properties: '上・弾/上・空弾' })])).traits.classic.projectile.status, 'confirmed')
  const notes = '飛び道具相殺判定あり（2回）'
  const classified = buildCharacterTraits(dataset([move({ notes })])).traits.classic
  assert.equal(classified.clash.status, 'confirmed')
  assert.equal(classified.projectile.status, 'not-found')
  assert.equal(classified.projectileInv.status, 'not-found')
  assert.equal(buildCharacterTraits(dataset([move({ properties: '非弾' })])).traits.classic.projectile.status, 'unknown')
})

test('armor retains variable duration and missing F while excluding armor break and hitting the opponent armor', () => {
  for (const notes of ['1-持続終了　 アーマー判定（2回）', '3-28 上半身アーマー判定(1回)', '7- 13F 上半身アーマー判定(1回)']) {
    const result = buildCharacterTraits(dataset([move({ notes })])).traits.classic.armor
    assert.equal(result.status, 'confirmed', notes)
    assert.equal(result.evidence[0].text, notes)
  }
  const notes = 'アーマーブレイク属性\n空振り/アーマーヒット時硬直2F増加'
  assert.equal(buildCharacterTraits(dataset([move({ notes })])).traits.classic.armor.status, 'not-found')
})

test('projectile invincibility preserves combined targets, body parts and whole-cell conditions', () => {
  for (const notes of ['1-34F打撃・飛び道具に対して無敵\n裏回り時1-48F打撃・飛び道具に対して無敵', '7～21F 下半分飛び道具無敵\n22～28F 飛び道具無敵', '酔いLv2以上で発動可能\n3-24F 飛び道具に対して無敵']) {
    const result = buildCharacterTraits(dataset([move({ notes })])).traits.classic.projectileInv
    assert.equal(result.status, 'confirmed', notes)
    assert.equal(result.evidence[0].text, notes)
  }
  for (const notes of ['空弾属性に対して無敵の技に当たらない', '1-8F 完全無敵', '1-10F 空中判定の打撃・空弾属性に対して無敵']) {
    assert.equal(buildCharacterTraits(dataset([move({ notes })])).traits.classic.projectileInv.status, 'not-found', notes)
  }
})

test('opponent references and negations are not evidence; unsupported own statements remain unknown', () => {
  for (const notes of ['相手の完全無敵を無視する', '1-8F 完全無敵ではない', '1-8F 完全無敵にならない', '飛び道具を相殺できない', '飛び道具相殺判定ありではない', '空弾属性に対して無敵の技に当たらない']) {
    const results = buildCharacterTraits(dataset([move({ notes })])).traits.classic
    assert.ok(SPECIAL_TRAIT_IDS.every((id) => results[id].status === 'not-found'), notes)
  }
  for (const notes of ['当身成立後1-8F 完全無敵', '1-?F 完全無敵', '3-1F 完全無敵']) {
    const result = buildCharacterTraits(dataset([move({ notes })])).traits.classic.full
    assert.equal(result.status, 'unknown')
    assert.equal(result.unresolved[0].text, notes)
    assert.ok(result.reason)
  }
  const results = buildCharacterTraits(dataset([move({ id: 'unsupported', notes: '条件成立後完全無敵' }), move({ id: 'known', notes: '1-8F 完全無敵' })])).traits.classic.full
  assert.equal(results.status, 'confirmed')
  assert.equal(results.evidence[0].moveId, 'known')
  assert.equal(results.unresolved[0].moveId, 'unsupported')
})

test('special moves and control types are isolated; missing inputs are valid while absent mode data remains unknown', () => {
  const results = buildCharacterTraits(dataset([
    move({ id: 'normal', category: '通常技', notes: '1-8F 完全無敵' }),
    move({ id: 'system', category: '共通システム', notes: '1-8F 完全無敵' }),
    move({ id: 'super', category: 'スーパーアーツ', notes: '1-8F 完全無敵' }),
    move({ id: 'special', notes: '飛び道具相殺判定あり（1回）' }),
    move({ id: 'modern', controlType: 'modern', properties: '上・弾' }),
  ]))
  assert.equal(results.traits.classic.full.status, 'not-found')
  assert.equal(results.traits.classic.projectile.status, 'not-found')
  assert.equal(results.traits.classic.clash.status, 'confirmed')
  assert.equal(results.traits.modern.projectile.status, 'confirmed')
  const missing = buildCharacterTraits(dataset([move()])).traits.modern
  assert.ok(CHARACTER_TRAITS.every(({ id }) => missing[id].status === 'unknown' && !!missing[id].reason))
})

test('published schema rejects stale versions, missing traits, unsafe identities, invalid sources and contradictory states', () => {
  const value = published([move({ notes: '1-8F 完全無敵' })])
  assert.deepEqual(parseCharacterTraitsDataset(value), value)
  for (const change of [
    (input: CharacterTraitsDataset) => { input.schemaVersion = 1 as 2 },
    (input: CharacterTraitsDataset) => { input.rulesVersion = 1 as 2 },
    (input: CharacterTraitsDataset) => { delete (input.characters[0].traits.classic as Partial<typeof input.characters[0]['traits']['classic']>).full },
    (input: CharacterTraitsDataset) => { input.characters[0].file = '../ryu.json' },
    (input: CharacterTraitsDataset) => { input.characters.push(input.characters[0]) },
    (input: CharacterTraitsDataset) => { input.generatedAt = '2026-02-29T00:00:00Z' },
    (input: CharacterTraitsDataset) => { input.characters[0].source.url = 'https://example.com/ryu/frame' },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.full.evidence = [] },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.full.status = 'not-found' },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.modern.full.reason = null },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.full.evidence[0].field = 'properties' },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.full.evidence[0].excerpt = '原文にない記載' },
  ]) {
    const invalid = structuredClone(value)
    change(invalid)
    assert.throws(() => parseCharacterTraitsDataset(invalid), /形式|duplicate/)
  }
})

test('all saved official characters match the audited positive sets and retain every evidence field verbatim', () => {
  const expected = { full: [18, 21, 21], air: [20, 66, 66], projectile: [22, 201, 188], armor: [5, 20, 20], projectileInv: [13, 40, 38], clash: [9, 43, 43] }
  const entries = savedCharacters()
  for (const [modeIndex, mode] of (['classic', 'modern'] as const).entries()) {
    for (const id of SPECIAL_TRAIT_IDS) {
      assert.equal(entries.filter(({ classified }) => classified.traits[mode][id].status === 'confirmed').length, expected[id][0], `${mode} ${id} characters`)
      assert.equal(entries.reduce((sum, { classified }) => sum + classified.traits[mode][id].evidence.length, 0), expected[id][modeIndex + 1], `${mode} ${id} evidence`)
      for (const { raw, classified } of entries) {
        assert.equal(classified.traits[mode][id].unresolved.length, 0, `${raw.id} ${mode} ${id}`)
        assert.equal(Object.hasOwn(classified.traits[mode][id], 'checkedMoves'), false)
        for (const evidence of classified.traits[mode][id].evidence) {
          const original = raw.moves.find((move) => move.id === evidence.moveId)!
          assert.equal(evidence.text, original[evidence.field])
          assert.ok(evidence.text.includes(evidence.excerpt))
          assert.equal(original.controlType, mode)
          assert.equal(original.category, '必殺技')
        }
      }
    }
  }
})

test('crouching MK normalizes width, whitespace and parentheses while retaining each original checked cell', () => {
  const original = crouchingMK({
    name: 'しゃがみ 中Ｋ （くるぶし キック）', cancel: ' Ｃ ', properties: '　下　',
    inputs: { classic: '↓ ＋ 中Ｋ', modern: '' }, notes: 'ガード、空振り時硬直2F増加',
  })
  const result = buildCharacterTraits(dataset([original])).traits.classic.crouchingMKCancel
  assert.equal(result.status, 'confirmed')
  assert.deepEqual(result.checkedMoves, [{
    moveId: original.id, moveName: original.name, input: original.inputs.classic,
    cancel: original.cancel, properties: original.properties, notes: original.notes,
  }])
  assert.deepEqual(result.evidence, [{
    moveId: original.id, moveName: original.name, variant: 'normal', field: 'cancel',
    text: original.cancel, excerpt: original.cancel,
  }])
  assert.deepEqual(parseCharacterTraitsDataset(published([original])), published([original]))
  const englishNickname = published([crouchingMK({ name: 'しゃがみ中K（GOOD KICK）' })])
  assert.equal(englishNickname.characters[0].traits.classic.crouchingMKCancel.evidence[0].variant, 'normal')
  assert.deepEqual(parseCharacterTraitsDataset(englishNickname), englishNickname)
  const feature = CHARACTER_TRAITS.find(({ id }) => id === 'crouchingMKCancel')!
  assert.equal(feature.label, '中足キャンセル')
  assert.equal(feature.scopeLabel, '通常技・しゃがみ中K')
})

test('crouching MK does not substitute punches, state rows or special moves and keeps control types separate', () => {
  for (const override of [
    { name: 'しゃがみ中P（アンダーフック）' },
    { name: '[チェーンコンボ]しゃがみ中K（剥影脚）' },
    { name: '［強化版］しゃがみ中K（中足）' },
    { name: 'しゃがみ中K（中足）（強化中）' },
    { category: '特殊技' },
    { category: '必殺技' },
  ]) {
    const result = buildCharacterTraits(dataset([crouchingMK(override)])).traits.classic.crouchingMKCancel
    assert.equal(result.status, 'unknown')
    assert.deepEqual(result.checkedMoves, [])
    assert.match(result.reason!, /しゃがみ中Kが保存データにありません/)
  }
  const mixed = buildCharacterTraits(dataset([
    crouchingMK(), crouchingMK({ id: 'modern-mk', controlType: 'modern', cancel: 'SA', inputs: { classic: '', modern: '↓ + 中' } }),
  ]))
  assert.equal(mixed.traits.classic.crouchingMKCancel.status, 'confirmed')
  assert.equal(mixed.traits.modern.crouchingMKCancel.status, 'not-found')
  assert.equal(mixed.traits.modern.crouchingMKCancel.checkedMoves![0].input, '↓ + 中')
  const high = buildCharacterTraits(dataset([crouchingMK({ properties: '上' })])).traits.classic.crouchingMKCancel
  assert.equal(high.status, 'not-found')
  assert.equal(high.checkedMoves![0].properties, '上')
})

test('known non-C symbols, blank cells and specific cancellation notes are retained without general permission', () => {
  for (const cancel of ['', 'SA', 'SA2', 'SA3', '※', '※1', 'SA※', 'SA2※', 'SA3※', '※SA', '※SA2', '※SA3', 'SA2,※', 'SA3,※']) {
    const result = buildCharacterTraits(dataset([crouchingMK({ cancel })])).traits.classic.crouchingMKCancel
    assert.equal(result.status, 'not-found', cancel)
    assert.deepEqual(result.evidence, [])
    assert.deepEqual(result.unresolved, [])
    assert.equal(result.checkedMoves![0].cancel, cancel)
  }
  for (const original of [
    crouchingMK({ cancel: '※', notes: '※肩屋入り中、百裂張り手でのみキャンセル可能' }),
    crouchingMK({ cancel: '', notes: '※ヴィーハト・チェーニのみキャンセル可能' }),
    crouchingMK({ cancel: '', notes: 'ハイジャンプキャンセル可能' }),
  ]) {
    const value = published([original])
    assert.equal(value.characters[0].traits.classic.crouchingMKCancel.status, 'not-found')
    assert.equal(value.characters[0].traits.classic.crouchingMKCancel.checkedMoves![0].notes, original.notes)
    assert.deepEqual(parseCharacterTraitsDataset(value), value)
  }
})

test('C cancellation conditions and unrecognized symbols or guard properties remain unknown with original evidence', () => {
  for (const notes of [
    'ヒット時のみキャンセル可能', 'SA技でのみキャンセル可能', '必殺技キャンセル不可',
    '1段目のみキャンセル可能', '※肩屋入り中、百裂張り手でのみキャンセル可能',
    '相手はキャンセル不可。自分も必殺技キャンセル不可',
  ]) {
    const value = published([crouchingMK({ notes })])
    const result = value.characters[0].traits.classic.crouchingMKCancel
    assert.equal(result.status, 'unknown', notes)
    assert.deepEqual(result.evidence, [])
    assert.equal(result.unresolved[0].field, 'notes')
    assert.equal(result.unresolved[0].text, notes)
    assert.equal(result.checkedMoves![0].notes, notes)
    assert.ok(result.reason)
    assert.deepEqual(parseCharacterTraitsDataset(value), value)
  }
  for (const notes of ['連打キャンセル対応', 'ハイジャンプキャンセル可能', '相手はキャンセル不可', '空振り時硬直3F増加']) {
    assert.equal(buildCharacterTraits(dataset([crouchingMK({ notes })])).traits.classic.crouchingMKCancel.status, 'confirmed', notes)
  }
  for (const override of [{ properties: '' }, { properties: '下・上' }, { properties: '下（条件付き）' }, { cancel: 'C※' }, { cancel: '?' }]) {
    const value = published([crouchingMK(override)])
    const result = value.characters[0].traits.classic.crouchingMKCancel
    assert.equal(result.status, 'unknown')
    assert.ok(result.reason)
    assert.deepEqual(parseCharacterTraitsDataset(value), value)
  }
})

test('schema requires checked rows only for crouching MK and rejects forged or contradictory evidence', () => {
  const value = published([crouchingMK()])
  for (const change of [
    (input: CharacterTraitsDataset) => { delete input.characters[0].traits.classic.crouchingMKCancel.checkedMoves },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.crouchingMKCancel.checkedMoves = [] },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.crouchingMKCancel.checkedMoves!.push(input.characters[0].traits.classic.crouchingMKCancel.checkedMoves![0]) },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.crouchingMKCancel.checkedMoves![0].moveName = 'しゃがみ中P' },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.crouchingMKCancel.checkedMoves![0].cancel = 'SA' },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.crouchingMKCancel.evidence[0].moveId = 'other-move' },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.crouchingMKCancel.evidence[0].field = 'notes' },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.crouchingMKCancel.evidence[0].variant = 'od' },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.classic.full.checkedMoves = [] },
    (input: CharacterTraitsDataset) => { input.characters[0].traits.modern.crouchingMKCancel.status = 'not-found'; input.characters[0].traits.modern.crouchingMKCancel.reason = null },
  ]) {
    const invalid = structuredClone(value)
    change(invalid)
    assert.throws(() => parseCharacterTraitsDataset(invalid), /形式|duplicate/)
  }
})

test('saved characters confirm 16 lower MK cancels in each mode and retain Honda, JP, Ed and Lily exceptions', () => {
  const entries = savedCharacters()
  const expectedIds = ['ryu', 'luke', 'jamie', 'chunli', 'juri', 'ken', 'blanka', 'lily', 'cammy',
    'rashid', 'gouki_akuma', 'vega_mbison', 'terry', 'mai', 'ingrid', 'yasmine']
  const missingModern = ['marisa', 'zangief', 'ed']
  for (const mode of ['classic', 'modern'] as const) {
    assert.deepEqual(entries.filter(({ classified }) => classified.traits[mode].crouchingMKCancel.status === 'confirmed').map(({ raw }) => raw.id), expectedIds)
    assert.deepEqual(entries.filter(({ classified }) => classified.traits[mode].crouchingMKCancel.status === 'unknown').map(({ raw }) => raw.id), mode === 'modern' ? missingModern : [])
    for (const { raw, classified } of entries) {
      const result = classified.traits[mode].crouchingMKCancel
      assert.equal(result.checkedMoves!.length, mode === 'modern' && missingModern.includes(raw.id) ? 0 : 1)
      for (const checked of result.checkedMoves!) {
        const original = raw.moves.find((move) => move.id === checked.moveId)!
        assert.equal(original.controlType, mode)
        assert.equal(original.category, '通常技')
        assert.deepEqual(checked, {
          moveId: original.id, moveName: original.name, input: original.inputs[mode],
          cancel: original.cancel, properties: original.properties, notes: original.notes,
        })
      }
      if (result.status === 'confirmed') {
        assert.equal(result.evidence[0].field, 'cancel')
        assert.equal(result.evidence[0].text, 'C')
        assert.equal(result.checkedMoves![0].properties, '下')
      }
    }
    for (const id of ['ehonda', 'jp', 'aki', 'cviper']) {
      assert.equal(entries.find(({ raw }) => raw.id === id)!.classified.traits[mode].crouchingMKCancel.status, 'not-found')
    }
  }
  assert.match(entries.find(({ raw }) => raw.id === 'ehonda')!.classified.traits.classic.crouchingMKCancel.checkedMoves![0].notes, /肩屋入り中/)
  assert.match(entries.find(({ raw }) => raw.id === 'jp')!.classified.traits.classic.crouchingMKCancel.checkedMoves![0].notes, /ヴィーハト・チェーニ/)
  const ed = entries.find(({ raw }) => raw.id === 'ed')!.classified
  assert.equal(ed.traits.classic.crouchingMKCancel.status, 'not-found')
  assert.equal(ed.traits.classic.crouchingMKCancel.checkedMoves![0].properties, '上')
  assert.equal(entries.find(({ raw }) => raw.id === 'lily')!.classified.traits.modern.crouchingMKCancel.checkedMoves![0].input, 'AUTO + 中')
})

test('the six existing features retain the exact pre-extension results and original evidence for all stored characters', () => {
  // This baseline was calculated from the rulesVersion 1 publication before adding the trait.
  const priorTraits = savedCharacters().map(({ classified }) => ({
    id: classified.id,
    traits: Object.fromEntries((['classic', 'modern'] as const).map((mode) => [
      mode, Object.fromEntries(SPECIAL_TRAIT_IDS.map((id) => [id, classified.traits[mode][id]])),
    ])),
  }))
  const digest = createHash('sha256').update(JSON.stringify(priorTraits)).digest('hex')
  assert.equal(digest, 'a4ee13ba1df0b0b12523ed39c67b35391976fa437a3ef8d1140c151cb2bb5689')
})

test('loader shares successful requests and retries HTTP and schema failures', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  let response: 'http' | 'schema' | 'valid' = 'http'
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return response === 'http' ? new Response('', { status: 503 }) : new Response(JSON.stringify(response === 'schema' ? { schemaVersion: 2 } : published()))
  }
  try {
    await assert.rejects(loadCharacterTraitsDataset(), /読み込めません/)
    response = 'schema'
    await assert.rejects(loadCharacterTraitsDataset(), /形式/)
    response = 'valid'
    const first = loadCharacterTraitsDataset()
    const second = loadCharacterTraitsDataset()
    assert.equal(first, second)
    assert.deepEqual(await first, published())
    assert.equal(urls.length, 3)
    assert.equal(urls[0], '/data/character-traits.json')
    await loadCharacterTraitsDataset()
    assert.equal(urls.length, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})
