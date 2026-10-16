import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLegendAnalysisDataset, parseLegendAnalysisManifest } from '../src/lib/legendAnalysis.ts'
import { checkLegendAnalysisParents, legendAnalysisFileInfo, legendAnalysisPathWithin, readLegendAnalysisJson } from './lib/legend-analysis-files.ts'

/** An empty manifest is an explicit uncollected state, never an empty successful capture. */
export async function validateLegendAnalysisDirectory(directory: string): Promise<{ datasets: number; entries: number }> {
  const root = resolve(directory)
  await checkLegendAnalysisParents(root)
  if (!(await legendAnalysisFileInfo(root))?.isDirectory()) throw new Error('レジェンド分析の保存先がありません。')
  const files = await readdir(root, { withFileTypes: true })
  if (files.length > 10000 || files.some(file => !file.isFile() || file.isSymbolicLink())) throw new Error('レジェンド分析には通常のJSONファイルだけを配置してください。')
  let bytes = 0
  for (const file of files) {
    const info = await legendAnalysisFileInfo(resolve(root, file.name))
    if (!info?.isFile() || info.isSymbolicLink() || (bytes += info.size) > 64 * 1024 * 1024) throw new Error('レジェンド分析の履歴サイズが上限を超えています。')
  }
  const manifest = parseLegendAnalysisManifest(await readLegendAnalysisJson(resolve(root, 'index.json')))
  const expected = new Set(['index.json', ...manifest.datasets.map(value => value.path)])
  if (files.length !== expected.size || files.some(file => !expected.has(file.name))) throw new Error('レジェンド分析の一覧とファイルが一致しません。')
  let entries = 0
  for (const descriptor of manifest.datasets) {
    const path = resolve(root, descriptor.path)
    if (descriptor.path !== `${descriptor.id}.json` || !legendAnalysisPathWithin(root, path)) throw new Error('レジェンド分析のデータパスが不正です。')
    const dataset = parseLegendAnalysisDataset(await readLegendAnalysisJson(path), descriptor)
    if (dataset.source.url !== manifest.source.url || Date.parse(dataset.generatedAt) > Date.parse(manifest.generatedAt)) throw new Error('レジェンド分析の出典または日時が一覧と一致しません。')
    entries += dataset.totalCount
  }
  return { datasets: manifest.datasets.length, entries }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../public/data/legend-analysis/', import.meta.url))
  validateLegendAnalysisDirectory(directory).then(result => {
    console.log(`レジェンド分析データ検証完了: ${result.datasets}データセット / ${result.entries}掲載エントリー`)
  }).catch(() => { console.error('レジェンド分析データの検証に失敗しました。'); process.exitCode = 1 })
}
