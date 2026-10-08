import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateCharacterTraitsFile } from './lib/character-traits-data.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2] ?? fileURLToPath(new URL('../public/data/characters/', import.meta.url))
  const traits = process.argv[3] ?? fileURLToPath(new URL('../public/data/character-traits.json', import.meta.url))
  try {
    const result = await validateCharacterTraitsFile(input, traits)
    console.log(`キャラ分類データ検証完了: ${result.characters}キャラ`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
