import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { characterDatasetFromSnapshot, decodeCharacterInput } from './character-snapshot.ts'
import type { CharacterSnapshot, CharacterSnapshotRow } from './character-snapshot.ts'
import { importCharacterSnapshots } from '../import-character-data.ts'
import { validateCharacterDirectory } from '../validate-character-data.ts'

function row(name = '立ち弱P（ジャブ）', classicInputTokens = ['@icon_punch_l.png', '弱']): CharacterSnapshotRow {
  return {
    name, classicInputTokens, modernInputTokens: [],
    cells: [name, '4', '4-6', '7', '4', '-1', 'C', '300', '始動補正20%', '250', '-500', '-2000', '300', '上', '連打キャンセル対応\n詳細'],
  }
}

function snapshot(overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  return {
    id: 'ryu', url: 'https://www.streetfighter.com/6/ja-jp/character/ryu/frame',
    title: 'リュウ フレームデータ｜STREET FIGHTER 6｜CAPCOM', healthText: '体力\n10000', englishName: 'RYU', capturedAt: '2026-10-08T03:00:00.000Z',
    rows: [
      { cells: ['技名', '動作フレーム', '硬直差', 'キャンセル', 'ダメージ'], name: null, classicInputTokens: [], modernInputTokens: [] },
      { cells: ['通常技'], name: '通常技', classicInputTokens: [], modernInputTokens: [] }, row(),
    ], ...overrides,
  }
}

test('official commands replace known icons, remove duplicate strength and visibly retain unknown icons', () => {
  assert.equal(decodeCharacterInput(['@key-d.png', '@key-dr.png', '@key-r.png', '@icon_punch_l.png', '弱']), '↓ ↘ → 弱P')
  assert.equal(decodeCharacterInput(['@icon_punch.png', '@key-plus.png', '@icon_kick.png']), 'P + K')
  assert.equal(decodeCharacterInput(['@modern_dl.png', '@arrow_3.png', '@modern_l.png', '弱', '@modern_sp.png']), 'DI ▶ 弱 SP')
  assert.equal(decodeCharacterInput(['@key-lc.png', '@key-r.png', '@key-plus.png', '@icon_punch_l.png', '弱']), '←溜め → + 弱P')
  assert.equal(decodeCharacterInput(['@key-circle.png', '@key-plus.png', '@icon_punch.png', '@key-barrage.png']), '一回転 + P 連打')
  assert.equal(decodeCharacterInput(['@key-rc.png', '@icon_throw.png', '@key-dc.png']), '→溜め 投げ ↓溜め')
  // RYU's Modern strong Hadoken and SA1 append ')' to their strength text token.
  assert.equal(decodeCharacterInput(['@modern_h.png', '強)']), '強)')
  assert.equal(decodeCharacterInput(['@modern_l.png', '弱)']), '弱)')
  assert.equal(decodeCharacterInput(['@modern_h.png', '強攻撃']), '強 強攻撃')
  assert.equal(decodeCharacterInput(['@icon_punch_l.png', '弱／', '@icon_punch_m.png', '中']), '弱P ／ 中P')
  assert.equal(decodeCharacterInput(['@future_command.png', '後']), '［future_command.png］ 後')
})

test('snapshot conversion keeps all fifteen cells raw and does not infer a patch from the capture date', () => {
  const input = snapshot()
  const before = structuredClone(input)
  const dataset = characterDatasetFromSnapshot(input)
  assert.deepEqual(input, before)
  assert.equal(dataset.name, 'リュウ')
  assert.equal(dataset.health, 10000)
  assert.equal(dataset.gameVersion, null)
  assert.equal(dataset.moves[0].inputs.classic, '弱P')
  assert.equal(dataset.moves[0].startup, '4')
  assert.equal(dataset.moves[0].active, '4-6')
  assert.equal(dataset.moves[0].punishCounterDriveLoss, '-2000')
  assert.equal(dataset.moves[0].notes, '連打キャンセル対応\n詳細')
  assert.equal(dataset.moves[0].inputs.modern, '')
  assert.equal(characterDatasetFromSnapshot(snapshot({ healthText: '体力\n10,000' })).health, 10000)
  assert.equal(characterDatasetFromSnapshot(snapshot({ healthText: '非公開' })).health, null)
})

