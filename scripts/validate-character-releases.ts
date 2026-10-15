import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseCharacterManifest } from '../src/lib/characters.ts'
import { parseCharacterReleaseCatalog } from '../src/lib/characterReleases.ts'

export async function validateCharacterReleases(
  input = fileURLToPath(new URL('../public/data/character-releases.json', import.meta.url)),
  manifestPath = fileURLToPath(new URL('../public/data/characters/index.json', import.meta.url)),
): Promise<{ characters: number; released: number; scheduled: number; unverified: number }> {
  const [rawCatalog, rawManifest] = await Promise.all([readFile(input, 'utf8'), readFile(manifestPath, 'utf8')])
  const manifest = parseCharacterManifest(JSON.parse(rawManifest))
  const catalog = parseCharacterReleaseCatalog(JSON.parse(rawCatalog), manifest)
  return {
    characters: catalog.characters.length,
    released: catalog.characters.filter((character) => character.status === 'released').length,
    scheduled: catalog.characters.filter((character) => character.status === 'scheduled').length,
    unverified: catalog.characters.filter((character) => character.status === 'unverified').length,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await validateCharacterReleases(process.argv[2], process.argv[3])
    console.log(`キャラクター実装日検証完了: ${result.characters}キャラ / 実装済み${result.released}・予定${result.scheduled}・未確認${result.unverified}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
