import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { CharacterDataset, CharacterManifest, CharacterMove } from '../../src/types/characters.ts'
import {
  buildCharacterTraitsFile,
  characterTraitsDatasetFromSources,
  loadCharacterTraitsSources,
  validateCharacterTraitsAgainstSources,
  validateCharacterTraitsFile,
  type CharacterTraitsSources,
} from './character-traits-data.ts'

const CAPTURED_AT = '2026-10-08T03:00:00.000Z'
const MANIFEST_AT = '2026-10-08T04:00:00.000Z'
const GENERATED_AT = '2026-10-08T05:00:00.000Z'
const FIXTURE_PARENT = fileURLToPath(new URL('../../.local/', import.meta.url))

function move(controlType: 'classic' | 'modern', suffix: string, properties: string, notes: string): CharacterMove {
  return {
    id: `${controlType}-${suffix}`, controlType, category: '必殺技', name: suffix === 'od' ? 'OD 昇龍拳' : '波動拳',
    inputs: { classic: '↓ ↘ → + P', modern: 'SP' }, startup: '6', active: '6-15', recovery: '30',
    onHit: 'D', onBlock: '-20', cancel: 'SA3', damage: '1000', comboScaling: '',
    driveGaugeGain: '', driveGaugeLoss: '', punishCounterDriveLoss: '', superGaugeGain: '', properties, notes,
  }
}

function character(id = 'ryu'): CharacterDataset {
  return {
    schemaVersion: 1, id, name: id === 'ryu' ? 'リュウ' : 'ケン', englishName: id.toUpperCase(), health: 10000,
    capturedAt: CAPTURED_AT, gameVersion: null,
    source: { title: '公式フレームデータ', url: `https://www.streetfighter.com/6/ja-jp/character/${id}/frame` },
    moves: [
      move('classic', 'od', '上', '1-8F 完全無敵'), move('classic', 'projectile', '上・弾', ''),
      move('modern', 'od', '上', '1-8F 完全無敵'), move('modern', 'projectile', '上・弾', ''),
      ...(['classic', 'modern'] as const).map((controlType) => ({
        ...move(controlType, 'crouching-mk', '下', ''), category: '通常技', name: 'しゃがみ中K（中足）', cancel: 'C',
        inputs: { classic: controlType === 'classic' ? '↓ + 中K' : '', modern: controlType === 'modern' ? '↓ + 中' : '' },
      })),
    ],
  }
}

function sources(ids = ['ryu']): CharacterTraitsSources {
  const datasets = ids.map((id) => character(id))
  const manifest: CharacterManifest = {
    schemaVersion: 1, generatedAt: MANIFEST_AT,
    characters: datasets.map(({ id, name, englishName }) => ({ id, name, englishName, file: `${id}.json` })),
  }
  return { manifest, datasets }
}

async function withFixture(run: (paths: { root: string; input: string; output: string }) => Promise<void>): Promise<void> {
  // Keep rename-based publication tests inside the writable checkout on Windows.
  await mkdir(FIXTURE_PARENT, { recursive: true })
  const root = await mkdtemp(join(FIXTURE_PARENT, 'sf6-character-traits-test-'))
  const input = join(root, 'characters')
  const output = join(root, 'character-traits.json')
  await mkdir(input)
  const fixture = sources()
  await writeFile(join(input, 'index.json'), JSON.stringify(fixture.manifest), 'utf8')
  await writeFile(join(input, 'ryu.json'), JSON.stringify(fixture.datasets[0]), 'utf8')
  try { await run({ root, input, output }) } finally {
    // The recursive cleanup target is exactly the newly created test directory.
    assert.equal(dirname(resolve(root)), resolve(FIXTURE_PARENT))
    assert.ok(basename(root).startsWith('sf6-character-traits-test-'))
    await rm(root, { recursive: true, force: true })
  }
}