test('move IDs remain deterministic and distinguish state names, inputs and repeated identical rows', () => {
  const input = snapshot()
  input.rows.push(row('電刃状態のジャブ'), row('立ち弱P（ジャブ）', ['@icon_punch_m.png', '中']), row())
  const first = characterDatasetFromSnapshot(input)
  const second = characterDatasetFromSnapshot(input)
  assert.deepEqual(first.moves.map((move) => move.id), second.moves.map((move) => move.id))
  assert.equal(new Set(first.moves.map((move) => move.id)).size, 4)
  assert.equal(first.moves[3].id, `${first.moves[0].id}-2`)
  const changed = structuredClone(input)
  changed.rows[2].cells[1] = '5'
  assert.equal(characterDatasetFromSnapshot(changed).moves[0].id, first.moves[0].id)
  const modern = characterDatasetFromSnapshot({ ...snapshot(), controlType: 'modern' })
  assert.equal(modern.moves[0].controlType, 'modern')
  assert.notEqual(modern.moves[0].id, first.moves[0].id)
})

test('snapshot rejects missing columns, missing categories and a wrong source character', () => {
  const short = snapshot()
  short.rows[2].cells.pop()
  assert.throws(() => characterDatasetFromSnapshot(short), /列数/)
  assert.throws(() => characterDatasetFromSnapshot(snapshot({ rows: [row()] })), /カテゴリ/)
  assert.throws(() => characterDatasetFromSnapshot(snapshot({ url: 'https://www.streetfighter.com/6/ja-jp/character/ken/frame' })), /形式/)
  assert.throws(() => characterDatasetFromSnapshot(snapshot({ title: 'Unrecognized title' })), /キャラクター名/)
})

test('offline import follows the captured official roster, validates data and rejects unlisted files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sf6-characters-'))
  const output = join(directory, 'published')
  try {
    const ryu = snapshot()
    const ken = snapshot({ id: 'ken', englishName: 'KEN', title: 'ケン フレームデータ｜STREET FIGHTER 6｜CAPCOM', url: 'https://www.streetfighter.com/6/ja-jp/character/ken/frame' })
    await writeFile(join(directory, 'ryu.json'), JSON.stringify(ryu))
    await writeFile(join(directory, 'ryu.modern.json'), JSON.stringify({ ...ryu, controlType: 'modern', capturedAt: '2026-10-08T03:05:00.000Z' }))
    await writeFile(join(directory, 'ken.json'), JSON.stringify(ken))
    await writeFile(join(directory, 'ken.modern.json'), JSON.stringify({ ...ken, controlType: 'modern' }))
    await writeFile(join(directory, 'unavailable.json'), JSON.stringify([{ id: 'not-in-roster' }]))
    await writeFile(join(directory, 'roster.json'), JSON.stringify([{ id: 'ken', url: ken.url }, { id: 'ryu', url: ryu.url }]))
    assert.deepEqual(await importCharacterSnapshots(directory, output), { characters: 2, moves: 4 })
    assert.deepEqual(await validateCharacterDirectory(output), { characters: 2, moves: 4 })
    const savedRyu = JSON.parse(await readFile(join(output, 'ryu.json'), 'utf8'))
    assert.equal(savedRyu.capturedAt, '2026-10-08T03:05:00.000Z')
    assert.deepEqual(savedRyu.moves.map((entry: { controlType: string }) => entry.controlType), ['classic', 'modern'])
    const manifest = JSON.parse(await readFile(join(output, 'index.json'), 'utf8'))
    assert.deepEqual(manifest.characters.map((entry: { id: string }) => entry.id), ['ken', 'ryu'])
    await writeFile(join(output, 'unlisted.json'), '{}')
    await assert.rejects(validateCharacterDirectory(output), /登録されていない/)
    await rm(join(output, 'unlisted.json'))
    const savedKen = JSON.parse(await readFile(join(output, 'ken.json'), 'utf8'))
    savedKen.moves = savedKen.moves.filter((entry: { controlType: string }) => entry.controlType === 'classic')
    await writeFile(join(output, 'ken.json'), JSON.stringify(savedKen))
    await assert.rejects(validateCharacterDirectory(output), /両操作タイプ/)
    await rm(join(directory, 'ken.modern.json'))
    await assert.rejects(importCharacterSnapshots(directory, output), /両操作タイプ/)
    await writeFile(join(directory, 'ken.modern.json'), JSON.stringify({ ...ken, controlType: 'modern' }))
    await writeFile(join(directory, 'roster.json'), JSON.stringify([{ id: 'luke', url: 'https://www.streetfighter.com/6/ja-jp/character/luke/frame' }]))
    await assert.rejects(importCharacterSnapshots(directory, output), /取得記録がありません/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
