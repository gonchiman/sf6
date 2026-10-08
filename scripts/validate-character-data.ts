import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseCharacterDataset, parseCharacterManifest } from '../src/lib/characters.ts'

export async function validateCharacterDirectory(directory: string): Promise<{ characters: number; moves: number }> {
  const root = resolve(directory)
  const manifest = parseCharacterManifest(JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')))
  const expected = new Set(['index.json', ...manifest.characters.map((entry) => entry.file)])
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.json') && !expected.has(entry.name))) {
      throw new Error(`一覧に登録されていないデータがあります: ${entry.name}`)
    }
  }
  let moves = 0
  for (const descriptor of manifest.characters) {
    const dataset = parseCharacterDataset(JSON.parse(await readFile(resolve(root, descriptor.file), 'utf8')), descriptor)
    if (!dataset.moves.some((move) => move.controlType === 'classic') || !dataset.moves.some((move) => move.controlType === 'modern')) {
      throw new Error(`両操作タイプの技データが必要です: ${descriptor.file}`)
    }
    if (Date.parse(dataset.capturedAt) > Date.parse(manifest.generatedAt)) throw new Error(`取得日時が生成日時より後になっています: ${descriptor.file}`)
    moves += dataset.moves.length
  }
  return { characters: manifest.characters.length, moves }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../public/data/characters/', import.meta.url))
  try {
    const result = await validateCharacterDirectory(directory)
    console.log(`キャラクターデータ検証完了: ${result.characters}キャラ / ${result.moves}技`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
