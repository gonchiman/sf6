import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildCharacterTraits, CHARACTER_TRAITS, loadCharacterTraitsDataset, parseCharacterTraitsDataset } from './characterTraits.ts'
import { parseCharacterDataset, parseCharacterManifest } from './characters.ts'
import type { CharacterDataset, CharacterMove } from '../types/characters.ts'
import type { CharacterTraitsDataset } from '../types/characterTraits.ts'

const capturedAt = '2026-10-08T03:00:00.000Z'
const generatedAt = '2026-10-08T04:00:00.000Z'

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
  return { schemaVersion: 1, rulesVersion: 1, generatedAt, sourceManifestGeneratedAt: capturedAt, characters: [buildCharacterTraits(dataset(moves))] }
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
    assert.ok(CHARACTER_TRAITS.every(({ id }) => results[id].status === 'not-found'), notes)
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
    (input: CharacterTraitsDataset) => { input.rulesVersion = 2 as 1 },
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
  const manifest = parseCharacterManifest(JSON.parse(readFileSync(new URL('../../public/data/characters/index.json', import.meta.url), 'utf8')))
  const expected = { full: [18, 21, 21], air: [20, 66, 66], projectile: [22, 201, 188], armor: [5, 20, 20], projectileInv: [13, 40, 38], clash: [9, 43, 43] }
  const entries = manifest.characters.map((descriptor) => {
    const raw = parseCharacterDataset(JSON.parse(readFileSync(new URL(`../../public/data/characters/${descriptor.file}`, import.meta.url), 'utf8')), descriptor)
    return { raw, classified: buildCharacterTraits(raw, descriptor) }
  })
  for (const [modeIndex, mode] of (['classic', 'modern'] as const).entries()) {
    for (const { id } of CHARACTER_TRAITS) {
      assert.equal(entries.filter(({ classified }) => classified.traits[mode][id].status === 'confirmed').length, expected[id][0], `${mode} ${id} characters`)
      assert.equal(entries.reduce((sum, { classified }) => sum + classified.traits[mode][id].evidence.length, 0), expected[id][modeIndex + 1], `${mode} ${id} evidence`)
      for (const { raw, classified } of entries) {
        assert.equal(classified.traits[mode][id].unresolved.length, 0, `${raw.id} ${mode} ${id}`)
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
