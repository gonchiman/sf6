import { lstat, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parsePlayerObservationDataset } from '../src/lib/playerObservations.ts'

export async function validatePlayerObservationDirectory(directory: string): Promise<{ runs: number }> {
  const root = resolve(directory)
  if ((await lstat(root)).isSymbolicLink()) throw new Error('観測データの公開先にリンクは指定できません。')
  const files = await readdir(root, { withFileTypes: true })
  if (files.length !== 1 || files[0].name !== 'index.json' || !files[0].isFile() || files[0].isSymbolicLink()) {
    throw new Error('観測データの公開先には集計済みindex.jsonだけを配置してください。')
  }
  const dataset = parsePlayerObservationDataset(JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')))
  return { runs: dataset.runs.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../public/data/player-observations', import.meta.url))
  try {
    const result = await validatePlayerObservationDirectory(directory)
    console.log(`観測データ検証完了: ${result.runs}走査（集計値のみ）`)
  } catch {
    console.error('観測データの公開形式・取得状態を検証できませんでした。')
    process.exitCode = 1
  }
}
