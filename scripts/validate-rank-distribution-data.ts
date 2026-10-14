import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseRankDistributionDataset, parseRankDistributionManifest } from '../src/lib/rankDistribution.ts'

export function rankDistributionPathWithin(directory: string, path: string): boolean {
  const fromRoot = relative(resolve(directory), resolve(path))
  return fromRoot !== '' && !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`)
}

export function rankDistributionSafeFileName(value: string): boolean {
  return value.split('/').every((part) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    && !part.endsWith('.') && !part.endsWith(' '))
}

async function jsonFiles(directory: string, prefix = ''): Promise<string[]> {
  const stat = await lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('ランク分布の保存先にリンク等は指定できません。')
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`リンク等の特殊なファイルはランク分布データに含められません: ${prefix}${entry.name}`)
    }
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) paths.push(...await jsonFiles(resolve(directory, entry.name), `${name}/`))
    else if (entry.name.endsWith('.json')) paths.push(name)
    else throw new Error(`ランク分布の保存先に管理対象外のファイルがあります: ${name}`)
  }
  return paths
}

export async function validateRankDistributionDirectory(directory: string): Promise<{ datasets: number; entries: number }> {
  const root = resolve(directory)
  // Check the tree before reading, including index.json itself.
  const files = await jsonFiles(root)
  const manifest = parseRankDistributionManifest(JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')))
  const expected = new Set(['index.json', ...manifest.datasets.map((descriptor) => descriptor.path)])
  for (const path of files) {
    if (!expected.has(path)) throw new Error(`一覧に登録されていないランク分布データがあります: ${path}`)
  }
  let entries = 0
  for (const descriptor of manifest.datasets) {
    const path = resolve(root, descriptor.path)
    if (!rankDistributionSafeFileName(descriptor.path) || !rankDistributionPathWithin(root, path)) {
      throw new Error(`ランク分布データの保存先が不正です: ${descriptor.path}`)
    }
    const dataset = parseRankDistributionDataset(JSON.parse(await readFile(path, 'utf8')), descriptor)
    if (dataset.source.url !== manifest.source.url) throw new Error(`ランク分布の出典URLが一覧と一致しません: ${descriptor.path}`)
    if (Date.parse(dataset.generatedAt) > Date.parse(manifest.generatedAt)) throw new Error(`データの生成日時が一覧より後です: ${descriptor.path}`)
    entries += dataset.entries.length
  }
  return { datasets: manifest.datasets.length, entries }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../public/data/rank-distribution/', import.meta.url))
  try {
    const result = await validateRankDistributionDirectory(directory)
    console.log(`ランク分布データ検証完了: ${result.datasets}データセット / ${result.entries}ランク区分`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
