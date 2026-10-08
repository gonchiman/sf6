import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { characterDatasetFromSnapshot } from './lib/character-snapshot.ts'
import { parseCharacterDataset, parseCharacterManifest } from '../src/lib/characters.ts'
import type { CharacterDataset } from '../src/types/characters.ts'

export async function importCharacterSnapshots(inputDirectory: string, outputDirectory: string): Promise<{ characters: number; moves: number }> {
  const inputRoot = resolve(inputDirectory)
  const files = (await readdir(inputRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !['roster.json', 'unavailable.json'].includes(entry.name))
    .map((entry) => entry.name)
    .sort()
  const datasets = new Map<string, CharacterDataset>()
  const modesById = new Map<string, Set<string>>()
  for (const file of files) {
    const dataset = characterDatasetFromSnapshot(JSON.parse(await readFile(resolve(inputRoot, file), 'utf8')))
    const mode = dataset.moves[0].controlType
    const expectedFile = `${dataset.id}${mode === 'modern' ? '.modern' : ''}.json`
    const modes = modesById.get(dataset.id) ?? new Set<string>()
    if (file !== expectedFile || modes.has(mode)) throw new Error(`取得記録のID・操作タイプ・ファイル名が一致しません: ${file}`)
    modes.add(mode)
    modesById.set(dataset.id, modes)
    const existing = datasets.get(dataset.id)
    if (existing) {
      for (const key of ['name', 'englishName', 'health', 'gameVersion'] as const) {
        if (existing[key] !== dataset[key]) throw new Error(`操作タイプ間でキャラクター情報が一致しません: ${dataset.id} / ${key}`)
      }
      if (existing.source.url !== dataset.source.url || existing.source.title !== dataset.source.title) throw new Error(`操作タイプ間で出典が一致しません: ${dataset.id}`)
      datasets.set(dataset.id, parseCharacterDataset({
        ...existing,
        capturedAt: Date.parse(dataset.capturedAt) > Date.parse(existing.capturedAt) ? dataset.capturedAt : existing.capturedAt,
        moves: [...existing.moves, ...dataset.moves],
      }))
    } else datasets.set(dataset.id, dataset)
  }
  for (const [id, modes] of modesById) {
    if (!modes.has('classic') || !modes.has('modern')) throw new Error(`両操作タイプの取得記録が必要です: ${id}`)
  }
  let ordered = [...datasets.values()]
  const rosterPath = resolve(inputRoot, 'roster.json')
  let rosterText: string | undefined
  try { rosterText = await readFile(rosterPath, 'utf8') } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  if (rosterText !== undefined) {
    const roster: unknown = JSON.parse(rosterText)
    if (!Array.isArray(roster) || roster.length === 0) throw new Error('公式キャラクター一覧が不正です。')
    const seen = new Set<string>()
    ordered = roster.map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || seen.has(entry.id)) throw new Error('公式キャラクター一覧のIDが不正です。')
      seen.add(entry.id)
      const dataset = datasets.get(entry.id)
      if (!dataset || entry.url !== dataset.source.url) throw new Error(`公式一覧に対応する取得記録がありません: ${entry.id}`)
      return dataset
    })
    if ([...datasets.keys()].some((id) => !seen.has(id))) throw new Error('公式一覧に登録されていない取得記録があります。')
  }
  const manifest = parseCharacterManifest({
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    characters: ordered.map((dataset) => ({ id: dataset.id, name: dataset.name, englishName: dataset.englishName, file: `${dataset.id}.json` })),
  })
  const outputRoot = resolve(outputDirectory)
  await mkdir(outputRoot, { recursive: true })
  for (const dataset of ordered) {
    await writeFile(resolve(outputRoot, `${dataset.id}.json`), `${JSON.stringify(dataset, null, 2)}\n`, 'utf8')
  }
  // Publish the index only after every snapshot has been checked and saved.
  await writeFile(resolve(outputRoot, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { characters: ordered.length, moves: ordered.reduce((sum, dataset) => sum + dataset.moves.length, 0) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2] ?? fileURLToPath(new URL('../.local/character-snapshots/', import.meta.url))
  const output = process.argv[3] ?? fileURLToPath(new URL('../public/data/characters/', import.meta.url))
  try {
    const result = await importCharacterSnapshots(input, output)
    console.log(`キャラクターデータ取込完了: ${result.characters}キャラ / ${result.moves}技`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
