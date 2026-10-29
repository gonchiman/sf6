import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { publishLegendAnalysisData } from './import-legend-analysis-data.ts'
import { legendAnalysisPathWithin } from './lib/legend-analysis-files.ts'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const LOCAL = resolve(ROOT, '.local/legend-analysis-daily')

export function parseLegendAnalysisPublishArguments(args: string[]): { inputDirectory: string; outputDirectory: string } {
  if (args.length !== 4 || args[0] !== '--input-directory' || args[2] !== '--output-directory') throw new Error('引数が不正です。')
  const inputDirectory = resolve(args[1]), outputDirectory = resolve(args[3])
  if (!legendAnalysisPathWithin(LOCAL, inputDirectory) || !legendAnalysisPathWithin(LOCAL, outputDirectory)
    || inputDirectory === outputDirectory || legendAnalysisPathWithin(inputDirectory, outputDirectory)
    || legendAnalysisPathWithin(outputDirectory, inputDirectory)) throw new Error('公開の入出力は独立したレジェンド分析のローカル作業フォルダーを指定してください。')
  return { inputDirectory, outputDirectory }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseLegendAnalysisPublishArguments(process.argv.slice(2))
    await publishLegendAnalysisData(options.inputDirectory, options.outputDirectory)
    console.log('レジェンド分析の集計履歴を反映しました。')
  } catch { console.error('レジェンド分析の履歴反映を完了できませんでした。既存履歴を保持してください。'); process.exitCode = 1 }
}
