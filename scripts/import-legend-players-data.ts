import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLegendPlayersDataset } from '../src/lib/legendPlayers.ts'
import { createLegendDataPublication } from './import-legend-analysis-data.ts'
import { validateLegendPlayersDirectory } from './validate-legend-players-data.ts'

const publication = createLegendDataPublication({ parseDataset: parseLegendPlayersDataset, validateDirectory: validateLegendPlayersDirectory })
export const importLegendPlayersData = publication.importData
export const publishLegendPlayersData = publication.publishData

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2]
  const output = process.argv[3] ?? fileURLToPath(new URL('../public/data/legend-players/', import.meta.url))
  if (!input || process.argv.length > 4) { console.error('取得完了したプレイヤー一覧JSONまたはフォルダーを指定してください。'); process.exitCode = 1 }
  else importLegendPlayersData(input, output).then(result => {
    console.log(`レジェンド一覧データ取込完了: ${result.datasets}データセット / ${result.entries}掲載エントリー`)
  }).catch(() => { console.error('レジェンド一覧の取り込みに失敗しました。既存データを保持してください。'); process.exitCode = 1 })
}
