import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseRankDistributionDataset, parseRankDistributionManifest } from '../src/lib/rankDistribution.ts'
import type { RankDistributionDataset, RankDistributionManifest } from '../src/types/rankDistribution.ts'
import { rankDistributionPathWithin, rankDistributionSafeFileName, validateRankDistributionDirectory } from './validate-rank-distribution-data.ts'

function code(error: unknown, value: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === value
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (code(error, 'ENOENT')) return false
    throw error
  }
}

async function checkParents(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    if (await exists(current)) {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`ランク分布の保存先が不正です: ${current}`)
    }
    if (current === dirname(current)) return
  }
}

async function readInput(input: string): Promise<RankDistributionDataset[]> {
  const root = resolve(input)
  const stat = await lstat(root)
  if (stat.isSymbolicLink()) throw new Error('ランク分布の入力にリンクは指定できません。')
  if (stat.isDirectory()) {
    const files = await readdir(root, { withFileTypes: true })
    if (files.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json'))) {
      throw new Error('入力フォルダーにはランク分布JSONだけを配置してください。')
    }
    const datasets: RankDistributionDataset[] = []
    for (const file of files.map((entry) => entry.name).filter((name) => name !== 'index.json').sort()) {
      datasets.push(...await readInput(resolve(root, file)))
    }
    return datasets
  }
  if (!stat.isFile()) throw new Error('ランク分布の入力はJSONファイルまたはフォルダーで指定してください。')
  const value: unknown = JSON.parse(await readFile(root, 'utf8'))
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'datasets' in value) {
    if (Object.keys(value).some((key) => !['schemaVersion', 'datasets'].includes(key))
      || !('schemaVersion' in value) || value.schemaVersion !== 1 || !Array.isArray(value.datasets)) {
      throw new Error('ランク分布の入力bundleが不正です。')
    }
    return value.datasets.map((dataset) => parseRankDistributionDataset(dataset))
  }
  return [parseRankDistributionDataset(value)]
}

function descriptors(datasets: RankDistributionDataset[]) {
  return datasets.map(({ id, captureStartedAt, captureEndedAt, totalCount }) => ({ id, captureStartedAt, captureEndedAt, totalCount, path: `${id}.json` }))
}

function captureKey(value: { captureStartedAt: string; captureEndedAt: string }): string {
  return `${Date.parse(value.captureStartedAt)}:${Date.parse(value.captureEndedAt)}`
}

/** Validate the complete batch before staging. Invalid or partial captures never replace a previous result. */
export async function importRankDistributionData(input: string, output: string, generatedAt = new Date().toISOString()): Promise<{ datasets: number; entries: number }> {
  const datasets = await readInput(input)
  if (!datasets.length) throw new Error('取り込む検証済みランク分布データがありません。未取得を0件として取り込みません。')
  const batch = parseRankDistributionManifest({
    schemaVersion: 1, generatedAt, source: { url: datasets[0].source.url, title: datasets[0].source.title }, datasets: descriptors(datasets),
  })
  for (const dataset of datasets) {
    if (dataset.source.url !== batch.source.url) throw new Error('入力のランク分布データは同じ出典URLに揃えてください。')
    if (Date.parse(dataset.generatedAt) > Date.parse(generatedAt)) throw new Error('入力の生成日時が一覧の生成日時より後です。')
    if (!rankDistributionSafeFileName(`${dataset.id}.json`)) throw new Error(`保存できないランク分布IDです: ${dataset.id}`)
  }
  const directory = resolve(output)
  const parent = dirname(directory)
  if (parent === directory) throw new Error('ランク分布の保存先にルートディレクトリは指定できません。')
  await checkParents(directory)
  await mkdir(parent, { recursive: true })
  const lock = resolve(parent, `.${basename(directory)}-import.lock`)
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' }).catch((error) => {
    if (code(error, 'EEXIST')) throw new Error(`ランク分布の取り込みロックが存在します。別の処理の終了を確認してください: ${lock}`)
    throw error
  })
  let work: string | undefined
  let hadOriginal = false
  let movedOriginal = false
  let committed = false
  try {
    hadOriginal = await exists(directory)
    let current: RankDistributionManifest | null = null
    if (hadOriginal && (await readdir(directory)).length > 0) {
      await validateRankDistributionDirectory(directory)
      current = parseRankDistributionManifest(JSON.parse(await readFile(resolve(directory, 'index.json'), 'utf8')))
      if (current.source.url !== batch.source.url) throw new Error('既存ランク分布と取り込みデータの出典URLが異なります。')
      if (Date.parse(current.generatedAt) > Date.parse(generatedAt)) throw new Error('既存の一覧より前の生成日時では公開できません。')
    }
    const selected = new Set(datasets.map(captureKey))
    const next = parseRankDistributionManifest({
      schemaVersion: 1, generatedAt, source: current?.source ?? batch.source,
      datasets: [...(current?.datasets.filter((descriptor) => !selected.has(captureKey(descriptor))) ?? []), ...batch.datasets]
        .sort((a, b) => Date.parse(b.captureEndedAt) - Date.parse(a.captureEndedAt) || a.id.localeCompare(b.id)),
    })
    work = await mkdtemp(resolve(parent, `.${basename(directory)}-import-`))
    if (!rankDistributionPathWithin(parent, work)) throw new Error('ランク分布の作業先が不正です。')
    const stage = resolve(work, 'stage')
    const backup = resolve(work, 'backup')
    if (hadOriginal) await cp(directory, stage, { recursive: true, errorOnExist: true, force: false })
    else await mkdir(stage)
    for (const descriptor of current?.datasets ?? []) {
      if (selected.has(captureKey(descriptor))) {
        const path = resolve(stage, descriptor.path)
        if (!rankDistributionPathWithin(stage, path)) throw new Error('ランク分布の保存先が不正です。')
        await unlink(path)
      }
    }
    for (const dataset of datasets) {
      const path = resolve(stage, `${dataset.id}.json`)
      if (!rankDistributionPathWithin(stage, path)) throw new Error('ランク分布の保存先が不正です。')
      await writeFile(path, `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' })
    }
    await writeFile(resolve(stage, 'index.json'), `${JSON.stringify(next, null, 2)}\n`)
    const result = await validateRankDistributionDirectory(stage)
    if (hadOriginal) { await rename(directory, backup); movedOriginal = true }
    await rename(stage, directory)
    committed = true
    return result
  } catch (error) {
    if (movedOriginal && !committed && work) {
      try { await rename(resolve(work, 'backup'), directory); movedOriginal = false } catch (restoreError) {
        throw new AggregateError([error, restoreError], `ランク分布の復旧に失敗しました。既存データのbackupを保持しています: ${work}`)
      }
    }
    throw error
  } finally {
    if (work && (!movedOriginal || committed) && rankDistributionPathWithin(parent, work)) {
      try { await rm(work, { recursive: true, force: true }) } catch { console.warn(`ランク分布の作業ファイルの後片付けが残っています: ${work}`) }
    }
    try { await unlink(lock) } catch { console.warn(`ランク分布の取り込みロックの後片付けが残っています: ${lock}`) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2]
  const output = process.argv[3] ?? fileURLToPath(new URL('../public/data/rank-distribution/', import.meta.url))
  try {
    if (!input) throw new Error('検証済みランク分布JSONまたはフォルダーを指定してください。')
    const result = await importRankDistributionData(input, output)
    console.log(`ランク分布データ取込完了: ${result.datasets}データセット / ${result.entries}ランク区分`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
