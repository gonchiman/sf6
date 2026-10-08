import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseCharacterDataset, parseCharacterManifest } from '../../src/lib/characters.ts'
import {
  buildCharacterTraits,
  CHARACTER_TRAIT_RULES_VERSION,
  parseCharacterTraitsDataset,
} from '../../src/lib/characterTraits.ts'
import type { CharacterDataset, CharacterManifest } from '../../src/types/characters.ts'
import type { CharacterTraitsDataset } from '../../src/types/characterTraits.ts'

export interface CharacterTraitsSources {
  manifest: CharacterManifest
  datasets: CharacterDataset[]
}

/** Read the same validated, complete roster used by the character information page. */
export async function loadCharacterTraitsSources(directory: string): Promise<CharacterTraitsSources> {
  const root = resolve(directory)
  const manifest = parseCharacterManifest(JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')))
  const expectedFiles = new Set(['index.json', ...manifest.characters.map((character) => character.file)])
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.json') && !expectedFiles.has(entry.name))) {
      throw new Error(`一覧に登録されていないキャラクターデータがあります: ${entry.name}`)
    }
  }
  const datasets: CharacterDataset[] = []
  for (const descriptor of manifest.characters) {
    const dataset = parseCharacterDataset(JSON.parse(await readFile(resolve(root, descriptor.file), 'utf8')), descriptor)
    assertCompleteSource(dataset, manifest)
    datasets.push(dataset)
  }
  return { manifest, datasets }
}

function assertCompleteSource(dataset: CharacterDataset, manifest: CharacterManifest): void {
  if (!dataset.moves.some((move) => move.controlType === 'classic') || !dataset.moves.some((move) => move.controlType === 'modern')) {
    throw new Error(`両操作タイプの技データが必要です: ${dataset.id}`)
  }
  if (Date.parse(dataset.capturedAt) > Date.parse(manifest.generatedAt)) {
    throw new Error(`取得日時がキャラクター一覧の生成日時より後になっています: ${dataset.id}`)
  }
}

export function characterTraitsDatasetFromSources(
  sources: CharacterTraitsSources,
  generatedAt = new Date().toISOString(),
): CharacterTraitsDataset {
  const manifest = parseCharacterManifest(sources.manifest)
  const datasets = new Map<string, CharacterDataset>()
  for (const input of sources.datasets) {
    const descriptor = manifest.characters.find((character) => character.id === input.id)
    if (!descriptor || datasets.has(input.id)) {
      throw new Error(`キャラクター一覧と元データの構成が一致しません: ${input.id}`)
    }
    const dataset = parseCharacterDataset(input, descriptor)
    assertCompleteSource(dataset, manifest)
    datasets.set(dataset.id, dataset)
  }
  const characters = manifest.characters.map((descriptor) => {
    const dataset = datasets.get(descriptor.id)
    if (!dataset) throw new Error(`キャラクターの元データがありません: ${descriptor.id}`)
    return buildCharacterTraits(dataset, descriptor)
  })
  const result = parseCharacterTraitsDataset({
    schemaVersion: 1,
    rulesVersion: CHARACTER_TRAIT_RULES_VERSION,
    generatedAt,
    sourceManifestGeneratedAt: manifest.generatedAt,
    characters,
  })
  if (Date.parse(result.generatedAt) < Date.parse(manifest.generatedAt)) {
    throw new Error('分類データの生成日時がキャラクター一覧の生成日時より前になっています。')
  }
  return result
}

/** Recompute every result to detect changed notes, stale rules, and forged move evidence. */
export function validateCharacterTraitsAgainstSources(
  value: unknown,
  sources: CharacterTraitsSources,
): CharacterTraitsDataset {
  const dataset = parseCharacterTraitsDataset(value)
  if (dataset.rulesVersion !== CHARACTER_TRAIT_RULES_VERSION) {
    throw new Error('分類データの判定規則が現在の規則と一致しません。分類データを再生成してください。')
  }
  if (dataset.sourceManifestGeneratedAt !== sources.manifest.generatedAt) {
    throw new Error('分類データとキャラクター一覧の生成日時が一致しません。分類データを再生成してください。')
  }
  const expected = characterTraitsDatasetFromSources(sources, dataset.generatedAt)
  if (dataset.characters.length !== expected.characters.length) {
    throw new Error('分類データとキャラクター一覧の件数が一致しません。分類データを再生成してください。')
  }
  for (let index = 0; index < expected.characters.length; index += 1) {
    const character = expected.characters[index]
    if (!isDeepStrictEqual(dataset.characters[index], character)) {
      throw new Error(`分類データが元データ・判定規則と一致しません: ${character.id}。分類データを再生成してください。`)
    }
  }
  return dataset
}

export async function buildCharacterTraitsFile(
  inputDirectory: string,
  outputFile: string,
  generatedAt = new Date().toISOString(),
): Promise<{ characters: number; outputFile: string }> {
  const output = resolve(outputFile)
  const fromInput = relative(resolve(inputDirectory), output)
  if (!fromInput || (fromInput !== '..' && !fromInput.startsWith(`..${sep}`) && !isAbsolute(fromInput))) {
    throw new Error('分類データの出力先は元のキャラクターデータのフォルダー外に指定してください。')
  }
  const sources = await loadCharacterTraitsSources(inputDirectory)
  const dataset = characterTraitsDatasetFromSources(sources, generatedAt)
  validateCharacterTraitsAgainstSources(dataset, sources)
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(dataset, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, output)
  } finally {
    try { await unlink(temporary) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  return { characters: dataset.characters.length, outputFile: output }
}

export async function validateCharacterTraitsFile(
  inputDirectory: string,
  traitsFile: string,
): Promise<{ characters: number }> {
  const sources = await loadCharacterTraitsSources(inputDirectory)
  const value: unknown = JSON.parse(await readFile(resolve(traitsFile), 'utf8'))
  const dataset = validateCharacterTraitsAgainstSources(value, sources)
  return { characters: dataset.characters.length }
}
