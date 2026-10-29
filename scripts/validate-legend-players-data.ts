import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLegendPlayersDataset } from '../src/lib/legendPlayers.ts'
import { validateLegendDataDirectory } from './validate-legend-analysis-data.ts'

export function validateLegendPlayersDirectory(directory: string) {
  return validateLegendDataDirectory(directory, parseLegendPlayersDataset)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../public/data/legend-players/', import.meta.url))
  validateLegendPlayersDirectory(directory).then(result => {
    console.log(`レジェンド一覧データ検証完了: ${result.datasets}データセット / ${result.entries}掲載エントリー`)
  }).catch(() => { console.error('レジェンド一覧データの検証に失敗しました。'); process.exitCode = 1 })
}
