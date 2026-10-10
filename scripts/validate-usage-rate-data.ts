import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseUsageRateDataset, parseUsageRateManifest } from '../src/lib/usageRates.ts'

export function usagePathWithin(directory: string, path: string): boolean {
  const fromRoot = relative(resolve(directory), resolve(path))
  return fromRoot !== '' && !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`)
}

async function jsonFiles(directory: string, prefix = ''): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`リンク等の特殊なファイルは使用率データに含められません: ${prefix}${entry.name}`)
    }
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) paths.push(...await jsonFiles(resolve(directory, entry.name), `${name}/`))
    else if (entry.name.endsWith('.json')) paths.push(name)
    else throw new Error(`使用率データの保存先に管理対象外のファイルがあります: ${name}`)
  }
  return paths
}

export async function validateUsageRateDirectory(directory: string): Promise<{ datasets: number; entries: number }> {
  const root = resolve(directory)
  const manifest = parseUsageRateManifest(JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')))
  const expected = new Set(['index.json', ...manifest.datasets.map((descriptor) => descriptor.path)])
  for (const path of await jsonFiles(root)) {
    if (!expected.has(path)) throw new Error(`一覧に登録されていない使用率データがあります: ${path}`)
  }
  let entries = 0
  for (const descriptor of manifest.datasets) {
    const path = resolve(root, descriptor.path)
    if (!usagePathWithin(root, path)) throw new Error(`使用率データの保存先が不正です: ${descriptor.path}`)
    const dataset = parseUsageRateDataset(JSON.parse(await readFile(path, 'utf8')), descriptor)
    if (dataset.source.url !== manifest.source.url) throw new Error(`使用率の出典URLが一覧と一致しません: ${descriptor.path}`)
    if (Date.parse(dataset.capturedAt) > Date.parse(dataset.generatedAt)) throw new Error(`取得日時がデータ生成日時より後です: ${descriptor.path}`)
    if (Date.parse(dataset.generatedAt) > Date.parse(manifest.generatedAt)) throw new Error(`データの生成日時が一覧より後です: ${descriptor.path}`)
    entries += dataset.distributions.reduce((sum, distribution) => sum + distribution.entries.length, 0)
  }
  return { datasets: manifest.datasets.length, entries }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../public/data/usage-rates/', import.meta.url))
  try {
    const result = await validateUsageRateDirectory(directory)
    console.log(`使用率データ検証完了: ${result.datasets}データセット / ${result.entries}項目`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
