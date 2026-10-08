import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseWinRateDataset, parseWinRateManifest } from '../src/lib/winRates.ts'
import { editionOf, WIN_RATE_EDITION_SOURCES } from '../src/lib/winRateConditions.ts'

async function jsonFiles(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) result.push(...await jsonFiles(resolve(directory, entry.name), `${name}/`))
    else if (entry.isFile() && entry.name.endsWith('.json')) result.push(name)
  }
  return result
}

export async function validateWinRateDirectory(directory: string): Promise<{ datasets: number; cells: number }> {
  const root = resolve(directory)
  const manifest = parseWinRateManifest(JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')))
  const expectedPaths = new Set(['index.json', ...manifest.datasets.map((dataset) => dataset.path)])
  const allPaths = await jsonFiles(root)
  for (const path of allPaths) {
    if (!expectedPaths.has(path)) throw new Error(`一覧に登録されていないJSONがあります: ${path}`)
  }
  let cells = 0
  for (const descriptor of manifest.datasets) {
    const path = resolve(root, descriptor.path)
    const fromRoot = relative(root, path)
    if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..') throw new Error(`データの保存先が不正です: ${descriptor.path}`)
    const dataset = parseWinRateDataset(JSON.parse(await readFile(path, 'utf8')), descriptor)
    const expectedSource = editionOf(descriptor) === 'general' ? manifest.source.url : WIN_RATE_EDITION_SOURCES.master.url
    if (dataset.source.url !== expectedSource) throw new Error(`版の出典URLと一致しません: ${descriptor.path}`)
    cells += dataset.rows.reduce((sum, row) => sum + row.cells.length + 1, 0)
  }
  return { datasets: manifest.datasets.length, cells }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../public/data/win-rates/', import.meta.url))
  try {
    const result = await validateWinRateDirectory(directory)
    console.log(`勝率データ検証完了: ${result.datasets}データセット / ${result.cells}セル`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
