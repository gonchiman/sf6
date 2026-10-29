import { lstat, readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseMrDistributionDataset, parseMrDistributionManifest } from '../src/lib/mrDistribution.ts'
import { rankDistributionPathWithin, rankDistributionSafeFileName } from './validate-rank-distribution-data.ts'

export const mrDistributionPathWithin = rankDistributionPathWithin
export const mrDistributionSafeFileName = rankDistributionSafeFileName

async function jsonFiles(directory: string, prefix = ''): Promise<string[]> {
  const stat = await lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('MR分布の保存先にリンク等は指定できません。')
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`リンク等の特殊なファイルはMR分布データに含められません: ${prefix}${entry.name}`)
    }
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) paths.push(...await jsonFiles(resolve(directory, entry.name), `${name}/`))
    else if (entry.name.endsWith('.json')) paths.push(name)
    else throw new Error(`MR分布の保存先に管理対象外のファイルがあります: ${name}`)
  }
  return paths
}

export async function validateMrDistributionDirectory(directory: string): Promise<{ datasets: number; entries: number }> {
  const root = resolve(directory)
  const files = await jsonFiles(root)
  const manifest = parseMrDistributionManifest(JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')))
  const expected = new Set(['index.json', ...manifest.datasets.map(descriptor => descriptor.path)])
  for (const path of files) if (!expected.has(path)) throw new Error(`一覧に登録されていないMR分布データがあります: ${path}`)
  let entries = 0
  for (const descriptor of manifest.datasets) {
    const path = resolve(root, descriptor.path)
    if (!mrDistributionSafeFileName(descriptor.path) || !mrDistributionPathWithin(root, path)) {
      throw new Error(`MR分布データの保存先が不正です: ${descriptor.path}`)
    }
    const dataset = parseMrDistributionDataset(JSON.parse(await readFile(path, 'utf8')), descriptor)
    if (dataset.source.url !== manifest.source.url) throw new Error(`MR分布の出典URLが一覧と一致しません: ${descriptor.path}`)
    if (Date.parse(dataset.generatedAt) > Date.parse(manifest.generatedAt)) throw new Error(`データの生成日時が一覧より後です: ${descriptor.path}`)
    entries += dataset.entries.length
  }
  return { datasets: manifest.datasets.length, entries }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../public/data/mr-distribution/', import.meta.url))
  try {
    const result = await validateMrDistributionDirectory(directory)
    console.log(`MR分布データ検証完了: ${result.datasets}データセット / ${result.entries}MR区間`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