test('summary preserves manifest order, source metadata and both modes without changing source data', () => {
  const input = sources(['ken', 'ryu'])
  input.datasets.reverse()
  const before = structuredClone(input)
  const dataset = characterTraitsDatasetFromSources(input, GENERATED_AT)
  assert.deepEqual(input, before)
  assert.equal(dataset.schemaVersion, 2)
  assert.equal(dataset.rulesVersion, 2)
  assert.equal(dataset.generatedAt, GENERATED_AT)
  assert.equal(dataset.sourceManifestGeneratedAt, MANIFEST_AT)
  assert.deepEqual(dataset.characters.map((entry) => entry.id), ['ken', 'ryu'])
  assert.equal(dataset.characters[0].capturedAt, CAPTURED_AT)
  assert.equal(dataset.characters[0].gameVersion, null)
  for (const mode of ['classic', 'modern'] as const) {
    assert.equal(dataset.characters[0].traits[mode].full.status, 'confirmed')
    assert.equal(dataset.characters[0].traits[mode].projectile.status, 'confirmed')
    assert.equal(dataset.characters[0].traits[mode].crouchingMKCancel.status, 'confirmed')
    assert.equal(dataset.characters[0].traits[mode].crouchingMKCancel.checkedMoves![0].cancel, 'C')
  }
  assert.deepEqual(validateCharacterTraitsAgainstSources(dataset, input), dataset)
})

test('summary rejects a missing, extra or repeated source character and incomplete control types', () => {
  const missing = sources()
  missing.datasets = []
  assert.throws(() => characterTraitsDatasetFromSources(missing, GENERATED_AT), /元データがありません/)
  const extra = sources()
  extra.datasets.push(character('ken'))
  assert.throws(() => characterTraitsDatasetFromSources(extra, GENERATED_AT), /構成が一致/)
  const duplicate = sources()
  duplicate.datasets.push(structuredClone(duplicate.datasets[0]))
  assert.throws(() => characterTraitsDatasetFromSources(duplicate, GENERATED_AT), /構成が一致/)
  const incomplete = sources()
  incomplete.datasets[0].moves = incomplete.datasets[0].moves.filter((entry) => entry.controlType === 'classic')
  assert.throws(() => characterTraitsDatasetFromSources(incomplete, GENERATED_AT), /両操作タイプ/)
})

test('summary rejects a capture after the source manifest or generation before the manifest', () => {
  const lateCapture = sources()
  lateCapture.datasets[0].capturedAt = '2026-10-08T04:30:00.000Z'
  assert.throws(() => characterTraitsDatasetFromSources(lateCapture, GENERATED_AT), /取得日時/)
  assert.throws(() => characterTraitsDatasetFromSources(sources(), CAPTURED_AT), /生成日時/)
})

test('validator rejects old rules, changed source generation and missing or extra summary characters', () => {
  const input = sources(['ryu', 'ken'])
  const dataset = characterTraitsDatasetFromSources(input, GENERATED_AT)
  assert.throws(() => validateCharacterTraitsAgainstSources({ ...dataset, schemaVersion: 1 }, input))
  assert.throws(() => validateCharacterTraitsAgainstSources({ ...dataset, rulesVersion: 1 }, input))
  assert.throws(() => validateCharacterTraitsAgainstSources({ ...dataset, rulesVersion: 0 }, input))
  assert.throws(() => validateCharacterTraitsAgainstSources({ ...dataset, sourceManifestGeneratedAt: CAPTURED_AT }, input), /生成日時/)
  assert.throws(() => validateCharacterTraitsAgainstSources({ ...dataset, characters: dataset.characters.slice(0, 1) }, input), /件数/)
  const reordered = { ...dataset, characters: [...dataset.characters].reverse() }
  assert.throws(() => validateCharacterTraitsAgainstSources(reordered, input), /一致しません/)
  const extraInput = sources(['ryu', 'ken', 'luke'])
  const extraDataset = characterTraitsDatasetFromSources(extraInput, GENERATED_AT)
  assert.throws(() => validateCharacterTraitsAgainstSources(extraDataset, input), /件数/)
})

test('validator rejects evidence move IDs, original note changes and stale character metadata', () => {
  const input = sources()
  const dataset = characterTraitsDatasetFromSources(input, GENERATED_AT)
  const forged = structuredClone(dataset)
  forged.characters[0].traits.classic.full.evidence[0].moveId = 'classic-unrelated'
  assert.throws(() => validateCharacterTraitsAgainstSources(forged, input), /一致しません/)
  const changedNotes = structuredClone(input)
  changedNotes.datasets[0].moves[0].notes = '1-10F 完全無敵'
  assert.throws(() => validateCharacterTraitsAgainstSources(dataset, changedNotes), /一致しません/)
  const changedMetadata = structuredClone(input)
  changedMetadata.datasets[0].gameVersion = '2.000'
  assert.throws(() => validateCharacterTraitsAgainstSources(dataset, changedMetadata), /一致しません/)
})

test('validator rejects stale checked input, cancel, properties and notes even for not-found classifications', () => {
  const input = sources()
  const original = input.datasets[0].moves.find((entry) => entry.id === 'classic-crouching-mk')!
  original.cancel = ''
  original.notes = '※ヴィーハト・チェーニのみキャンセル可能'
  const dataset = characterTraitsDatasetFromSources(input, GENERATED_AT)
  const result = dataset.characters[0].traits.classic.crouchingMKCancel
  assert.equal(result.status, 'not-found')
  assert.equal(result.checkedMoves![0].cancel, '')
  assert.equal(result.checkedMoves![0].notes, original.notes)
  for (const field of ['input', 'cancel', 'properties', 'notes'] as const) {
    const forged = structuredClone(dataset)
    forged.characters[0].traits.classic.crouchingMKCancel.checkedMoves![0][field] = '変更した原文'
    assert.throws(() => validateCharacterTraitsAgainstSources(forged, input), /一致しません/)
  }
  for (const field of ['cancel', 'properties', 'notes'] as const) {
    const changed = structuredClone(input)
    changed.datasets[0].moves.find((entry) => entry.id === 'classic-crouching-mk')![field] = '変更した原文'
    assert.throws(() => validateCharacterTraitsAgainstSources(dataset, changed), /一致しません/)
  }
  const changedInput = structuredClone(input)
  changedInput.datasets[0].moves.find((entry) => entry.id === 'classic-crouching-mk')!.inputs.classic = '変更した入力'
  assert.throws(() => validateCharacterTraitsAgainstSources(dataset, changedInput), /一致しません/)
})

test('generator and validator use stored sources and publish a complete newline-terminated JSON', async () => {
  await withFixture(async ({ root, input, output }) => {
    const loaded = await loadCharacterTraitsSources(input)
    assert.deepEqual(loaded, sources())
    const result = await buildCharacterTraitsFile(input, output, GENERATED_AT)
    assert.equal(result.characters, 1)
    assert.equal(result.outputFile, resolve(output))
    const json = await readFile(output, 'utf8')
    assert.ok(json.endsWith('\n'))
    assert.deepEqual(JSON.parse(json), characterTraitsDatasetFromSources(loaded, GENERATED_AT))
    assert.deepEqual(await validateCharacterTraitsFile(input, output), { characters: 1 })
    const regeneratedAt = '2026-10-08T06:00:00.000Z'
    await buildCharacterTraitsFile(input, output, regeneratedAt)
    assert.equal(JSON.parse(await readFile(output, 'utf8')).generatedAt, regeneratedAt)
    assert.deepEqual(await validateCharacterTraitsFile(input, output), { characters: 1 })
    assert.deepEqual((await readdir(root)).sort(), ['character-traits.json', 'characters'])
  })
})

test('failed generation leaves the previous public summary untouched and rejects unlisted files', async () => {
  await withFixture(async ({ input, output }) => {
    await writeFile(output, 'previous publication\n', 'utf8')
    await writeFile(join(input, 'ken.json'), JSON.stringify(character('ken')), 'utf8')
    await assert.rejects(buildCharacterTraitsFile(input, output, GENERATED_AT), /一覧に登録されていない/)
    assert.equal(await readFile(output, 'utf8'), 'previous publication\n')
  })
})

test('missing source JSON and an invalid source cannot be published', async () => {
  await withFixture(async ({ input, output }) => {
    const invalid = sources().datasets[0]
    invalid.source.url = 'https://www.streetfighter.com/6/ja-jp/character/ken/frame'
    await writeFile(join(input, 'ryu.json'), JSON.stringify(invalid), 'utf8')
    await assert.rejects(buildCharacterTraitsFile(input, output, GENERATED_AT), /形式/)
    await assert.rejects(readFile(output), /ENOENT/)
    await rm(join(input, 'ryu.json'))
    await assert.rejects(loadCharacterTraitsSources(input), /ENOENT/)
  })
})

test('generator cannot overwrite a character source or publish inside its source directory', async () => {
  await withFixture(async ({ input }) => {
    const original = await readFile(join(input, 'ryu.json'), 'utf8')
    await assert.rejects(buildCharacterTraitsFile(input, join(input, 'ryu.json'), GENERATED_AT), /フォルダー外/)
    await assert.rejects(buildCharacterTraitsFile(input, join(input, 'new', 'traits.json'), GENERATED_AT), /フォルダー外/)
    assert.equal(await readFile(join(input, 'ryu.json'), 'utf8'), original)
  })
})
